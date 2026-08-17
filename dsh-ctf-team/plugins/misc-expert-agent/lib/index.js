//#region lib/index.js
/**
 * dsh-misc-expert — 杂项专项专家插件（Misc expert agent plugin）。
 *
 * 认领 planner 派发的 plan.category === "misc" 的子任务
 * （phase ∈ recon / analysis / exploit），按内置离线规则执行：
 *   recon    → 审题、整理输入数据（编码串/隐写文本/附件信息），识别可能题型
 *   analysis → 隐写特征检测（零宽字符/大小写位/首字母）、编码识别
 *   exploit  → 内置求解管线：隐写提取 → 编码解码（Base64/32/Hex/URL/ROT13/
 *              凯撒/摩斯/培根/反转）→ 二进制/十进制/十六进制/八进制 → ASCII
 * 产出经 ctx.blackboard 写入：
 *   clues/<planId>:<taskId>:notes      中间线索（题型识别/隐写发现/破解结论）
 *   tool_outputs/<planId>:<taskId>     求解过程输出
 *   candidate_flags（经 ctx.planner.submitFlag）识别到的 flag → verifier 自动校验
 *   failures/<planId>:<taskId>         求解失败/无输入详情
 * 并通过 ctx.planner.completeTask / failTask 回报子任务状态。
 *
 * 运行约束：
 *   - 离线优先：全部题型识别与求解器固化在本源码，运行阶段不访问 GitHub；
 *   - 硬性依赖 inject: ["blackboard", "planner"]；
 *   - 全部持久化复用 blackboard 服务，禁止直接读写磁盘 JSON 文件。
 *
 * 重启断点恢复：启动时扫描 blackboard 中 category=misc 且任务状态 running
 * 的子任务——本插件曾认领（miscExpert/tasks/<planId>:<taskId> 存在且
 * running）则标记 interrupt（写入 failures）并重新调度执行。
 *
 * @module @dsh-external/dsh-misc-expert
 */
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

/** 默认 misc 专家状态分区名。 */
const DEFAULT_SECTION = "miscExpert";
/** blackboard 分区名规则。 */
const SECTION_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** misc 专家可执行的子任务阶段。 */
const MISC_TASK_PHASES = ["recon", "analysis", "exploit"];

/** 多前缀 flag 提取正则（与 verifier / web-expert / crypto-expert 一致）。 */
const FLAG_EXTRACTION_RE = /(?:ctf|flag|picoctf|htb)\{[^}\s]{1,200}\}/gi;

/** 题型识别关键字表。 */
const MISC_KEYWORDS = [
	{ type: "编码", re: /base64|base32|base ?64|hex|十六进制|url|percent|编码|encode|decode|unicode|html实体|摩斯|morse|培根|bacon/i },
	{ type: "隐写", re: /隐写|stego|零宽|zero.?width|大小写|首字母|acrostic|藏头|LSB|图片隐写/i },
	{ type: "文本转换", re: /二进制|binary|十进制|decimal|ascii|八进制|反转|reverse|倒序|rot/i },
	{ type: "压缩包", re: /压缩包|zip|rar|爆破|密码|archive/i },
	{ type: "图片/音频", re: /图片|png|jpg|音频|wav|波形|频谱/i },
	{ type: "二维码", re: /二维码|qrcode|条形码/i }
];

/** 英文字母频率（百分比，评分用）。 */
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

//#region 工具集（离线）

/** 明文可读性评分：可打印率 + 英文字母频率 + 空格 − 控制字符重罚 + flag 奖励。 */
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
	let score = Math.round((printableRatio * 100) + (alphaRatio * 60) + (spaceRatio * 120) + freqBonus - (control * 80));
	if (FLAG_EXTRACTION_RE.test(text)) score += 50;
	return score;
}

/** 从文本提取 flag。 */
function extractFlags(text) {
	if (typeof text !== "string") return [];
	return [...new Set((text.match(FLAG_EXTRACTION_RE) ?? []).map((m) => m.trim()))];
}

/** ROT13。 */
function rot13(text) {
	return text.replace(/[a-zA-Z]/g, (ch) => {
		const base = ch <= "Z" ? 65 : 97;
		return String.fromCharCode(((ch.charCodeAt(0) - base + 13) % 26) + base);
	});
}

/** 凯撒爆破（topN）。 */
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

/** 培根密码表（24 字母版，i/j、u/v 合并）。 */
const BACON = {
	"aaaaa": "a", "aaaab": "b", "aaaba": "c", "aaabb": "d", "aabaa": "e",
	"aabab": "f", "aabba": "g", "aabbb": "h", "abaaa": "i", "abaab": "k",
	"ababa": "l", "ababb": "m", "abbaa": "n", "abbab": "o", "abbba": "p",
	"abbbb": "q", "baaaa": "r", "baaab": "s", "baaba": "t", "baabb": "u",
	"babaa": "w", "babab": "x", "babba": "y", "babbb": "z"
};

/** 培根解码（a/b 或 A/B 组合）。 */
function baconDecode(text) {
	const cleaned = text.replace(/[^abAB]/g, "");
	if (cleaned.length < 5) return null;
	let out = "";
	for (let i = 0; i + 5 <= cleaned.length; i += 5) {
		const code = cleaned.slice(i, i + 5).toLowerCase();
		const letter = BACON[code];
		if (!letter) return null;
		out += letter;
	}
	return out.length >= 2 ? out : null;
}

/** Base32（RFC 4648）解码：A-Z2-7，容忍空白与尾部 =。失败返回 null。 */
function base32Decode(text) {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	const cleaned = String(text).replace(/=+$/g, "").replace(/\s+/g, "").toUpperCase();
	if (cleaned.length < 4) return null;
	let bits = 0;
	let value = 0;
	const bytes = [];
	for (const ch of cleaned) {
		const idx = alphabet.indexOf(ch);
		if (idx < 0) return null;
		value = (value << 5) | idx;
		bits += 5;
		if (bits >= 8) {
			bytes.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return bytes.length ? Buffer.from(bytes) : null;
}

/** 零宽字符隐写提取（U+200B=0, U+200C=1；U+200D/FEFF 视为分隔忽略）。 */
function extractZeroWidth(text) {
	let bits = "";
	for (const ch of text) {
		if (ch === "\u200b") bits += "0";
		else if (ch === "\u200c") bits += "1";
	}
	if (bits.length < 8) return null;
	const chars = [];
	for (let i = 0; i + 8 <= bits.length; i += 8) {
		const byte = parseInt(bits.slice(i, i + 8), 2);
		if (byte === 0) break;
		chars.push(String.fromCharCode(byte));
	}
	const out = chars.join("");
	return out.length >= 2 && !out.includes("\uFFFD") ? out : null;
}

/** 大小写位隐写提取（大写=1, 小写=0，每 8 位一组）。 */
function extractCaseBits(text) {
	let bits = "";
	for (const ch of text) {
		if (/[A-Z]/.test(ch)) bits += "1";
		else if (/[a-z]/.test(ch)) bits += "0";
	}
	if (bits.length < 8) return null;
	const chars = [];
	for (let i = 0; i + 8 <= bits.length; i += 8) {
		const byte = parseInt(bits.slice(i, i + 8), 2);
		if (byte === 0) break;
		chars.push(String.fromCharCode(byte));
	}
	const out = chars.join("");
	return out.length >= 2 && !out.includes("\uFFFD") ? out : null;
}

/** 首字母提取（藏头）：按行首字母与单词首字母两种。 */
function extractAcrostic(text) {
	const out = [];
	const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
	if (lines.length >= 2) out.push(lines.map((l) => l[0]).join(""));
	const words = text.split(/\s+/).filter(Boolean);
	if (words.length >= 3) out.push(words.map((w) => w[0]).join(""));
	return out.filter((s) => s.length >= 2);
}

/** 二进制串 → 文本。 */
function binaryToText(text) {
	const bits = text.replace(/[^01]/g, "");
	if (bits.length < 8) return null;
	const chars = [];
	for (let i = 0; i + 8 <= bits.length; i += 8) {
		const byte = parseInt(bits.slice(i, i + 8), 2);
		if (byte === 0) break;
		chars.push(String.fromCharCode(byte));
	}
	const out = chars.join("");
	return out.length >= 2 && !out.includes("\uFFFD") ? out : null;
}

/** 数字列表 → ASCII（十进制；也尝试十六进制与八进制，返回全部候选）。 */
function numbersToText(text) {
	const candidates = [];
	// 十进制（1-3 位数字，空格/逗号/换行分隔）
	const decNums = text.match(/\b(\d{1,3})\b/g);
	if (decNums && decNums.length >= 2 && decNums.every((n) => parseInt(n, 10) <= 127)) {
		candidates.push({ kind: "decimal", text: decNums.map((n) => String.fromCharCode(parseInt(n, 10))).join("") });
	}
	// 十六进制（2 位）
	const hexNums = text.match(/\b([0-9a-fA-F]{2})\b/g);
	if (hexNums && hexNums.length >= 2) {
		candidates.push({ kind: "hex", text: hexNums.map((n) => String.fromCharCode(parseInt(n, 16))).join("") });
	}
	// 八进制（3 位，0-7）
	const octNums = text.match(/\b([0-7]{3})\b/g);
	if (octNums && octNums.length >= 2) {
		candidates.push({ kind: "octal", text: octNums.map((n) => String.fromCharCode(parseInt(n, 8))).join("") });
	}
	return candidates;
}

/** 常见编码解码候选。 */
function tryCommonDecode(raw) {
	const results = [];
	const push = (kind, text) => {
		if (typeof text === "string" && text.length > 0) results.push({ kind, text, score: scoreText(text) });
	};
	try {
		const cleaned = raw.replace(/\s+/g, "");
		if (/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned) && cleaned.length % 4 === 0) {
			push("base64", Buffer.from(cleaned, "base64").toString("utf8"));
		}
	} catch { /* 忽略 */ }
	try {
		const cleaned = raw.replace(/\s+/g, "").replace(/^0x/i, "");
		if (/^[0-9a-fA-F]+$/.test(cleaned) && cleaned.length % 2 === 0 && cleaned.length > 4) {
			push("hex", Buffer.from(cleaned, "hex").toString("utf8"));
		}
	} catch { /* 忽略 */ }
	try {
		const cleaned = raw.replace(/\s+/g, "").replace(/=+$/g, "");
		if (/^[A-Z2-7]+$/.test(cleaned) && cleaned.length >= 8) {
			const dec = base32Decode(cleaned);
			if (dec) push("base32", dec.toString("utf8"));
		}
	} catch { /* 忽略 */ }
	try {
		if (/%[0-9a-fA-F]{2}/.test(raw)) push("url", decodeURIComponent(raw));
	} catch { /* 忽略 */ }
	try {
		if (/\\u[0-9a-fA-F]{4}/.test(raw)) push("unicode", raw.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
	} catch { /* 忽略 */ }
	if (/[a-zA-Z]/.test(raw)) push("rot13", rot13(raw));
	return results;
}

/** 从描述/输入中提取候选数据串（hex/base64/二进制/数字列表）。 */
function extractDataCandidates(text) {
	const out = [];
	const hex = text.match(/\b[0-9a-fA-F]{16,}\b/g);
	if (hex) out.push(...hex);
	const b64 = text.match(/\b[A-Za-z0-9+/]{12,}={0,2}\b/g);
	if (b64) out.push(...b64);
	const binary = text.match(/\b[01]{24,}\b/g);
	if (binary) out.push(...binary);
	const nums = text.match(/\b(\d{1,3}[,\s]+){3,}\d{1,3}\b/g);
	if (nums) out.push(...nums);
	return [...new Set(out)].slice(0, 8);
}

//#endregion

/**
 * Misc 专家服务。注册为 `ctx.miscExpert`。
 * 硬性依赖 inject: ["blackboard", "planner"]。
 */
class MiscExpertService extends Service {
	/** 服务名。 */
	static provide = "miscExpert";
	/** 必需服务。 */
	static inject = ["blackboard", "planner"];
	/** 插件配置 schema。 */
	static Config = z.object({
		section: z.string().default(DEFAULT_SECTION),
		autoClaim: z.boolean().default(true),
		resumeOnStart: z.boolean().default(true),
		maxInputBytes: z.number().min(1024).default(65536),
		caesarTop: z.number().min(1).default(3)
	});

	/** 已校验配置。 */
	config;
	/** miscExpert 分区名。 */
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
		super(ctx, "miscExpert");
		this.config = config;
		if (!SECTION_RE.test(config.section)) {
			throw new TypeError(`miscExpert: invalid blackboard section ${JSON.stringify(config.section)}`);
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
		this.ctx.on("misc-expert/execute-task", (payload) => {
			this.executeTask(payload).catch((error) => this._handleError("misc-expert/execute-task", error));
		});
		this.ctx.on("misc-expert/cancel-task", (payload) => {
			this.cancelTask(payload?.planId, payload?.taskId).catch((error) => this._handleError("misc-expert/cancel-task", error));
		});
		if (this.config.autoClaim) {
			this.ctx.on("planner/task-update", (payload) => {
				if (payload?.status !== "running") return;
				this._maybeClaim(payload.planId, payload.taskId).catch((error) => this._handleError(`claim ${payload.planId}/${payload.taskId}`, error));
			});
		}
		await this.blackboard.waitReady();
		if (this.config.resumeOnStart) await this._resumeInterrupted();
		this.ctx.logger.info("miscExpert: ready (section=%s, autoClaim=%s)", this.section, this.config.autoClaim);
	}

	//#region 服务 API

	/**
	 * 执行一个 misc 子任务。
	 * @param input - `{ planId, task, challenge?, options? }`；challenge 支持
	 *   `{ data, description, attachments }`（data 为待解文本/编码串，优先）。
	 */
	async executeTask(input) {
		await this.blackboard.waitReady();
		const { planId, task, challenge, options } = input ?? {};
		if (!planId || !task?.id) throw new TypeError("miscExpert: executeTask requires { planId, task: { id, ... } }");
		const phase = String(task.phase ?? "").toLowerCase();
		if (!MISC_TASK_PHASES.includes(phase)) {
			throw new TypeError(`miscExpert: 不支持的阶段 ${JSON.stringify(task.phase)}（支持 ${MISC_TASK_PHASES.join("/")}）`);
		}
		const key = this._taskKey(planId, task.id);
		if (this.runningLocal.get(key) === true) return this.getTaskState(planId, task.id);
		this.runningLocal.set(key, false);

		const ctx2 = await this._loadChallengeContext(planId, challenge);
		await this._setTaskState(planId, task.id, {
			planId, taskId: task.id, phase, status: "running",
			title: task.title, progress: "claimed", startedAt: nowIso(), updatedAt: nowIso()
		});
		this.ctx.emit("misc-expert/task-claimed", { planId, taskId: task.id, phase, at: nowIso() });

		try {
			const result = await this._execute(planId, task, ctx2, options ?? {});
			await this._setTaskState(planId, task.id, { status: "done", progress: "done", updatedAt: nowIso(), result });
			if (!this.closed) this.ctx.emit("misc-expert/task-done", { planId, taskId: task.id, phase, result, at: nowIso() });
			try {
				await this.planner.completeTask(planId, task.id, { miscExpert: true, phase, findings: result.findings, plaintext: result.plaintext, flag: result.flag }, { executor: "misc-expert" });
			} catch (error) {
				this.ctx.logger.debug("miscExpert: planner completeTask skipped for %s/%s: %s", planId, task.id, error?.message);
			}
			return result;
		} catch (error) {
			if (error?.code === "CANCELLED") {
				await this._setTaskState(planId, task.id, { status: "cancelled", progress: "cancelled", updatedAt: nowIso() });
				if (!this.closed) this.ctx.emit("misc-expert/task-fail", { planId, taskId: task.id, phase, error: { code: "CANCELLED", message: "任务被取消" }, reason: "cancelled", at: nowIso() });
				return { phase, status: "cancelled", at: nowIso() };
			}
			const failed = await this._handleTaskError(planId, task, phase, error, ctx2);
			throw failed;
		} finally {
			this.runningLocal.delete(key);
		}
	}

	/** 取消一个正在执行的任务（求解步骤间生效）。 */
	async cancelTask(planId, taskId) {
		await this.blackboard.waitReady();
		if (!planId || !taskId) throw new TypeError("miscExpert: cancelTask requires planId and taskId");
		this.runningLocal.set(this._taskKey(planId, taskId), true);
		const state = await this.getTaskState(planId, taskId);
		if (state && state.status === "running") {
			await this._setTaskState(planId, taskId, { status: "cancelled", progress: "cancelled", updatedAt: nowIso() });
			await this.blackboard.append("failures", `${planId}:${taskId}`, {
				planId, taskId, type: "misc-expert-cancelled", message: "任务被取消", at: nowIso()
			});
			if (!this.closed) this.ctx.emit("misc-expert/task-fail", { planId, taskId, phase: state.phase, error: { code: "CANCELLED", message: "任务被取消" }, reason: "cancelled", at: nowIso() });
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

	/** 公开求解入口：对给定数据执行内置求解管线。 */
	async solveData(data, options = {}) {
		await this.blackboard.waitReady();
		return this._solvePipeline(data, options);
	}

	//#endregion

	//#region 认领与派发

	/** planner 把任务置 running 时自动认领（plan.category === "misc" 且阶段匹配）。 */
	async _maybeClaim(planId, taskId) {
		if (this.closed || !this.config.autoClaim) return;
		const plan = await this.planner.getPlan(planId);
		if (!plan || plan.category !== "misc") return;
		const task = plan.tasks?.find((t) => t.id === taskId);
		if (!task) return;
		const phase = String(task.phase ?? "").toLowerCase();
		if (!MISC_TASK_PHASES.includes(phase)) return;
		const state = await this.getTaskState(planId, taskId);
		if (state?.status === "running") return;
		const challenge = await this.blackboard.get("challenges", planId);
		await this.executeTask({ planId, task, challenge: challenge ?? { description: plan.description, attachments: plan.attachments } });
	}

	//#endregion

	//#region 执行引擎

	/** 加载挑战上下文。 */
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

	/** recon：审题、整理输入数据、识别题型。 */
	async _runRecon(planId, task, challenge) {
		const findings = [];
		const text = this._challengeText(challenge);
		if (!text.trim()) {
			throw Object.assign(new Error("未在挑战上下文中找到可分析的数据（data/description）"), { code: "ETEXT" });
		}
		const detected = MISC_KEYWORDS.filter(({ re }) => re.test(text)).map(({ type }) => type);
		if (detected.length) {
			await this._clue(planId, task.id, `题型识别：${[...new Set(detected)].join("、")}`);
			findings.push({ kind: "type", detail: [...new Set(detected)] });
		} else {
			await this._clue(planId, task.id, "题型识别：未命中内置关键字（可能是自定义/混合题型）");
		}
		const data = this._inputData(challenge);
		if (data) {
			await this._clue(planId, task.id, `输入数据：${data.length} 字符（${data.slice(0, 60)}…）`);
			findings.push({ kind: "data", size: data.length });
		}
		const candidates = extractDataCandidates(text);
		if (candidates.length) {
			await this._clue(planId, task.id, `候选数据串：${candidates.length} 个`);
			findings.push({ kind: "candidates", count: candidates.length });
		}
		for (const a of challenge?.attachments ?? []) {
			if (a?.name) await this._clue(planId, task.id, `附件：${a.name}`);
		}
		await this._tool(planId, task.id, `[recon] 文本 ${text.length} 字符，题型 ${detected.length ? [...new Set(detected)].join(",") : "未知"}`);
		return { phase: "recon", status: "done", findings, flag: null };
	}

	/** analysis：隐写特征检测与编码识别。 */
	async _runAnalysis(planId, task, challenge) {
		const findings = [];
		const data = this._inputData(challenge);
		const text = this._challengeText(challenge);
		const zw = extractZeroWidth(data || text);
		if (zw) {
			await this._clue(planId, task.id, `零宽字符隐写：提取 "${zw.slice(0, 60)}"`);
			findings.push({ kind: "stego", detail: "zero-width" });
		}
		const cb = extractCaseBits(data || text);
		if (cb && scoreText(cb) > 60) {
			await this._clue(planId, task.id, `大小写位隐写：提取 "${cb.slice(0, 60)}"`);
			findings.push({ kind: "stego", detail: "case-bits" });
		}
		const acro = extractAcrostic(text);
		for (const a of acro) {
			if (scoreText(a) > 40) {
				await this._clue(planId, task.id, `首字母（藏头）候选：${a.slice(0, 60)}`);
				findings.push({ kind: "stego", detail: "acrostic" });
				break;
			}
		}
		if (findings.length === 0) await this._clue(planId, task.id, "未发现明显隐写特征（编码类题型候选）");
		await this._tool(planId, task.id, `[analysis] 隐写/编码特征：${findings.length} 项`);
		return { phase: "analysis", status: "done", findings, flag: null };
	}

	/** exploit：内置求解管线。 */
	async _runExploit(planId, task, challenge) {
		const findings = [];
		const data = this._inputData(challenge);
		const text = this._challengeText(challenge);
		const candidates = data ? [data, ...extractDataCandidates(text)] : extractDataCandidates(text);
		const deduped = [...new Set(candidates)];
		if (deduped.length === 0) {
			throw Object.assign(new Error("exploit：未找到候选数据（challenge.data / description）"), { code: "ENODATA" });
		}
		await this._emitProgress(planId, task, `exploit: ${deduped.length} 个候选数据`);
		const key = this._taskKey(planId, task.id);
		const abort = () => this.runningLocal.get(key) === true;
		let solved = null;
		for (const cand of deduped) {
			await this._checkCancel(planId, task.id);
			const solution = await this._solvePipeline(cand, { caesarTop: this.config.caesarTop, abort });
			for (const step of solution.steps) {
				await this._tool(planId, task.id, `[${step.kind}] ${cand.slice(0, 24)}${cand.length > 24 ? "…" : ""} -> ${step.summary}`);
				if (step.flag) {
					await this._clue(planId, task.id, `破解命中（${step.kind}）：明文 "${step.text.slice(0, 120)}"`);
					findings.push({ kind: step.kind, plaintext: step.text.slice(0, 200) });
					for (const flag of step.flags) await this.planner.submitFlag(planId, flag, "misc-expert", task.id);
					solved = { plaintext: step.text, flag: step.flags[0], kind: step.kind };
					break;
				}
			}
			if (solved) break;
		}
		if (!solved) {
			throw Object.assign(new Error(`exploit：内置求解管线未解出可读明文（${deduped.length} 个候选）`), { code: "ENOHIT" });
		}
		await this._tool(planId, task.id, `[exploit] 完成：${solved.kind} 解出明文，flag=${solved.flag ?? "无"}`);
		return { phase: "exploit", status: "done", findings, plaintext: solved.plaintext, flag: solved.flag };
	}

	/**
	 * 内置求解管线：隐写提取 → 编码解码 → 文本转换。
	 * 每步 accept：flag 为主判定；无 flag 时要求高可读性且含空格。
	 */
	async _solvePipeline(raw, options = {}) {
		const steps = [];
		let attempts = 0;
		const accept = (kind, text) => {
			if (options.abort?.()) throw Object.assign(new Error("任务被取消"), { code: "CANCELLED" });
			attempts += 1;
			const flags = extractFlags(text);
			const score = scoreText(text);
			const hasSpace = /\s/.test(text.trim());
			const summary = flags.length ? `命中 flag: ${flags[0]}` : `文本 "${text.slice(0, 60).replace(/\s+/g, " ")}"（可读性 ${score}）`;
			steps.push({ kind, text, score, flags, flag: flags[0] ?? null, summary });
			return flags.length > 0 || (score > 150 && hasSpace);
		};
		const input = String(raw ?? "");
		if (!input) return { steps, attempts, solved: false };

		if (options.abort?.()) throw Object.assign(new Error("任务被取消"), { code: "CANCELLED" });

		// 1) 隐写提取
		const zw = extractZeroWidth(input);
		if (zw && accept("zero-width", zw)) return { steps, attempts, solved: true };
		const cb = extractCaseBits(input);
		if (cb && accept("case-bits", cb)) return { steps, attempts, solved: true };
		for (const acro of extractAcrostic(input)) {
			if (accept("acrostic", acro)) return { steps, attempts, solved: true };
		}

		// 2) 常见编码解码
		for (const { kind, text } of tryCommonDecode(input)) {
			if (accept(kind, text)) return { steps, attempts, solved: true };
		}
		if (/[a-zA-Z]/.test(input)) {
			// 凯撒爆破：分片 yield（取消可中断，避免同步循环阻塞事件循环）
			for (let shift = 0; shift < 26; shift++) {
				if (options.abort?.()) throw Object.assign(new Error("任务被取消"), { code: "CANCELLED" });
				await new Promise((resolve) => setImmediate(resolve));
				const shifted = input.replace(/[a-zA-Z]/g, (ch) => {
					const base = ch <= "Z" ? 65 : 97;
					return String.fromCharCode(((ch.charCodeAt(0) - base + shift) % 26) + base);
				});
				if (accept(`caesar+${shift}`, shifted)) return { steps, attempts, solved: true };
			}
		}
		const morse = morseDecode(input);
		if (morse && accept("morse", morse)) return { steps, attempts, solved: true };
		const bacon = baconDecode(input);
		if (bacon && accept("bacon", bacon)) return { steps, attempts, solved: true };

		// 3) 文本转换
		const binary = binaryToText(input);
		if (binary && accept("binary", binary)) return { steps, attempts, solved: true };
		const reversed = [...input].reverse().join("");
		if (accept("reverse", reversed)) return { steps, attempts, solved: true };
		for (const { kind, text } of numbersToText(input)) {
			if (accept(`numbers-${kind}`, text)) return { steps, attempts, solved: true };
		}

		return { steps, attempts, solved: false };
	}

	/** 拼接挑战上下文的全部文本。 */
	_challengeText(challenge) {
		const parts = [];
		const data = this._inputData(challenge);
		if (data) parts.push(data);
		if (challenge?.description) parts.push(challenge.description);
		for (const a of challenge?.attachments ?? []) {
			if (a?.note) parts.push(a.note);
			if (a?.name) parts.push(a.name);
		}
		return parts.join("\n");
	}

	/** 提取候选数据：`data` 优先，其次通用透传字段 `ciphertext`（与 crypto-expert 对齐）。 */
	_inputData(challenge) {
		if (challenge?.data !== void 0) return String(challenge.data);
		if (challenge?.ciphertext !== void 0) return String(challenge.ciphertext);
		return "";
	}

	//#endregion

	//#region 产出与异常

	/** 工具回显 → tool_outputs。 */
	async _tool(planId, taskId, line) {
		await this.blackboard.append("tool_outputs", `${planId}:${taskId}`, { output: line, source: "misc-expert", at: nowIso() });
	}

	/** 中间线索 → clues。 */
	async _clue(planId, taskId, text) {
		await this.blackboard.append("clues", `${planId}:${taskId}:notes`, { clue: text, source: "misc-expert", at: nowIso() });
	}

	/** 任务级失败。 */
	async _handleTaskError(planId, task, phase, error, challenge) {
		const code = error?.code ?? "ERR";
		const message = error?.message ?? String(error);
		await this._tool(planId, task.id, `[fail] ${message}`);
		await this.blackboard.append("failures", `${planId}:${task.id}`, {
			planId, taskId: task.id, type: "misc-expert-error", phase, code, message, at: nowIso()
		});
		await this._setTaskState(planId, task.id, { status: "failed", progress: "failed", updatedAt: nowIso(), error: { code, message } });
		try {
			await this.planner.failTask(planId, task.id, `${code}: ${message}`, { executor: "misc-expert", phase });
		} catch (failErr) {
			this.ctx.logger.debug("miscExpert: planner failTask skipped for %s/%s: %s", planId, task.id, failErr?.message);
		}
		if (!this.closed) this.ctx.emit("misc-expert/task-fail", { planId, taskId: task.id, phase, error: { code, message }, reason: code, at: nowIso() });
		return { phase, status: "failed", error: { code, message }, at: nowIso() };
	}

	/** 任务状态写入 miscExpert/tasks。 */
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
		this.ctx.emit("misc-expert/task-progress", { planId, taskId: task.id, phase: task.phase, step: detail, at: nowIso() });
	}

	_taskKey(planId, taskId) {
		return `tasks/${planId}:${taskId}`;
	}

	_handleError(context, error) {
		this.ctx.logger.error("miscExpert: %s failed: %s", context, error?.message ?? String(error));
		if (!this.closed) this.ctx.emit("misc-expert/error", { context, error, at: nowIso() });
	}

	//#endregion

	//#region 重启断点恢复

	/** 启动扫描恢复（planner 计划 + miscExpert/tasks 兜底）。 */
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
					planId, taskId: task.id, type: "misc-expert-interrupt", phase: task.phase, message: "harness 重启，misc 子任务执行被中断；重新调度", at: nowIso()
				});
				this.ctx.logger.warn("miscExpert: 恢复计划 %s 任务 %s（interrupt → 重调度）", planId, task.id);
			}
			await this.executeTask({ planId, task, challenge }).catch((error) => {
				this._handleError(`resume ${planId}/${task.id}`, error);
			});
			resumed += 1;
		};

		const plans = await this.planner.listPlans();
		for (const plan of plans) {
			if (plan.category !== "misc" || plan.status !== "running") continue;
			for (const task of plan.tasks) {
				if (task.status !== "running") continue;
				const phase = String(task.phase ?? "").toLowerCase();
				if (!MISC_TASK_PHASES.includes(phase)) continue;
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

		if (resumed > 0) this.ctx.logger.info("miscExpert: 重启恢复完成，重新调度 %d 个 misc 子任务", resumed);
	}

	//#endregion
}

export {
	MISC_TASK_PHASES,
	MISC_KEYWORDS,
	MiscExpertService,
	MiscExpertService as default,
	DEFAULT_SECTION,
	FLAG_EXTRACTION_RE,
	baconDecode,
	base32Decode,
	binaryToText,
	caesarBrute,
	extractAcrostic,
	extractCaseBits,
	extractFlags,
	extractZeroWidth,
	morseDecode,
	numbersToText,
	rot13,
	scoreText,
	tryCommonDecode
};
//#endregion
