//#region lib/index.js
/**
 * dsh-verifier — Verifier flag 校验插件 (CTF flag validation agent plugin).
 *
 * Responsibilities:
 *   1. 监听 blackboard 的 candidate_flags 分区新增事件（blackboard/set、
 *      blackboard/update），自动抓取候选 flag；
 *   2. flag 格式校验：默认匹配 CTF{} / flag{}（大小写不敏感），支持
 *      extraPatterns 配置与题目级 flagFormat 自定义格式；过滤垃圾字符串
 *      （空串/超长/含空白控制符/占位符），重复 flag 通过 verifier/seen 哈希
 *      缓存自动去重；
 *   3. 本地模拟校验（mode=mock）+ 预留外部提交接口（mode=external +
 *      ctx.verifier.setSubmitter(fn) / verifier/submit-request 事件）；
 *      校验结果写回 candidate_flags 条目：verified(boolean) + verify_msg；
 *   4. 校验失败与格式错误的 flag 写入 failures 分区；
 *   5. 对接 planner：校验通过 → ctx.planner.completeTask；计划内全部已判定
 *      flag 校验失败 → ctx.planner.failTask（联动 planner/fail）。
 *
 * 硬性依赖：static inject = ["blackboard", "planner"] —— 两个服务都就绪后
 * 本插件才会启动；全部读写只经 ctx.blackboard.* / ctx.planner.* API，禁止
 * 直接操作磁盘文件。
 *
 * 数据（全部位于 blackboard 单 JSON 文件，经写队列原子落盘）：
 *   candidate_flags/<planId>:flag-<ts>     原始候选 flag（planner 写入）
 *     + verified(boolean) + verify_msg + duplicate?（本插件合并写回）
 *   verifier/state                         校验状态/计数
 *   verifier/seen:<sha256(flag)>           去重缓存（首次出现条目/结果）
 *   failures/<planId>:<taskId|verifier>    校验失败/格式错误记录（数组）
 *
 * 重启恢复：插件启动时自动扫描 candidate_flags，对没有 verified 字段的
 * 历史条目补做校验（补上宕机期间遗漏的 flag）。
 *
 * @module @dsh-external/dsh-verifier
 */
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { createHash } from "node:crypto";

/** 默认 planner 独占分区名。 */
const DEFAULT_SECTION = "verifier";
/** blackboard 分区名规则（与 blackboard 插件一致）。 */
const SECTION_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/**
 * 默认接受的 flag 格式：CTF{} / flag{} / picoCTF{} / HTB{}（大小写不敏感，
 * 整串匹配）。参考 NUSGreyhats/ctf-agent-workstation 的 ctfgrep 预检默认前缀
 * （flag{ / ctf{ / picoCTF{ / HTB{）。
 */
const DEFAULT_FLAG_PATTERN = /^(?:ctf|flag|picoctf|htb)\{[^}\s]{1,200}\}$/i;
/** 常见占位符/垃圾 flag（小写比对，命中即格式失败）。 */
const DEFAULT_BLOCKED_PLACEHOLDERS = [
	"ctf{flag}",
	"flag{flag}",
	"ctf{xxx}",
	"flag{xxx}",
	"ctf{your_flag_here}",
	"flag{your_flag_here}",
	"ctf{placeholder}",
	"ctf{test}",
	"ctf{null}",
	"ctf{example}",
	"flag{example}",
	"ctf{...}",
	"flag{...}",
	"picoctf{flag}",
	"picoctf{xxx}",
	"htb{flag}",
	"htb{xxx}"
];

/** 当前 UTC 时间 ISO-8601。 */
function nowIso() {
	return new Date().toISOString();
}

/** sha256 十六进制（去重缓存键）。 */
function flagHash(flag) {
	return createHash("sha256").update(String(flag), "utf8").digest("hex");
}

/** 普通对象判断。 */
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Verifier 校验服务。注册为 `ctx.verifier`。
 *
 * 硬性依赖：`inject: ["blackboard", "planner"]` —— loader 等待两个服务
 * 都可用后本 fiber 才会启动；缺任一服务则 profile 启动失败（fail-loud）。
 */
class VerifierService extends Service {
	/** 服务名。 */
	static provide = "verifier";
	/** 必需服务（硬性依赖 blackboard + planner）。 */
	static inject = ["blackboard", "planner"];
	/** 插件配置 schema。 */
	static Config = z.object({
		section: z.string().default(DEFAULT_SECTION),
		mode: z.string().default("mock"),
		autoVerify: z.boolean().default(true),
		extraPatterns: z.array(z.string()).default([]),
		mockRejectPattern: z.string().default(""),
		maxFlagLength: z.number().min(1).default(512),
		blockedPlaceholders: z.array(z.string()).default(DEFAULT_BLOCKED_PLACEHOLDERS),
		plannerLink: z.boolean().default(true),
		dedupe: z.boolean().default(true)
	});

	/** 已校验配置。 */
	config;
	/** verifier 分区名。 */
	section;
	/** blackboard 服务（injected）。 */
	blackboard;
	/** planner 服务（injected）。 */
	planner;
	/** 正在校验的 candidate_flags key → 处理 promise（并发去重 + 可等待）。 */
	inflight = new Map();
	/** 外部提交器（mode=external 时使用；可通过 setSubmitter 注册）。 */
	submitter = null;
	/** dispose 标记。 */
	closed = false;

	constructor(ctx, config) {
		super(ctx, "verifier");
		this.config = config;
		if (!SECTION_RE.test(config.section)) {
			throw new TypeError(`verifier: invalid blackboard section ${JSON.stringify(config.section)}`);
		}
		if (config.mode !== "mock" && config.mode !== "external") {
			throw new TypeError(`verifier: mode must be "mock" or "external", got ${JSON.stringify(config.mode)}`);
		}
		this.section = config.section;
		this.blackboard = ctx.blackboard;
		this.planner = ctx.planner;
	}

	/**
	 * 生命周期：注册事件监听（candidate_flags 变更 + verifier/* 命令），
	 * 等 blackboard 就绪后自动扫描历史候选 flag 补校验（重启恢复）。
	 */
	async *[Service.init]() {
		yield async () => {
			this.closed = true;
		};
		this.ctx.on("blackboard/set", (payload) => this._onCandidateFlagsChange(payload));
		this.ctx.on("blackboard/update", (payload) => this._onCandidateFlagsChange(payload));
		this.ctx.on("verifier/run", () => {
			this.verifyAll().catch((error) => this._handleError("verifier/run", error));
		});
		this.ctx.on("verifier/submit-one", (payload) => {
			this.verifyOne(payload).catch((error) => this._handleError("verifier/submit-one", error));
		});
		this.ctx.on("verifier/clear-cache", () => {
			this.clearCache().catch((error) => this._handleError("verifier/clear-cache", error));
		});
		await this.blackboard.waitReady();
		await this._initState();
		if (this.config.autoVerify) {
			const summary = await this.verifyAll();
			this.ctx.logger.info(
				"verifier: ready (section=%s, mode=%s); startup scan: %s",
				this.section,
				this.config.mode,
				JSON.stringify(summary)
			);
		} else {
			this.ctx.logger.info("verifier: ready (section=%s, mode=%s, autoVerify=false)", this.section, this.config.mode);
		}
	}

	//#region 服务 API

	/**
	 * 校验一个候选 flag。
	 * @param input - `{ key }`（candidate_flags 条目键）或 `{ planId, flag }`
	 * （按 flag 查找；不存在则先登记一条再校验）。
	 * @returns VerifyResult。
	 */
	async verifyOne(input) {
		await this.blackboard.waitReady();
		const { key, planId, flag } = input ?? {};
		let targetKey = key;
		let entry;
		if (targetKey) {
			entry = await this.blackboard.get("candidate_flags", targetKey);
		} else if (typeof flag === "string" && flag.length > 0) {
			const pid = planId ?? "";
			const hits = await this.blackboard.search(flag, { caseInsensitive: true, limit: 200 });
			const hit = hits.find((h) => h.section === "candidate_flags" && h.value?.flag === flag && (pid === "" || h.key.startsWith(`${pid}:`)));
			if (hit) {
				targetKey = hit.key;
				entry = hit.value;
			} else {
				// 手工登记一条候选 flag 再校验（写入走 blackboard API）
				targetKey = `${pid || "manual"}:flag-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
				entry = { planId: pid || void 0, flag, source: "verifier-manual", at: nowIso() };
				await this.blackboard.set("candidate_flags", targetKey, entry);
			}
		}
		if (!targetKey || !entry) return { status: "not-found", at: nowIso() };
		return this._verifyEntry(targetKey, entry);
	}

	/** 扫描 candidate_flags，对所有未校验（无 verified 字段）的条目执行校验。 */
	async verifyAll() {
		await this.blackboard.waitReady();
		const keys = await this.blackboard.keys("candidate_flags");
		const summary = { total: 0, verified: 0, failed: 0, formatError: 0, duplicate: 0, pending: 0, already: 0, skipped: 0 };
		for (const key of keys) {
			const entry = await this.blackboard.get("candidate_flags", key);
			if (!entry || !isPlainObject(entry)) {
				summary.skipped += 1;
				continue;
			}
			summary.total += 1;
			if (entry.verified !== void 0 || entry.duplicate === true) {
				summary.already += 1;
				continue;
			}
			const result = await this._verifyEntry(key, entry);
			if (result.status === "verified") summary.verified += 1;
			else if (result.status === "failed") summary.failed += 1;
			else if (result.status === "duplicate") summary.duplicate += 1;
			else if (result.status === "pending") summary.pending += 1;
			else if (result.status === "busy") summary.skipped += 1;
			if (result.formatError) summary.formatError += 1;
		}
		await this._updateState({ lastRunAt: nowIso(), totals: summary });
		this.ctx.emit("verifier/run-done", { ...summary, at: nowIso() });
		return summary;
	}

	/** 已校验通过的 flag 列表（可只查某 plan）。 */
	async getVerifiedFlags(options = {}) {
		await this.blackboard.waitReady();
		const { planId } = options;
		const keys = await this.blackboard.keys("candidate_flags");
		const result = [];
		for (const key of keys) {
			if (planId && !key.startsWith(`${planId}:`)) continue;
			const entry = await this.blackboard.get("candidate_flags", key);
			if (entry && entry.verified === true && entry.duplicate !== true) {
				result.push({ key, planId: entry.planId, flag: entry.flag, taskId: entry.taskId, verify_msg: entry.verify_msg, at: entry.at });
			}
		}
		result.sort((a, b) => String(a.at).localeCompare(String(b.at)));
		return result;
	}

	/**
	 * 注册外部提交器（mode=external 时生效）。
	 * @param fn - `async ({planId, flag, taskId, key, entry}) => { verified, verify_msg? }`；
	 * 抛错视为校验失败。
	 */
	setSubmitter(fn) {
		if (typeof fn !== "function") throw new TypeError("verifier: setSubmitter requires a function");
		this.submitter = fn;
	}

	/** 清空去重缓存与状态计数（后续新 flag 重新开始去重；已校验条目不变）。 */
	async clearCache() {
		await this.blackboard.waitReady();
		const keys = await this.blackboard.keys(this.section);
		let removed = 0;
		for (const key of keys) {
			if (key.startsWith("seen:")) {
				await this.blackboard.delete(this.section, key);
				removed += 1;
			}
		}
		await this.blackboard.set(this.section, "state", { version: 1, clearedAt: nowIso(), totals: { verified: 0, failed: 0, duplicate: 0, formatError: 0, pending: 0 } });
		this.ctx.emit("verifier/cache-cleared", { removed, at: nowIso() });
		return { removed, at: nowIso() };
	}

	/** 读取校验状态（verifier/state）。 */
	async getState() {
		await this.blackboard.waitReady();
		return this.blackboard.get(this.section, "state");
	}

	//#endregion

	//#region 事件驱动抓取

	/** candidate_flags 分区写入事件：新条目自动抓取并校验（受 autoVerify 开关控制）。 */
	async _onCandidateFlagsChange(payload) {
		if (this.closed || !this.config.autoVerify) return;
		const { section, key, value } = payload ?? {};
		if (section !== "candidate_flags" || !key) return;
		if (!isPlainObject(value)) return;
		// 已有 verified 字段 = 本插件或其他方已处理 → 跳过（防自触发死循环）
		if (value.verified !== void 0) return;
		try {
			await this._verifyEntry(key, value);
		} catch (error) {
			this._handleError(`candidate_flags ${key}`, error);
		}
	}

	//#endregion

	//#region 核心校验

	/**
	 * 校验单条候选 flag 条目（幂等 + 并发合并：同一 key 的并发调用共享同一
	 * 处理 promise，调用方 await 后必然拿到最终写入结果）。
	 */
	async _verifyEntry(key, entry) {
		await this.blackboard.waitReady();
		const existing = this.inflight.get(key);
		if (existing) return existing;
		const promise = (async () => {
			const fresh = await this.blackboard.get("candidate_flags", key);
			if (!fresh) return { status: "not-found", key, at: nowIso() };
			if (fresh.verified !== void 0 || fresh.duplicate === true) {
				return { status: "already", key, planId: fresh.planId, flag: fresh.flag, verified: fresh.verified, verify_msg: fresh.verify_msg, at: nowIso() };
			}
			return this._processEntry(key, fresh);
		})().finally(() => this.inflight.delete(key));
		this.inflight.set(key, promise);
		return promise;
	}

	/** 单条条目处理：格式校验 → 去重 → 提交 → 写回 → failures/事件/planner 联动。 */
	async _processEntry(key, entry) {
		const { planId, flag, taskId } = entry;
		const format = await this._validateFormat(entry);
		let result;

		if (!format.ok) {
			result = { status: "failed", verified: false, verify_msg: format.reason, formatError: true };
		} else if (this.config.dedupe) {
			const hash = flagHash(flag);
			const seen = await this.blackboard.get(this.section, `seen:${hash}`);
			if (seen && seen.flag === flag) {
				result = {
					status: "duplicate",
					verified: seen.verified === true,
					verify_msg: `重复 flag（首次出现于 ${seen.firstKey}，verified=${seen.verified === true})`,
					duplicate: true,
					firstKey: seen.firstKey
				};
			} else {
				result = await this._submit(entry, key);
				if (result.status !== "pending") {
					await this.blackboard.set(this.section, `seen:${hash}`, {
						flag,
						firstKey: key,
						planId,
						verified: result.verified === true,
						at: nowIso()
					});
				}
			}
		} else {
			result = await this._submit(entry, key);
			if (result.status !== "pending") {
				await this.blackboard.set(this.section, `seen:${flagHash(flag)}`, {
					flag,
					firstKey: key,
					planId,
					verified: result.verified === true,
					at: nowIso()
				});
			}
		}

		// 写回 candidate_flags 条目：verified + verify_msg（+ duplicate 标记）
		const patch = { verified: result.verified === true, verify_msg: result.verify_msg };
		if (result.duplicate) patch.duplicate = true;
		if (result.status === "pending") patch.pending = true;
		await this.blackboard.update("candidate_flags", key, patch);

		// 失败/格式错误 → failures 分区
		if (result.status === "failed") {
			await this.blackboard.append("failures", `${planId ?? "unknown"}:${taskId ?? "verifier"}`, {
				planId,
				taskId,
				key,
				flag,
				type: result.formatError ? "verifier-format" : "verifier-reject",
				message: result.verify_msg,
				at: nowIso()
			});
		}

		// 事件
		if (result.status === "verified") {
			this.ctx.emit("verifier/verified-ok", { planId, key, flag, taskId, verify_msg: result.verify_msg, at: nowIso() });
		} else if (result.status === "failed") {
			this.ctx.emit("verifier/verified-fail", { planId, key, flag, taskId, reason: result.verify_msg, at: nowIso() });
		} else if (result.status === "duplicate") {
			this.ctx.emit("verifier/duplicate-flag", { planId, key, flag, firstKey: result.firstKey, firstVerified: result.verified, at: nowIso() });
		}

		await this._updateState({ lastRunAt: nowIso(), last: { status: result.status, key, flag } });

		// planner 联动
		if (this.config.plannerLink) {
			if (result.status === "verified") await this._linkTaskDone(entry, result);
			else if (result.status === "failed") await this._linkAllFailed(planId);
		}

		return { key, planId, flag, taskId, ...result, at: nowIso() };
	}

	/** 提交：mock 本地模拟 或 external 外部提交器 / submit-request 事件。 */
	async _submit(entry, key) {
		const { planId, flag, taskId } = entry;
		if (this.config.mode === "mock") {
			if (this.config.mockRejectPattern && new RegExp(this.config.mockRejectPattern, "i").test(flag)) {
				return { status: "failed", verified: false, verify_msg: `模拟提交被拒（命中 mockRejectPattern=${JSON.stringify(this.config.mockRejectPattern)}）` };
			}
			return { status: "verified", verified: true, verify_msg: "模拟校验通过（本地 mock，格式合规）" };
		}
		// external 模式
		if (this.submitter) {
			try {
				const out = await this.submitter({ planId, flag, taskId, key, entry });
				const ok = out?.verified === true;
				return {
					status: ok ? "verified" : "failed",
					verified: ok,
					verify_msg: typeof out?.verify_msg === "string" ? out.verify_msg : (ok ? "外部提交器校验通过" : "外部提交器判定失败")
				};
			} catch (error) {
				return { status: "failed", verified: false, verify_msg: `外部提交器异常: ${error?.message ?? String(error)}` };
			}
		}
		// 无提交器：预留接口（事件 + pending 状态，不写 failures）
		this.ctx.emit("verifier/submit-request", { planId, flag, taskId, key, at: nowIso() });
		return { status: "pending", verified: false, verify_msg: "external 模式：等待外部提交器（可注册 setSubmitter 或监听 verifier/submit-request）" };
	}

	/** 格式校验：类型/长度/空白/模式/占位符。 */
	async _validateFormat(entry) {
		const flag = entry?.flag;
		if (typeof flag !== "string" || flag.length === 0) {
			return { ok: false, reason: "flag 为空或非字符串" };
		}
		if (flag.length > this.config.maxFlagLength) {
			return { ok: false, reason: `flag 超长（>${this.config.maxFlagLength} 字符）` };
		}
		if (/\s/.test(flag) || /[\u0000-\u001f\u007f]/.test(flag)) {
			return { ok: false, reason: "flag 含空白或控制字符" };
		}
		const patterns = await this._patterns(entry.planId);
		if (!patterns.some((re) => re.test(flag))) {
			return { ok: false, reason: "格式不匹配（未命中 CTF{} / flag{} 或自定义格式）" };
		}
		const lower = flag.toLowerCase();
		if (this.config.blockedPlaceholders.some((p) => lower === String(p).toLowerCase())) {
			return { ok: false, reason: "疑似占位符/示例 flag" };
		}
		return { ok: true };
	}

	/** 构建接受的格式正则集合：默认 + extraPatterns + 题目级 flagFormat。 */
	async _patterns(planId) {
		const patterns = [DEFAULT_FLAG_PATTERN];
		for (const src of this.config.extraPatterns) {
			try {
				patterns.push(new RegExp(src));
			} catch (error) {
				this.ctx.logger.warn("verifier: invalid extraPattern %s: %s", src, error?.message);
			}
		}
		if (planId) {
			// 题目级自定义格式（challenges/<planId>.flagFormat，字符串正则）
			try {
				const challenge = await this.blackboard.get("challenges", planId);
				if (challenge && typeof challenge.flagFormat === "string" && challenge.flagFormat.length > 0) {
					patterns.push(new RegExp(challenge.flagFormat));
				}
			} catch (error) {
				this.ctx.logger.warn("verifier: challenge flagFormat lookup failed: %s", error?.message);
			}
		}
		return patterns;
	}

	//#endregion

	//#region planner 联动

	/**
	 * 校验通过 → 完成任务（best-effort）。优先完成该计划的 flag 阶段任务
	 * （flag 校验通过 = flag 任务完成，且避免与求解专家 completeTask 的竞态）；
	 * 仅当计划无 flag 阶段任务或 flag 任务已结束时回退到 flag 条目的 taskId。
	 */
	async _linkTaskDone(entry, result) {
		if (!entry?.planId) return;
		let target = entry.taskId;
		try {
			const plan = await this.planner.getPlan(entry.planId);
			const flagTask = plan?.tasks?.find((t) => t.phase === "flag");
			if (flagTask && (flagTask.status === "running" || flagTask.status === "ready")) {
				target = flagTask.id;
			}
		} catch (error) {
			this.ctx.logger.debug("verifier: plan lookup skipped for %s: %s", entry.planId, error?.message);
		}
		if (!target) return;
		try {
			await this.planner.completeTask(entry.planId, target, {
				flag: entry.flag,
				verified: true,
				verify_msg: result.verify_msg
			}, { verifier: true });
			this.ctx.logger.info("verifier: flag %s 校验通过，完成任务 %s/%s", entry.flag, entry.planId, target);
		} catch (error) {
			// 任务已完成/已失败/计划不存在等 → 无需处理，仅记录
			this.ctx.logger.debug("verifier: planner completeTask skipped for %s/%s: %s", entry.planId, target, error?.message);
		}
	}

	/** 计划内所有已判定 flag 校验失败 → 失败 flag 任务（联动 planner/fail）。 */
	async _linkAllFailed(planId) {
		if (!planId) return;
		const keys = (await this.blackboard.keys("candidate_flags")).filter((k) => k.startsWith(`${planId}:`));
		const decided = [];
		for (const key of keys) {
			const entry = await this.blackboard.get("candidate_flags", key);
			if (entry && typeof entry.verified === "boolean" && entry.duplicate !== true) decided.push(entry);
		}
		if (decided.length === 0 || !decided.every((e) => e.verified === false)) return;
		// 取 flag 任务 id：优先条目里的 taskId，否则从计划中找 flag 阶段任务
		let taskId = decided.find((e) => e.taskId)?.taskId;
		if (!taskId) {
			const plan = await this.planner.getPlan(planId);
			taskId = plan?.tasks?.find((t) => t.phase === "flag")?.id;
		}
		if (!taskId) return;
		try {
			await this.planner.failTask(planId, taskId, `所有候选 flag 校验失败（${decided.length} 个）`, { verifier: true });
			this.ctx.logger.warn("verifier: plan %s 全部 flag 校验失败，失败任务 %s", planId, taskId);
		} catch (error) {
			this.ctx.logger.debug("verifier: planner failTask skipped for %s/%s: %s", planId, taskId, error?.message);
		}
	}

	//#endregion

	//#region 状态与工具

	/** 初始化 verifier/state（不存在时创建）。 */
	async _initState() {
		const state = await this.blackboard.get(this.section, "state");
		if (!state) {
			await this.blackboard.set(this.section, "state", {
				version: 1,
				createdAt: nowIso(),
				lastScanAt: nowIso(),
				totals: { verified: 0, failed: 0, duplicate: 0, formatError: 0, pending: 0 }
			});
		}
	}

	/** 合并更新 verifier/state（浅合并 + totals 重置）。 */
	async _updateState(patch) {
		try {
			const state = (await this.blackboard.get(this.section, "state")) ?? { version: 1, totals: { verified: 0, failed: 0, duplicate: 0, formatError: 0, pending: 0 } };
			await this.blackboard.set(this.section, "state", { ...state, ...patch });
		} catch (error) {
			this.ctx.logger.warn("verifier: state update failed: %s", error?.message);
		}
	}

	_handleError(context, error) {
		this.ctx.logger.error("verifier: %s failed: %s", context, error?.message ?? String(error));
		if (!this.closed) this.ctx.emit("verifier/error", { context, error, at: nowIso() });
	}

	//#endregion
}

export {
	DEFAULT_BLOCKED_PLACEHOLDERS,
	DEFAULT_FLAG_PATTERN,
	DEFAULT_SECTION,
	VerifierService,
	VerifierService as default,
	flagHash
};
//#endregion
