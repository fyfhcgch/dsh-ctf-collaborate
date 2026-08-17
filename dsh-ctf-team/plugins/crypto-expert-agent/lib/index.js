//#region lib/index.js
/**
 * dsh-crypto-expert — 密码专项专家插件（Crypto expert agent plugin）。
 *
 * 认领 planner 派发的 plan.category === "crypto" 的子任务
 * （phase ∈ recon / analysis / exploit），按内置离线规则执行：
 *   recon    → 整理题目给出的算法与参数（n/e/c/p/q、密文串），识别算法类型
 *   analysis → 参数规约与弱点识别（低指数/可分解模数/单字节 XOR/凯撒分布…）
 *   exploit  → 内置求解管线：Base64/Hex/URL 解码、ROT13、凯撒爆破、
 *              单/多字节 XOR 爆破、RSA（p/q/e 解密、e=3 低指数、Fermat 分解）
 * 产出经 ctx.blackboard 写入：
 *   clues/<planId>:<taskId>:notes      中间线索（算法识别/弱点/破解结论）
 *   tool_outputs/<planId>:<taskId>     求解过程输出（尝试与结果）
 *   candidate_flags（经 ctx.planner.submitFlag）识别到的 flag → verifier 自动校验
 *   failures/<planId>:<taskId>         求解失败/参数缺失详情
 * 并通过 ctx.planner.completeTask / failTask 回报子任务状态。
 *
 * 运行约束：
 *   - 离线优先：全部算法识别规则与求解器固化在本源码（纯 JS + node:crypto
 *     BigInt），运行阶段不访问 GitHub、不下载远程规则；
 *   - 硬性依赖 inject: ["blackboard", "planner"]；
 *   - 全部持久化复用 blackboard 服务，禁止直接读写磁盘 JSON 文件。
 *
 * 重启断点恢复：启动时扫描 blackboard 中 category=crypto 且任务状态 running
 * 的子任务——本插件曾认领（cryptoExpert/tasks/<planId>:<taskId> 存在且
 * running）则标记 interrupt（写入 failures）并重新调度执行。
 *
 * @module @dsh-external/dsh-crypto-expert
 */
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

/** 默认 crypto 专家状态分区名。 */
const DEFAULT_SECTION = "cryptoExpert";
/** blackboard 分区名规则。 */
const SECTION_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** crypto 专家可执行的子任务阶段。 */
const CRYPTO_TASK_PHASES = ["recon", "analysis", "exploit"];

/** 多前缀 flag 提取正则（与 verifier / web-expert 一致）。 */
const FLAG_EXTRACTION_RE = /(?:ctf|flag|picoctf|htb)\{[^}\s]{1,200}\}/gi;

/** 算法识别关键字表（description / 附件 note 命中即提示）。 */
const ALGORITHM_KEYWORDS = [
	{ algo: "RSA", re: /\brsa\b|公钥|私钥|大整数|模数|\bn\s*[=:]\s*\d|\be\s*[=:]\s*\d/i },
	{ algo: "AES", re: /\baes\b|分组密码|ecb|cbc|块密码|密钥加密/i },
	{ algo: "XOR", re: /\bxor\b|异或|单字节|重复密钥|keystream/i },
	{ algo: "凯撒/ROT", re: /caesar|凯撒|\brot\d*\b|位移|移位|偏移/i },
	{ algo: "维吉尼亚", re: /vigen[eè]re|维吉尼亚|多表替换/i },
	{ algo: "Base64", re: /base64|base ?64/i },
	{ algo: "Hex", re: /\bhex\b|十六进制|0x[0-9a-f]+/i },
	{ algo: "摩斯电码", re: /morse|摩斯|\.-\s*[.\-\/ ]/i },
	{ algo: "培根密码", re: /bacon|培根|ababb/i },
	{ algo: "哈希", re: /\bmd5\b|\bsha[0-9-]*\b|哈希|摘要/i },
	{ algo: "仿射密码", re: /affine|仿射/i },
	{ algo: "栅栏密码", re: /rail|栅栏|fence/i }
];

/** 英文字母频率（百分比，用于评分）。 */
const EN_FREQ = {
	a: 8.17, b: 1.49, c: 2.78, d: 4.25, e: 12.7, f: 2.23, g: 2.02, h: 6.09,
	i: 6.97, j: 0.15, k: 0.77, l: 4.03, m: 2.41, n: 6.75, o: 7.51, p: 1.93,
	q: 0.10, r: 5.99, s: 6.33, t: 9.06, u: 2.76, v: 0.98, w: 2.36, x: 0.15,
	y: 1.97, z: 0.07
};

/** 当前 UTC 时间 ISO-8601。 */
function nowIso() {
	return new Date().toISOString();
}

/** 普通对象判断。 */
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

//#region 数论工具（BigInt，离线）

/** 快速幂取模。 */
function modPow(base, exp, mod) {
	let result = 1n;
	let b = BigInt(base) % BigInt(mod);
	let e = BigInt(exp);
	const m = BigInt(mod);
	while (e > 0n) {
		if (e & 1n) result = (result * b) % m;
		b = (b * b) % m;
		e >>= 1n;
	}
	return result;
}

/** 扩展欧几里得求模逆（无逆返回 null）。 */
function modInverse(a, m) {
	let oldR = ((BigInt(a) % BigInt(m)) + BigInt(m)) % BigInt(m);
	let r = BigInt(m);
	let oldS = 1n;
	let s = 0n;
	while (r !== 0n) {
		const q = oldR / r;
		[oldR, r] = [r, oldR - q * r];
		[oldS, s] = [s, oldS - q * s];
	}
	if (oldR !== 1n) return null;
	return ((oldS % BigInt(m)) + BigInt(m)) % BigInt(m);
}

/** 整数 n 次方根（向下取整）。 */
function integerNthRoot(x, n) {
	x = BigInt(x);
	if (x < 0n) return null;
	if (x === 0n) return 0n;
	let low = 1n;
	let high = 1n;
	const exp = BigInt(n);
	while (high ** exp <= x) high <<= 1n;
	while (low + 1n < high) {
		const mid = (low + high) >> 1n;
		if (mid ** exp <= x) low = mid;
		else high = mid;
	}
	return low;
}

/** 欧拉函数（给定素数因子对）。 */
function phi(p, q) {
	return (BigInt(p) - 1n) * (BigInt(q) - 1n);
}

/** Fermat 分解（p/q 接近时），有限迭代。 */
function fermatFactor(n) {
	n = BigInt(n);
	if (n % 2n === 0n) return [2n, n / 2n];
	let a = integerNthRoot(n, 2) + 1n;
	for (let i = 0; i < 200000; i++) {
		const b2 = a * a - n;
		if (b2 < 0n) return null;
		const b = integerNthRoot(b2, 2);
		if (b * b === b2) return [a - b, a + b];
		a += 1n;
	}
	return null;
}

/** 试除法分解（小整数）。 */
function trialDivide(n) {
	n = BigInt(n);
	if (n < 2n) return null;
	for (let p = 2n; p * p <= n; p += p === 2n ? 1n : 2n) {
		if (n % p === 0n) return [p, n / p];
		if (p > 1000000n) return null;
	}
	return null;
}

/** 字节 ↔ BigInt。 */
function bytesToBigInt(bytes) {
	let v = 0n;
	for (const b of bytes) v = (v << 8n) | BigInt(b);
	return v;
}

function bigIntToBytes(v, minLen = 0) {
	const bytes = [];
	let x = BigInt(v);
	while (x > 0n) {
		bytes.unshift(Number(x & 0xffn));
		x >>= 8n;
	}
	while (bytes.length < minLen) bytes.unshift(0);
	return bytes.length ? bytes : [0];
}

/** 大数十进制字符串 → 16 进制（用于大整数到文本的常见转换）。 */
function bigIntToHex(v) {
	return bigIntToBytes(v).map((b) => b.toString(16).padStart(2, "0")).join("");
}

//#endregion

//#region 编码/经典密码工具（离线）

/** 解码候选：尝试常见编码，返回 [{kind, text, score}]。 */
function tryDecode(raw) {
	const results = [];
	const push = (kind, text) => {
		if (typeof text !== "string" || text.length === 0) return;
		results.push({ kind, text, score: scoreText(text) });
	};
	// Base64（容忍空白）
	try {
		const cleaned = raw.replace(/\s+/g, "");
		if (/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned) && cleaned.length % 4 === 0) {
			const dec = Buffer.from(cleaned, "base64").toString("utf8");
			push("base64", dec);
		}
	} catch { /* 忽略 */ }
	// Hex
	try {
		const cleaned = raw.replace(/\s+/g, "").replace(/^0x/i, "");
		if (/^[0-9a-fA-F]+$/.test(cleaned) && cleaned.length % 2 === 0 && cleaned.length > 4) {
			const dec = Buffer.from(cleaned, "hex").toString("utf8");
			push("hex", dec);
		}
	} catch { /* 忽略 */ }
	// URL 编码
	try {
		if (/%[0-9a-fA-F]{2}/.test(raw)) push("url", decodeURIComponent(raw));
	} catch { /* 忽略 */ }
	return results;
}

/** ROT13。 */
function rot13(text) {
	return text.replace(/[a-zA-Z]/g, (ch) => {
		const base = ch <= "Z" ? 65 : 97;
		return String.fromCharCode(((ch.charCodeAt(0) - base + 13) % 26) + base);
	});
}

/** 凯撒爆破：26 位移，按频率评分，返回降序 topN。 */
function caesarBrute(text, topN = 3) {
	const out = [];
	for (let shift = 0; shift < 26; shift++) {
		const shifted = text.replace(/[a-zA-Z]/g, (ch) => {
			const base = ch <= "Z" ? 65 : 97;
			return String.fromCharCode(((ch.charCodeAt(0) - base + shift) % 26) + base);
		});
		out.push({ shift, text: shifted, score: scoreText(shifted) });
	}
	out.sort((a, b) => b.score - a.score);
	return out.slice(0, topN);
}

/** 摩斯电码表。 */
const MORSE = {
	".-": "a", "-...": "b", "-.-.": "c", "-..": "d", ".": "e", "..-.": "f",
	"--.": "g", "....": "h", "..": "i", ".---": "j", "-.-": "k", ".-..": "l",
	"--": "m", "-.": "n", "---": "o", ".--.": "p", "--.-": "q", ".-.": "r",
	"...": "s", "-": "t", "..-": "u", "...-": "v", ".--": "w", "-..-": "x",
	"-.--": "y", "--..": "z", "-----": "0", ".----": "1", "..---": "2",
	"...--": "3", "....-": "4", ".....": "5", "-....": "6", "--...": "7",
	"---..": "8", "----.": "9"
};

/** 摩斯解码（容忍空格/斜杠分隔）。 */
function morseDecode(text) {
	const cleaned = text.trim().replace(/\s*\/\s*/g, " / ");
	const words = cleaned.split("/").map((w) => w.trim());
	let out = "";
	for (const word of words) {
		const chars = word.split(/\s+/).filter(Boolean);
		for (const c of chars) {
			const letter = MORSE[c];
			if (!letter) return null;
			out += letter;
		}
		out += " ";
	}
	return out.trim();
}

/**
 * 单字节 XOR 爆破：对 0..255 逐个异或，评分 topN（默认 5，flag 候选优先）。
 * 分片异步：每 32 个 key 让出事件循环并检查 abort（取消可中断，避免阻塞调度）。
 */
async function singleByteXor(bytes, topN = 5, abort) {
	const out = [];
	for (let key = 0; key < 256; key++) {
		if ((key & 31) === 0) {
			if (abort?.()) throw Object.assign(new Error("任务被取消"), { code: "CANCELLED" });
			await new Promise((resolve) => setImmediate(resolve));
		}
		const dec = bytes.map((b) => b ^ key);
		const text = Buffer.from(dec).toString("utf8");
		out.push({ key, text, score: scoreText(text) });
	}
	out.sort((a, b) => b.score - a.score);
	return out.slice(0, topN);
}

/** 多字节 XOR：keylen 2..maxKeyLen，每 keylen 逐位频率破解，评分 topN。分片异步可取消。 */
async function multiByteXor(bytes, maxKeyLen = 4, topN = 3, abort) {
	const out = [];
	for (let keylen = 2; keylen <= Math.min(maxKeyLen, bytes.length); keylen++) {
		if (abort?.()) throw Object.assign(new Error("任务被取消"), { code: "CANCELLED" });
		const key = [];
		for (let pos = 0; pos < keylen; pos++) {
			const group = [];
			for (let i = pos; i < bytes.length; i += keylen) group.push(bytes[i]);
			const best = (await singleByteXor(group, 1, abort))[0];
			key.push(best?.key ?? 0);
		}
		const dec = bytes.map((b, i) => b ^ key[i % keylen]);
		const text = Buffer.from(dec).toString("utf8");
		out.push({ keylen, key, text, score: scoreText(text) });
	}
	out.sort((a, b) => b.score - a.score);
	return out.slice(0, topN);
}

/** 明文可读性评分：可打印率 + 英文字母频率 + 空格 − 控制字符重罚。 */
function scoreText(text) {
	if (typeof text !== "string" || text.length === 0) return 0;
	let printable = 0;
	let alpha = 0;
	let space = 0;
	let control = 0;
	let freqScore = 0;
	let letters = 0;
	for (const ch of text) {
		const code = ch.charCodeAt(0);
		if (code >= 32 && code < 127) printable += 1;
		else if (code < 32 && code !== 9 && code !== 10 && code !== 13) control += 1;
		if (/[a-zA-Z]/.test(ch)) {
			alpha += 1;
			letters += 1;
			freqScore += EN_FREQ[ch.toLowerCase()] ?? 0;
		}
		if (ch === " ") space += 1;
	}
	const len = text.length;
	const printableRatio = printable / len;
	const alphaRatio = alpha / len;
	const spaceRatio = space / Math.max(1, len);
	const freqBonus = letters ? (freqScore / letters) * 0.3 : 0;
	// 控制字符重罚：XOR 密文按 hex 解码的乱码（含控制符）评分会显著低于真实明文
	let score = Math.round((printableRatio * 100) + (alphaRatio * 60) + (spaceRatio * 120) + freqBonus - (control * 80));
	// flag 形态奖励：CTF{...}/flag{...} 等（flag 明文通常无空格，单靠可读性分不出）
	if (FLAG_EXTRACTION_RE.test(text)) score += 50;
	return score;
}

/** 从文本中提取 flag（多前缀）。 */
function extractFlags(text) {
	if (typeof text !== "string") return [];
	return [...new Set((text.match(FLAG_EXTRACTION_RE) ?? []).map((m) => m.trim()))];
}

/** 从描述/参数中提取 RSA 参数。 */
function extractRsaParams(text) {
	const params = {};
	for (const name of ["n", "e", "c", "p", "q", "d"]) {
		const m = text.match(new RegExp(`(?:^|[^A-Za-z0-9])${name}\\s*[=:]\\s*(\\d{4,})`, "i"));
		if (m) params[name] = m[1];
	}
	return params;
}

/** 从文本提取候选密文串（长 hex / base64 / 连续字母数字）。 */
function extractCipherCandidates(text) {
	const candidates = [];
	const hex = text.match(/\b[0-9a-fA-F]{16,}\b/g);
	if (hex) candidates.push(...hex);
	const b64 = text.match(/\b[A-Za-z0-9+/]{12,}={0,2}\b/g);
	if (b64) candidates.push(...b64);
	return [...new Set(candidates)].slice(0, 8);
}

//#endregion

/**
 * Crypto 专家服务。注册为 `ctx.cryptoExpert`。
 * 硬性依赖 inject: ["blackboard", "planner"]。
 */
class CryptoExpertService extends Service {
	/** 服务名。 */
	static provide = "cryptoExpert";
	/** 必需服务。 */
	static inject = ["blackboard", "planner"];
	/** 插件配置 schema。 */
	static Config = z.object({
		section: z.string().default(DEFAULT_SECTION),
		autoClaim: z.boolean().default(true),
		resumeOnStart: z.boolean().default(true),
		maxXorKeyLen: z.number().min(2).default(4),
		maxXorBytes: z.number().min(1024).default(65536),
		caesarTop: z.number().min(1).default(3)
	});

	/** 已校验配置。 */
	config;
	/** cryptoExpert 分区名。 */
	section;
	/** blackboard 服务（injected）。 */
	blackboard;
	/** planner 服务（injected）。 */
	planner;
	/** 本进程内正在执行的任务（planId:taskId → 取消标志）。 */
	runningLocal = new Map();
	/** dispose 标记。 */
	closed = false;

	constructor(ctx, config) {
		super(ctx, "cryptoExpert");
		this.config = config;
		if (!SECTION_RE.test(config.section)) {
			throw new TypeError(`cryptoExpert: invalid blackboard section ${JSON.stringify(config.section)}`);
		}
		this.section = config.section;
		this.blackboard = ctx.blackboard;
		this.planner = ctx.planner;
	}

	/**
	 * 生命周期：监听派发/取消/planner 认领事件；等 blackboard 就绪后执行
	 * 重启断点恢复。
	 */
	async *[Service.init]() {
		yield async () => {
			this.closed = true;
			this.runningLocal.clear();
		};
		this.ctx.on("crypto-expert/execute-task", (payload) => {
			this.executeTask(payload).catch((error) => this._handleError("crypto-expert/execute-task", error));
		});
		this.ctx.on("crypto-expert/cancel-task", (payload) => {
			this.cancelTask(payload?.planId, payload?.taskId).catch((error) => this._handleError("crypto-expert/cancel-task", error));
		});
		if (this.config.autoClaim) {
			this.ctx.on("planner/task-update", (payload) => {
				if (payload?.status !== "running") return;
				this._maybeClaim(payload.planId, payload.taskId).catch((error) => this._handleError(`claim ${payload.planId}/${payload.taskId}`, error));
			});
		}
		await this.blackboard.waitReady();
		if (this.config.resumeOnStart) await this._resumeInterrupted();
		this.ctx.logger.info("cryptoExpert: ready (section=%s, autoClaim=%s)", this.section, this.config.autoClaim);
	}

	//#region 服务 API

	/**
	 * 执行一个 crypto 子任务。
	 * @param input - `{ planId, task, challenge?, options? }`；challenge 支持
	 *   `{ description, ciphertext, params, attachments }`（ciphertext/params
	 *   优先，其次从 description 提取）。
	 */
	async executeTask(input) {
		await this.blackboard.waitReady();
		const { planId, task, challenge, options } = input ?? {};
		if (!planId || !task?.id) throw new TypeError("cryptoExpert: executeTask requires { planId, task: { id, ... } }");
		const phase = String(task.phase ?? "").toLowerCase();
		if (!CRYPTO_TASK_PHASES.includes(phase)) {
			throw new TypeError(`cryptoExpert: 不支持的阶段 ${JSON.stringify(task.phase)}（支持 ${CRYPTO_TASK_PHASES.join("/")}）`);
		}
		const key = this._taskKey(planId, task.id);
		if (this.runningLocal.get(key) === true) return this.getTaskState(planId, task.id);
		this.runningLocal.set(key, false);

		const ctx2 = await this._loadChallengeContext(planId, challenge);
		await this._setTaskState(planId, task.id, {
			planId, taskId: task.id, phase, status: "running",
			title: task.title, progress: "claimed", startedAt: nowIso(), updatedAt: nowIso()
		});
		this.ctx.emit("crypto-expert/task-claimed", { planId, taskId: task.id, phase, at: nowIso() });

		try {
			const result = await this._execute(planId, task, ctx2, options ?? {});
			await this._setTaskState(planId, task.id, { status: "done", progress: "done", updatedAt: nowIso(), result });
			if (!this.closed) this.ctx.emit("crypto-expert/task-done", { planId, taskId: task.id, phase, result, at: nowIso() });
			try {
				await this.planner.completeTask(planId, task.id, { cryptoExpert: true, phase, findings: result.findings, plaintext: result.plaintext, flag: result.flag }, { executor: "crypto-expert" });
			} catch (error) {
				this.ctx.logger.debug("cryptoExpert: planner completeTask skipped for %s/%s: %s", planId, task.id, error?.message);
			}
			return result;
		} catch (error) {
			if (error?.code === "CANCELLED") {
				await this._setTaskState(planId, task.id, { status: "cancelled", progress: "cancelled", updatedAt: nowIso() });
				if (!this.closed) this.ctx.emit("crypto-expert/task-fail", { planId, taskId: task.id, phase, error: { code: "CANCELLED", message: "任务被取消" }, reason: "cancelled", at: nowIso() });
				return { phase, status: "cancelled", at: nowIso() };
			}
			const failed = await this._handleTaskError(planId, task, phase, error, ctx2);
			throw failed;
		} finally {
			this.runningLocal.delete(key);
		}
	}

	/** 取消一个正在执行的任务（步骤边界生效）。 */
	async cancelTask(planId, taskId) {
		await this.blackboard.waitReady();
		if (!planId || !taskId) throw new TypeError("cryptoExpert: cancelTask requires planId and taskId");
		this.runningLocal.set(this._taskKey(planId, taskId), true);
		const state = await this.getTaskState(planId, taskId);
		if (state && state.status === "running") {
			await this._setTaskState(planId, taskId, { status: "cancelled", progress: "cancelled", updatedAt: nowIso() });
			await this.blackboard.append("failures", `${planId}:${taskId}`, {
				planId, taskId, type: "crypto-expert-cancelled", message: "任务被取消", at: nowIso()
			});
			if (!this.closed) this.ctx.emit("crypto-expert/task-fail", { planId, taskId, phase: state.phase, error: { code: "CANCELLED", message: "任务被取消" }, reason: "cancelled", at: nowIso() });
		}
		return { planId, taskId, cancelled: true, at: nowIso() };
	}

	/** 读取任务运行状态。 */
	async getTaskState(planId, taskId) {
		await this.blackboard.waitReady();
		return this.blackboard.get(this.section, this._taskKey(planId, taskId));
	}

	/** 列出本插件记录的全部任务状态。 */
	async listTasks() {
		await this.blackboard.waitReady();
		const keys = await this.blackboard.keys(this.section);
		const out = [];
		for (const key of keys) {
			if (!key.startsWith("tasks/")) continue;
			const state = await this.blackboard.get(this.section, key);
			if (state) out.push(state);
		}
		return out;
	}

	/** 公开求解入口：对给定密文/文本执行内置求解管线。 */
	async analyzeText(text, options = {}) {
		await this.blackboard.waitReady();
		return this._solvePipeline(text, options);
	}

	//#endregion

	//#region 认领与派发

	/** planner 把任务置 running 时自动认领（plan.category === "crypto" 且阶段匹配）。 */
	async _maybeClaim(planId, taskId) {
		if (this.closed || !this.config.autoClaim) return;
		const plan = await this.planner.getPlan(planId);
		if (!plan || plan.category !== "crypto") return;
		const task = plan.tasks?.find((t) => t.id === taskId);
		if (!task) return;
		const phase = String(task.phase ?? "").toLowerCase();
		if (!CRYPTO_TASK_PHASES.includes(phase)) return;
		const state = await this.getTaskState(planId, taskId);
		if (state?.status === "running") return;
		const challenge = await this.blackboard.get("challenges", planId);
		await this.executeTask({ planId, task, challenge: challenge ?? { description: plan.description, attachments: plan.attachments } });
	}

	//#endregion

	//#region 执行引擎

	/** 加载挑战上下文：显式优先，其次 challenges/<planId>，最后 planner 计划。 */
	async _loadChallengeContext(planId, explicit) {
		if (isPlainObject(explicit)) return explicit;
		const stored = await this.blackboard.get("challenges", planId);
		if (isPlainObject(stored)) return stored;
		const plan = await this.planner.getPlan(planId);
		return { description: plan?.description ?? "", attachments: plan?.attachments ?? [], category: plan?.category };
	}

	/** 按阶段分发执行。 */
	async _execute(planId, task, challenge, options) {
		const phase = String(task.phase).toLowerCase();
		this._emitProgress(planId, task, `${phase} 开始`);
		if (phase === "recon") return this._runRecon(planId, task, challenge);
		if (phase === "analysis") return this._runAnalysis(planId, task, challenge);
		return this._runExploit(planId, task, challenge);
	}

	/** recon：整理算法与参数，识别算法类型。 */
	async _runRecon(planId, task, challenge) {
		const findings = [];
		const text = this._challengeText(challenge);
		if (!text.trim()) {
			throw Object.assign(new Error("未在挑战上下文中找到可分析的文本（description/ciphertext/params）"), { code: "ETEXT" });
		}
		const detected = ALGORITHM_KEYWORDS.filter(({ re }) => re.test(text)).map(({ algo }) => algo);
		if (detected.length) {
			await this._clue(planId, task.id, `算法识别：${[...new Set(detected)].join("、")}`);
			findings.push({ kind: "algorithm", detail: [...new Set(detected)] });
		} else {
			await this._clue(planId, task.id, "算法识别：未命中内置关键字（可能是自定义/组合算法）");
		}
		const rsa = extractRsaParams(text);
		if (Object.keys(rsa).length) {
			await this._clue(planId, task.id, `RSA 参数：${Object.entries(rsa).map(([k, v]) => `${k}=${String(v).slice(0, 40)}${String(v).length > 40 ? "…" : ""}`).join(" ")}`);
			findings.push({ kind: "params", detail: Object.keys(rsa).map((k) => k).join(",") });
		}
		const ciphers = extractCipherCandidates(text);
		if (ciphers.length) {
			await this._clue(planId, task.id, `候选密文串：${ciphers.length} 个（${ciphers.map((c) => `${c.slice(0, 12)}…`).join(", ")}）`);
			findings.push({ kind: "cipher", count: ciphers.length });
		}
		await this._tool(planId, task.id, `[recon] 文本 ${text.length} 字符，算法 ${detected.length ? [...new Set(detected)].join(",") : "未知"}，RSA 参数 ${Object.keys(rsa).length} 个，密文候选 ${ciphers.length} 个`);
		return { phase: "recon", status: "done", findings, flag: null };
	}

	/** analysis：参数规约与弱点识别。 */
	async _runAnalysis(planId, task, challenge) {
		const findings = [];
		const text = this._challengeText(challenge);
		if (!text.trim()) throw Object.assign(new Error("无输入文本"), { code: "ETEXT" });
		const rsa = extractRsaParams(text);
		if (rsa.n && rsa.e) {
			const n = BigInt(rsa.n);
			const e = BigInt(rsa.e);
			const notes = [];
			if (n < 1000000000000000000000000000000n) notes.push("模数偏小（可试除分解）");
			if (e === 3n) notes.push("低加密指数 e=3（小指数攻击候选）");
			if (rsa.p && rsa.q && rsa.e && rsa.c) notes.push("p/q/e/c 齐全（可直接解密）");
			if (notes.length) {
				await this._clue(planId, task.id, `RSA 弱点：${notes.join("；")}`);
				findings.push({ kind: "weakness", detail: notes });
			}
		}
		const ciphers = extractCipherCandidates(text);
		if (ciphers.length) {
			for (const c of ciphers) {
				const bytes = this._toBytes(c);
				if (!bytes) continue;
				const probe = (await singleByteXor(bytes.slice(0, 64), 1))[0];
				if (probe && probe.score > 60) {
					await this._clue(planId, task.id, `XOR 特征：候选 ${c.slice(0, 12)}… 单字节 XOR 解出可读文本（评分 ${probe.score}，key=0x${probe.key.toString(16)}）`);
					findings.push({ kind: "weakness", detail: ["疑似单字节 XOR"] });
					break;
				}
			}
		}
		const letters = text.match(/[a-zA-Z]/g) ?? [];
		if (letters.length > 20) {
			await this._clue(planId, task.id, `字母分布：连续字母 ${letters.length} 个（凯撒/ROT 爆破候选）`);
			findings.push({ kind: "weakness", detail: ["疑似凯撒/ROT"] });
		}
		await this._tool(planId, task.id, `[analysis] 弱点识别完成：${findings.length} 项`);
		return { phase: "analysis", status: "done", findings, flag: null };
	}

	/** exploit：内置求解管线。 */
	async _runExploit(planId, task, challenge) {
		const findings = [];
		const text = this._challengeText(challenge);
		const ciphers = [
			...(challenge?.ciphertext ? [String(challenge.ciphertext)] : []),
			...(extractCipherCandidates(text))
		];
		const deduped = [...new Set(ciphers)];
		if (deduped.length === 0) {
			throw Object.assign(new Error("exploit：未找到候选密文（challenge.ciphertext / description）"), { code: "ENOCIPHER" });
		}
		await this._emitProgress(planId, task, `exploit: ${deduped.length} 个候选密文`);

		let solved = null;
		let attempts = 0;
		const key = this._taskKey(planId, task.id);
		const abort = () => this.runningLocal.get(key) === true;
		for (const cipher of deduped) {
			await this._checkCancel(planId, task.id);
			const solution = await this._solvePipeline(cipher, {
				rsaParams: extractRsaParams(text),
				maxKeyLen: this.config.maxXorKeyLen,
				maxXorBytes: this.config.maxXorBytes,
				caesarTop: this.config.caesarTop,
				abort
			});
			attempts += solution.attempts;
			for (const step of solution.steps) {
				await this._tool(planId, task.id, `[${step.kind}] ${cipher.slice(0, 24)}${cipher.length > 24 ? "…" : ""} -> ${step.summary}`);
				if (step.flag) {
					await this._clue(planId, task.id, `破解命中（${step.kind}）：明文 "${step.text.slice(0, 120)}"`);
					findings.push({ kind: step.kind, cipher: cipher.slice(0, 40), plaintext: step.text.slice(0, 200) });
					for (const flag of step.flags) await this.planner.submitFlag(planId, flag, "crypto-expert", task.id);
					solved = { plaintext: step.text, flag: step.flags[0], kind: step.kind };
					break;
				}
			}
			if (solved) break;
		}

		if (!solved) {
			throw Object.assign(new Error(`exploit：内置求解管线未解出可读明文（${deduped.length} 个候选，${attempts} 次尝试）`), { code: "ENOHIT" });
		}
		await this._tool(planId, task.id, `[exploit] 完成：${solved.kind} 解出明文，flag=${solved.flag ?? "无"}`);
		return { phase: "exploit", status: "done", findings, plaintext: solved.plaintext, flag: solved.flag, attempts };
	}

	/**
	 * 内置求解管线：Base64/Hex/URL 解码 → ROT13 → 凯撒爆破 → 单字节 XOR →
	 * 多字节 XOR → RSA。每步若解出含 flag 或高可读性文本即命中。
	 */
	async _solvePipeline(raw, options = {}) {
		const steps = [];
		let attempts = 0;
		const accept = (kind, text) => {
			attempts += 1;
			const flags = extractFlags(text);
			const score = scoreText(text);
			const hasSpace = /\s/.test(text.trim());
			const summary = flags.length ? `命中 flag: ${flags[0]}` : `文本 "${text.slice(0, 60).replace(/\s+/g, " ")}"（可读性 ${score}）`;
			steps.push({ kind, text, score, flags, flag: flags[0] ?? null, summary });
			// flag 为主判定；无 flag 时要求高可读性且含空格（过滤无空格纯字母乱码）
			return flags.length > 0 || (score > 150 && hasSpace);
		};

		const input = String(raw ?? "");

		// 1) 常见编码解码 / 经典密码 / XOR（需要输入文本）
		if (input) {
			for (const { kind, text } of tryDecode(input)) {
				if (accept(kind, text)) return { steps, attempts, solved: true };
			}
			if (/[a-zA-Z]/.test(input)) {
				const r13 = rot13(input);
				if (accept("rot13", r13)) return { steps, attempts, solved: true };
				for (const cand of caesarBrute(input, options.caesarTop ?? 3)) {
					if (accept(`caesar+${cand.shift}`, cand.text)) return { steps, attempts, solved: true };
				}
			}
			const bytes = this._toBytes(input);
			if (bytes) {
				if (bytes.length <= (options.maxXorBytes ?? 65536)) {
					for (const cand of await singleByteXor(bytes, 5, options.abort)) {
						if (accept(`xor-single key=0x${cand.key.toString(16)}`, cand.text)) return { steps, attempts, solved: true };
					}
					for (const cand of await multiByteXor(bytes, options.maxKeyLen ?? 4, 3, options.abort)) {
						if (accept(`xor-multi keylen=${cand.keylen}`, cand.text)) return { steps, attempts, solved: true };
					}
				} else {
					steps.push({ kind: "xor-skip", text: "", score: 0, flags: [], flag: null, summary: `密文过长（${bytes.length} 字节 > ${options.maxXorBytes}），跳过 XOR 爆破` });
				}
			}
		}

		// 2) RSA（参数齐全即可，无需输入文本）
		const rsa = options.rsaParams ?? {};
		if (rsa.n && rsa.e && rsa.c) {
			const rsaResult = this._solveRsa(rsa);
			if (rsaResult) {
				attempts += 1;
				steps.push({ kind: "rsa", text: rsaResult.text, score: 100, flags: [], flag: null, summary: `RSA 解密：m=${rsaResult.bigInt}（hex=${rsaResult.hex}）` });
				return { steps, attempts, solved: true };
			}
		}
		return { steps, attempts, solved: false };
	}

	/** RSA 求解：p/q/e 齐全直接解密；否则 e=3 低指数、Fermat/试除分解。 */
	_solveRsa(params) {
		const n = BigInt(params.n);
		const e = BigInt(params.e);
		const c = BigInt(params.c);
		let p = params.p ? BigInt(params.p) : null;
		let q = params.q ? BigInt(params.q) : null;
		let m = null;
		if (p && q) {
			const d = modInverse(e, phi(p, q));
			if (d !== null) m = modPow(c, d, n);
		} else if (e === 3n) {
			const root = integerNthRoot(c, 3);
			if (root !== null && root ** 3n === c) m = root;
		}
		if (m === null) {
			const factors = fermatFactor(n) ?? trialDivide(n);
			if (factors) {
				const d = modInverse(e, phi(factors[0], factors[1]));
				if (d !== null) m = modPow(c, d, n);
			}
		}
		if (m === null) return null;
		const hex = bigIntToHex(m);
		// 数字 → 尝试 ASCII/UTF-8 文本
		let text = "";
		try {
			text = Buffer.from(hex, "hex").toString("utf8");
		} catch {
			text = "";
		}
		if (text.length === 0 || text.includes("\uFFFD")) text = String(m);
		return { bigInt: m.toString(), hex, text };
	}

	/** hex 或 base64 字符串 → 字节（失败返回 null）。 */
	_toBytes(str) {
		const cleaned = String(str ?? "").replace(/\s+/g, "").replace(/^0x/i, "");
		if (/^[0-9a-fA-F]+$/.test(cleaned) && cleaned.length % 2 === 0) {
			return [...Buffer.from(cleaned, "hex")];
		}
		if (/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned) && cleaned.length % 4 === 0 && /[A-Za-z0-9+/]{8,}/.test(cleaned)) {
			return [...Buffer.from(cleaned, "base64")];
		}
		return null;
	}

	/** 拼接挑战上下文的全部文本。 */
	_challengeText(challenge) {
		const parts = [];
		if (challenge?.ciphertext !== void 0) parts.push(`ciphertext=${challenge.ciphertext}`);
		if (challenge?.params !== void 0) parts.push(typeof challenge.params === "string" ? challenge.params : JSON.stringify(challenge.params));
		if (challenge?.description) parts.push(challenge.description);
		for (const a of challenge?.attachments ?? []) {
			if (a?.note) parts.push(a.note);
			if (a?.name) parts.push(a.name);
		}
		return parts.join("\n");
	}

	//#endregion

	//#region 产出与异常

	/** 工具回显 → tool_outputs。 */
	async _tool(planId, taskId, line) {
		await this.blackboard.append("tool_outputs", `${planId}:${taskId}`, { output: line, source: "crypto-expert", at: nowIso() });
	}

	/** 中间线索 → clues。 */
	async _clue(planId, taskId, text) {
		await this.blackboard.append("clues", `${planId}:${taskId}:notes`, { clue: text, source: "crypto-expert", at: nowIso() });
	}

	/** 任务级失败：failures + planner.failTask + task-fail 事件。 */
	async _handleTaskError(planId, task, phase, error, challenge) {
		const code = error?.code ?? "ERR";
		const message = error?.message ?? String(error);
		await this._tool(planId, task.id, `[fail] ${message}`);
		await this.blackboard.append("failures", `${planId}:${task.id}`, {
			planId, taskId: task.id, type: "crypto-expert-error", phase, code, message, at: nowIso()
		});
		await this._setTaskState(planId, task.id, { status: "failed", progress: "failed", updatedAt: nowIso(), error: { code, message } });
		try {
			await this.planner.failTask(planId, task.id, `${code}: ${message}`, { executor: "crypto-expert", phase });
		} catch (failErr) {
			this.ctx.logger.debug("cryptoExpert: planner failTask skipped for %s/%s: %s", planId, task.id, failErr?.message);
		}
		if (!this.closed) this.ctx.emit("crypto-expert/task-fail", { planId, taskId: task.id, phase, error: { code, message }, reason: code, at: nowIso() });
		return { phase, status: "failed", error: { code, message }, at: nowIso() };
	}

	/** 任务状态写入 cryptoExpert/tasks。 */
	async _setTaskState(planId, taskId, patch) {
		const key = this._taskKey(planId, taskId);
		const current = await this.blackboard.get(this.section, key);
		await this.blackboard.set(this.section, key, { ...(current ?? { planId, taskId }), ...patch, updatedAt: nowIso() });
	}

	/** 步骤边界检查取消标志。 */
	async _checkCancel(planId, taskId) {
		if (this.runningLocal.get(this._taskKey(planId, taskId)) === true) {
			throw Object.assign(new Error("任务被取消"), { code: "CANCELLED" });
		}
	}

	_emitProgress(planId, task, detail) {
		if (this.closed) return;
		this.ctx.emit("crypto-expert/task-progress", { planId, taskId: task.id, phase: task.phase, step: detail, at: nowIso() });
	}

	_taskKey(planId, taskId) {
		return `tasks/${planId}:${taskId}`;
	}

	_handleError(context, error) {
		this.ctx.logger.error("cryptoExpert: %s failed: %s", context, error?.message ?? String(error));
		if (!this.closed) this.ctx.emit("crypto-expert/error", { context, error, at: nowIso() });
	}

	//#endregion

	//#region 重启断点恢复

	/** 启动扫描恢复（与 web-expert 同构：planner 计划 + cryptoExpert/tasks 兜底）。 */
	async _resumeInterrupted() {
		const handled = new Set();
		let resumed = 0;
		const resumeTask = async (planId, task, challenge) => {
			if (this.closed) return;
			handled.add(`${planId}:${task.id}`);
			const state = await this.getTaskState(planId, task.id);
			if (state?.status === "running") {
				await this._setTaskState(planId, task.id, { status: "interrupted", progress: "interrupted", updatedAt: nowIso() });
				await this.blackboard.append("failures", `${planId}:${task.id}`, {
					planId, taskId: task.id, type: "crypto-expert-interrupt", phase: task.phase, message: "harness 重启，crypto 子任务执行被中断；重新调度", at: nowIso()
				});
				this.ctx.logger.warn("cryptoExpert: 恢复计划 %s 任务 %s（interrupt → 重调度）", planId, task.id);
			}
			await this.executeTask({ planId, task, challenge }).catch((error) => {
				this._handleError(`resume ${planId}/${task.id}`, error);
			});
			resumed += 1;
		};

		const plans = await this.planner.listPlans();
		for (const plan of plans) {
			if (plan.category !== "crypto" || plan.status !== "running") continue;
			for (const task of plan.tasks) {
				if (task.status !== "running") continue;
				const phase = String(task.phase ?? "").toLowerCase();
				if (!CRYPTO_TASK_PHASES.includes(phase)) continue;
				const challenge = await this.blackboard.get("challenges", plan.planId);
				await resumeTask(plan.planId, task, challenge ?? { description: plan.description, attachments: plan.attachments });
			}
		}

		const states = await this.listTasks();
		for (const st of states) {
			if (st.status !== "running") continue;
			if (handled.has(`${st.planId}:${st.taskId}`)) continue;
			const challenge = await this.blackboard.get("challenges", st.planId);
			await resumeTask(st.planId, { id: st.taskId, phase: st.phase, title: st.title ?? st.phase, description: "" }, challenge);
		}

		if (resumed > 0) this.ctx.logger.info("cryptoExpert: 重启恢复完成，重新调度 %d 个 crypto 子任务", resumed);
	}

	//#endregion
}

export {
	ALGORITHM_KEYWORDS,
	CRYPTO_TASK_PHASES,
	CryptoExpertService,
	CryptoExpertService as default,
	DEFAULT_SECTION,
	FLAG_EXTRACTION_RE,
	caesarBrute,
	extractFlags,
	extractRsaParams,
	fermatFactor,
	modInverse,
	modPow,
	morseDecode,
	multiByteXor,
	rot13,
	singleByteXor,
	scoreText,
	tryDecode
};
//#endregion
