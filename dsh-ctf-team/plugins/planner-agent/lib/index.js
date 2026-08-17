//#region lib/index.js
/**
 * dsh-planner — Planner 总调度 Agent 插件 (CTF master-scheduling agent).
 *
 * Responsibilities (see README.md and lib/types/index.d.ts for the full
 * contract):
 *   - Receives a CTF challenge through the `planner/start` event (challenge
 *     description + attachment info).
 *   - Decomposes the challenge into a CoT-style DAG of subtasks (category
 *     templates: web / pwn / crypto / reverse / forensics / osint / misc).
 *   - Schedules the DAG: ready tasks run when their dependencies are done;
 *     running tasks are watched for timeouts; failures are retried up to
 *     `maxAttempts`; blocked tasks are failed; plans finish with
 *     `planner/done` or `planner/fail`.
 *   - Persists EVERYTHING through the blackboard service (`ctx.blackboard`,
 *     hard dependency declared via `inject: ["blackboard"]`):
 *       challenges/<planId>                     challenge input
 *       planner/current                         latest-plan pointer (resume)
 *       planner/plan:<planId>                   plan + task DAG + statuses
 *       clues/<planId>:<taskId>                 intermediate results
 *       tool_outputs/<planId>:<taskId>          tool output lines (arrays)
 *       failures/<planId>:<taskId>              failure records (arrays)
 *       candidate_flags/<planId>:flag-<ts>      candidate flags
 *     The planner NEVER touches persistent_data files directly — all durable
 *     state lives in the blackboard JSON file, written by the blackboard
 *     service's write queue (atomic temp-file + rename).
 *   - Resume: on plugin start, the current plan is read back from the
 *     blackboard; tasks that were `running` when the harness died are marked
 *     `interrupted` (recorded in failures) and re-scheduled — checkpoint
 *     resume across harness restarts.
 *
 * Execution model:
 *   - `executionMode: "internal"` (default): the plugin runs each task with a
 *     built-in deterministic placeholder executor after `internalDelayMs`,
 *     producing clues/tool_outputs and — for flag-phase tasks — extracting
 *     flag-shaped strings from the challenge description and clues into
 *     candidate_flags. This keeps the plugin self-contained and the pipeline
 *     end-to-end testable.
 *   - `executionMode: "external"`: the planner only schedules; other agent
 *     plugins subscribe to `planner/task-update` and report results through
 *     `ctx.planner.completeTask / failTask / addClue / addToolOutput /
 *     submitFlag`.
 *
 * @module @dsh-external/dsh-planner
 */
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

/** Default planner-owned blackboard section. */
const DEFAULT_SECTION = "planner";
/** Blackboard section-name charset (mirrors the blackboard plugin's rule). */
const SECTION_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** Flag-shaped strings the flag phase looks for (CTF{...} / flag{...}). */
const FLAG_RE = /(?:CTF|flag)\{[^}\s]{1,200}\}/gi;
/** All possible task statuses (state machine). */
const TASK_STATUSES = ["pending", "ready", "running", "done", "failed", "interrupted", "blocked", "cancelled"];
/** All possible plan statuses. */
const PLAN_STATUSES = ["running", "done", "failed", "cancelled", "paused"];

/** Current UTC time as ISO-8601. */
function nowIso() {
	return new Date().toISOString();
}

/** 4-hex random suffix for plan ids. */
function randomSuffix() {
	return Math.random().toString(16).slice(2, 6);
}

/** Detect the challenge category from description + title keywords. */
function detectCategory(text) {
	const t = String(text ?? "").toLowerCase();
	if (/(pwn|栈溢出|堆溢出|堆利用|rop|shellcode|格式化字符串|格式化串|整数溢出|libc|canary|ret2|uaf|堆喷)/.test(t)) return "pwn";
	if (/(web|注入|sql|xss|ssrf|csrf|rce|反序列化|文件上传|目录遍历|jwt|oast|php|node|java|spring|nginx|apache|模板注入|ssti)/.test(t)) return "web";
	if (/(crypto|rsa|aes|des|xor|异或|密码|哈希|hash|md5|sha|ecc|elgamal|分组密码|流密码|模运算|离散对数|维吉尼亚)/.test(t)) return "crypto";
	if (/(reverse|逆向|ghidra|ida|angr|脱壳|upx|混淆|obfuscat|disassem|frida|反编译|\bod\b|x64dbg)/.test(t)) return "reverse";
	if (/(forensic|取证|流量|pcap|内存|镜像|disk|memory|stego|隐写|文件恢复|数据恢复|压缩包|zip|rar|磁盘|注册表|sqlite|磁盘镜像)/.test(t)) return "forensics";
	if (/(osint|社工|情报|geo|定位|用户|社交|元数据|exif|whois|dns|卫星|街景)/.test(t)) return "osint";
	return "misc";
}

/**
 * CoT-style decomposition templates: one DAG per category. Each template
 * entry becomes a task; `dependencies` reference earlier task ids, forming a
 * DAG. The planner executes ready tasks only when every dependency is done.
 */
const DECOMPOSITION_TEMPLATES = {
	web: [
		{ id: "t1", phase: "recon", title: "信息收集：指纹识别与端点枚举", description: "识别目标技术栈/框架/中间件，枚举路由、接口与隐藏端点，记录到 tool_outputs 与 clues。", dependencies: [] },
		{ id: "t2", phase: "recon", title: "信息收集：源码与配置审计", description: "收集并审计源码、配置文件、注释与版本差异，标注可疑输入点。", dependencies: [] },
		{ id: "t3", phase: "analysis", title: "漏洞分析：定位可利用漏洞", description: "结合指纹与源码，定位注入/反序列化/上传/模板注入等可利用点并验证前提条件。", dependencies: ["t1", "t2"] },
		{ id: "t4", phase: "exploit", title: "利用验证：构造并执行利用", description: "编写并运行利用脚本，记录回显/响应到 tool_outputs。", dependencies: ["t3"] },
		{ id: "t5", phase: "flag", title: "Flag 提取：从回显与响应中提取候选 flag", description: "扫描利用回显与 clues，提取 flag 形态字符串写入 candidate_flags。", dependencies: ["t4"] }
	],
	pwn: [
		{ id: "t1", phase: "recon", title: "信息收集：保护机制与运行环境", description: "checksec 记录二进制保护、libc/运行环境，收集样本基本信息。", dependencies: [] },
		{ id: "t2", phase: "analysis", title: "逆向分析：定位漏洞函数", description: "静态+动态定位溢出/格式化串/整数溢出等漏洞点，确认触发路径。", dependencies: ["t1"] },
		{ id: "t3", phase: "exploit", title: "利用开发：构造 ROP/shellcode 并打通", description: "编写利用脚本并调试打通，记录关键偏移与 gadget 到 tool_outputs。", dependencies: ["t2"] },
		{ id: "t4", phase: "flag", title: "Flag 提取：从 shell/回显提取候选 flag", description: "扫描利用输出，提取 flag 形态字符串写入 candidate_flags。", dependencies: ["t3"] }
	],
	crypto: [
		{ id: "t1", phase: "recon", title: "信息收集：梳理题目给出的算法与参数", description: "整理加密算法、密钥/参数/密文/样例，标注来源。", dependencies: [] },
		{ id: "t2", phase: "analysis", title: "密码分析：识别算法弱点或错误用法", description: "分析参数规模、错误用法与已知攻击面，形成破解思路写入 clues。", dependencies: ["t1"] },
		{ id: "t3", phase: "exploit", title: "破解实现：编写求解脚本", description: "实现攻击脚本并还原明文，记录输出到 tool_outputs。", dependencies: ["t2"] },
		{ id: "t4", phase: "flag", title: "Flag 提取：从明文中提取候选 flag", description: "扫描解密结果，提取 flag 形态字符串写入 candidate_flags。", dependencies: ["t3"] }
	],
	reverse: [
		{ id: "t1", phase: "recon", title: "信息收集：样本信息与加壳识别", description: "文件类型、架构、加壳/混淆识别，确定分析路线。", dependencies: [] },
		{ id: "t2", phase: "analysis", title: "静态分析：定位核心校验逻辑", description: "用 IDA/Ghidra 定位校验/加密函数，还原关键算法。", dependencies: ["t1"] },
		{ id: "t3", phase: "exploit", title: "动态验证：调试/keygen/反推输入", description: "动态调试或编写求解脚本，验证还原逻辑。", dependencies: ["t2"] },
		{ id: "t4", phase: "flag", title: "Flag 提取：从算法输出中提取候选 flag", description: "运行求解逻辑，提取 flag 形态字符串写入 candidate_flags。", dependencies: ["t3"] }
	],
	forensics: [
		{ id: "t1", phase: "recon", title: "信息收集：检材类型与结构梳理", description: "识别检材类型（流量包/磁盘/内存/文件），梳理目录与文件结构。", dependencies: [] },
		{ id: "t2", phase: "analysis", title: "深度分析：流量/文件/内存取证", description: "按检材类型做深度分析，标注可疑流量/隐藏文件/进程信息到 clues。", dependencies: ["t1"] },
		{ id: "t3", phase: "exploit", title: "数据提取：还原隐藏数据", description: "提取/还原隐藏数据与加密内容，记录命令与输出到 tool_outputs。", dependencies: ["t2"] },
		{ id: "t4", phase: "flag", title: "Flag 提取：从还原数据中提取候选 flag", description: "扫描还原结果，提取 flag 形态字符串写入 candidate_flags。", dependencies: ["t3"] }
	],
	osint: [
		{ id: "t1", phase: "recon", title: "信息收集：线索整理与来源标注", description: "整理题目给出的全部线索，标注来源与可信度。", dependencies: [] },
		{ id: "t2", phase: "analysis", title: "关联分析：串并线索定位目标", description: "通过搜索/交叉比对定位目标实体，记录推理链到 clues。", dependencies: ["t1"] },
		{ id: "t3", phase: "exploit", title: "答案确定：核实并形成结论", description: "核实答案并形成结论，记录证据到 tool_outputs。", dependencies: ["t2"] },
		{ id: "t4", phase: "flag", title: "Flag 提取：从结论中提取候选 flag", description: "从结论/证据中提取 flag 形态字符串写入 candidate_flags。", dependencies: ["t3"] }
	],
	misc: [
		{ id: "t1", phase: "recon", title: "信息收集：审题与附件探查", description: "审题、探查附件结构与隐藏内容，整理已知信息。", dependencies: [] },
		{ id: "t2", phase: "analysis", title: "思路分析：识别题型与解法", description: "结合已知信息判断题型与可能解法，形成思路写入 clues。", dependencies: ["t1"] },
		{ id: "t3", phase: "exploit", title: "求解实现：按思路执行", description: "按既定思路实现并执行求解步骤，记录输出到 tool_outputs。", dependencies: ["t2"] },
		{ id: "t4", phase: "flag", title: "Flag 提取：从结果中提取候选 flag", description: "扫描求解结果，提取 flag 形态字符串写入 candidate_flags。", dependencies: ["t3"] }
	]
};

/**
 * Planner master-scheduling service. Registered as `ctx.planner`.
 *
 * Hard dependency: `static inject = ["blackboard"]` — the loader keeps this
 * fiber pending until the blackboard service is provided, so a profile boot
 * without @dsh-external/dsh-blackboard fails loud.
 */
class PlannerService extends Service {
	/** Service name registered on the context. */
	static provide = "planner";
	/** Required services (hard dependency on the blackboard service). */
	static inject = ["blackboard"];
	/** Plugin config schema. */
	static Config = z.object({
		section: z.string().default(DEFAULT_SECTION),
		executionMode: z.string().default("internal"),
		internalDelayMs: z.number().min(0).default(400),
		internalFailPattern: z.string().default(""),
		taskTimeoutMs: z.number().min(0).default(300000),
		tickMs: z.number().min(50).default(250),
		maxTasks: z.number().min(1).default(16),
		maxAttempts: z.number().min(1).default(2),
		resumeOnStart: z.boolean().default(true),
		autoRun: z.boolean().default(true)
	});

	/** Validated config. */
	config;
	/** Planner-owned blackboard section name. */
	section;
	/** Blackboard service (injected). */
	blackboard;
	/** Active plan ids (cache for the tick loop; truth lives in blackboard). */
	activePlans = new Set();
	/** Serialized mutation chain for all plan reads-modify-writes. */
	opChain = Promise.resolve();
	/** Tick interval handle (raw timer; cleared on dispose). */
	intervalHandle = null;
	/** True while a tick is in flight (prevents overlap). */
	ticking = false;
	/** Set at dispose: refuse new work and drain pending operations. */
	closed = false;
	/** Pending executor timeouts (raw timers, cleared on dispose). */
	executorTimers = new Set();

	constructor(ctx, config) {
		super(ctx, "planner");
		this.config = config;
		if (!SECTION_RE.test(config.section)) {
			throw new TypeError(`planner: invalid blackboard section ${JSON.stringify(config.section)}`);
		}
		if (config.executionMode !== "internal" && config.executionMode !== "external") {
			throw new TypeError(`planner: executionMode must be "internal" or "external", got ${JSON.stringify(config.executionMode)}`);
		}
		this.section = config.section;
		this.blackboard = ctx.blackboard;
	}

	/**
	 * Lifecycle: register the `planner/start` listener, wait for the blackboard
	 * to be ready, then resume any unfinished plan from the previous session.
	 * The disposer clears timers and drains the mutation chain.
	 */
	async *[Service.init]() {
		yield async () => {
			this.closed = true;
			this._clearInterval();
			for (const timer of this.executorTimers) clearTimeout(timer);
			this.executorTimers.clear();
			await this.opChain;
		};
		this.ctx.on("planner/start", (payload) => {
			this.start(payload).then(() => {}, (error) => {
				this._handleInternalError("planner/start", error);
				if (!this.closed) {
					this.ctx.emit("planner/fail", {
						planId: payload?.planId,
						reason: `invalid start input: ${error?.message ?? String(error)}`,
						failedTasks: [],
						at: nowIso()
					});
				}
			});
		});
		await this.blackboard.waitReady();
		if (this.config.resumeOnStart) await this._resumeFromBlackboard();
		this.ctx.logger.info("planner: ready (section=%s, mode=%s)", this.section, this.config.executionMode);
	}

	//#region public service API

	/**
	 * Start a plan: validate input, decompose into a DAG, persist everything
	 * through the blackboard, emit `planner/started`, and begin scheduling.
	 * @param input - `{ description, title?, attachments?, planId?, meta? }`.
	 * @returns `{ planId, plan }`.
	 */
	async start(input) {
		await this.blackboard.waitReady();
		const plan = this._createPlan(input);
		await this._persistStart(plan);
		if (this.config.autoRun && !this.closed) {
			this.activePlans.add(plan.planId);
			this._ensureInterval();
		}
		this.ctx.emit("planner/started", { planId: plan.planId, plan, at: nowIso() });
		this.ctx.logger.info("planner: plan %s started (%d tasks, category=%s)", plan.planId, plan.tasks.length, plan.category);
		if (this.config.autoRun && !this.closed) await this._tick();
		return { planId: plan.planId, plan: await this.getPlan(plan.planId) };
	}

	/** Read one plan (fresh from the blackboard). */
	async getPlan(planId) {
		await this.blackboard.waitReady();
		return this.blackboard.get(this.section, `plan:${planId}`);
	}

	/** Read the plan currently pointed to by `planner/current`. */
	async getCurrentPlan() {
		await this.blackboard.waitReady();
		const current = await this.blackboard.get(this.section, "current");
		if (!current?.planId) return void 0;
		return this.getPlan(current.planId);
	}

	/** List every persisted plan (newest last). */
	async listPlans() {
		await this.blackboard.waitReady();
		const keys = (await this.blackboard.keys(this.section)).filter((key) => key.startsWith("plan:"));
		const plans = [];
		for (const key of keys) {
			const plan = await this.blackboard.get(this.section, key);
			if (plan) plans.push(plan);
		}
		return plans;
	}

	/**
	 * External-executor hook: report a task as successfully completed.
	 * Writes the result to clues, then transitions the task to `done`.
	 */
	async completeTask(planId, taskId, result, meta = {}) {
		await this.blackboard.waitReady();
		return this._withPlan(planId, async (plan) => {
			const task = this._findTask(plan, taskId);
			if (!task) throw new Error(`planner: task ${taskId} not found in plan ${planId}`);
			if (task.status !== "running" && task.status !== "ready" && task.status !== "interrupted") {
				throw new Error(`planner: cannot complete task ${taskId} in status ${task.status}`);
			}
			await this.blackboard.set("clues", `${planId}:${taskId}`, {
				planId,
				taskId,
				title: task.title,
				result,
				meta,
				at: nowIso()
			});
			task.status = "done";
			task.result = result;
			task.completedAt = nowIso();
			task.updatedAt = nowIso();
			await this._persistPlan(plan);
			this._emitTaskUpdate(plan, task, "done");
			return { planId, taskId, status: "done", at: nowIso() };
		});
	}

	/**
	 * External-executor hook: report a task as failed. The failure is recorded
	 * in the failures section; the task is retried while attempts remain,
	 * otherwise it stays `failed`.
	 */
	async failTask(planId, taskId, error, meta = {}) {
		await this.blackboard.waitReady();
		return this._withPlan(planId, async (plan) => {
			const task = this._findTask(plan, taskId);
			if (!task) throw new Error(`planner: task ${taskId} not found in plan ${planId}`);
			if (task.status !== "running" && task.status !== "ready" && task.status !== "interrupted") {
				throw new Error(`planner: cannot fail task ${taskId} in status ${task.status}`);
			}
			await this._recordFailure(plan, task, {
				type: "executor",
				message: typeof error === "string" ? error : error?.message ?? String(error),
				meta
			});
			return this._handleTaskFailure(plan, task, { type: "executor", message: typeof error === "string" ? error : error?.message ?? String(error) });
		});
	}

	/** Record one intermediate finding into clues/<planId>:<taskId>. */
	async addClue(planId, taskId, clue, meta = {}) {
		await this.blackboard.waitReady();
		return this.blackboard.append("clues", `${planId}:${taskId}:notes`, { clue, meta, at: nowIso() });
	}

	/** Append one tool-output line into tool_outputs/<planId>:<taskId>. */
	async addToolOutput(planId, taskId, output, meta = {}) {
		await this.blackboard.waitReady();
		return this.blackboard.append("tool_outputs", `${planId}:${taskId}`, { output, meta, at: nowIso() });
	}

	/**
	 * Submit one candidate flag into candidate_flags/<planId>:flag-<ts>.
	 * Deduplicated against the plan's existing flags.
	 */
	async submitFlag(planId, flag, source = "planner", taskId) {
		await this.blackboard.waitReady();
		if (typeof flag !== "string" || flag.length === 0) throw new TypeError("planner: flag must be a non-empty string");
		const existing = await this.blackboard.search(flag, { caseInsensitive: true, limit: 100 });
		const already = existing.some((hit) => hit.section === "candidate_flags" && hit.key.startsWith(`${planId}:`) && hit.value?.flag === flag);
		if (already) return { planId, flag, source, taskId, changed: false };
		const key = `${planId}:flag-${Date.now()}-${randomSuffix()}`;
		await this.blackboard.set("candidate_flags", key, { planId, flag, source, taskId, at: nowIso() });
		this.ctx.emit("planner/flag", { planId, flag, source, taskId, at: nowIso() });
		return { planId, flag, source, taskId, changed: true, key };
	}

	/** Cancel a running plan: every non-terminal task becomes `cancelled`. */
	async cancel(planId) {
		await this.blackboard.waitReady();
		return this._withPlan(planId, async (plan) => {
			if (plan.status === "done" || plan.status === "failed" || plan.status === "cancelled") return plan;
			plan.status = "cancelled";
			plan.updatedAt = nowIso();
			for (const task of plan.tasks) {
				if (task.status === "running" || task.status === "ready" || task.status === "pending" || task.status === "interrupted") {
					task.status = "cancelled";
					task.updatedAt = nowIso();
					this._emitTaskUpdate(plan, task, "cancelled");
				}
			}
			this.activePlans.delete(planId);
			await this.blackboard.set(this.section, "current", { planId, status: plan.status, updatedAt: nowIso() });
			await this._persistPlan(plan);
			this.ctx.emit("planner/cancelled", { planId, plan, at: nowIso() });
			return plan;
		});
	}

	/** Reset one failed/blocked task so the scheduler re-runs it. */
	async retryTask(planId, taskId) {
		await this.blackboard.waitReady();
		return this._withPlan(planId, async (plan) => {
			const task = this._findTask(plan, taskId);
			if (!task) throw new Error(`planner: task ${taskId} not found in plan ${planId}`);
			if (task.status !== "failed" && task.status !== "blocked") {
				throw new Error(`planner: retryTask only accepts failed/blocked tasks, got ${task.status}`);
			}
			task.status = "pending";
			task.attempts = 0;
			task.error = void 0;
			task.startedAt = void 0;
			task.updatedAt = nowIso();
			this._emitTaskUpdate(plan, task, "pending", "retry");
			return this._persistPlan(plan);
		});
	}

	//#endregion

	//#region plan construction & persistence

	/** Validate input and build the plan document (no writes yet). */
	_createPlan(input) {
		const { description, title, attachments, planId: explicitId, meta } = input ?? {};
		if (typeof description !== "string" || description.trim().length === 0) {
			throw new TypeError("planner: start requires a non-empty challenge description");
		}
		const planId = explicitId ?? `plan-${Date.now()}-${randomSuffix()}`;
		if (!/^[A-Za-z0-9_-]{1,80}$/.test(planId)) {
			throw new TypeError(`planner: invalid planId ${JSON.stringify(planId)}`);
		}
		// 显式 category 优先（外部可指定），否则按描述关键字检测
		const explicitCategory = typeof input?.category === "string" && input.category.trim().length > 0 ? input.category.trim().toLowerCase() : "";
		const category = explicitCategory || detectCategory(`${title ?? ""}\n${description}`);
		const template = DECOMPOSITION_TEMPLATES[category] ?? DECOMPOSITION_TEMPLATES.misc;
		const tasks = template.slice(0, this.config.maxTasks).map((entry) => ({
			id: entry.id,
			phase: entry.phase,
			title: entry.title,
			description: entry.description,
			status: "pending",
			dependencies: [...entry.dependencies],
			attempts: 0,
			maxAttempts: this.config.maxAttempts,
			timeoutMs: this.config.taskTimeoutMs,
			createdAt: nowIso(),
			updatedAt: nowIso(),
			metadata: {}
		}));
		// 题目上下文透传：调用方传入的额外字段（ciphertext / url / flagFormat 等）
		// 原样写入 challenge 记录，供各专家插件认领时读取（如 cryptoExpert 的
		// challenge.ciphertext）。category 由 planner 判定，不透传覆盖。
		const challengeExtra = {};
		for (const [key, value] of Object.entries(input ?? {})) {
			if (["planId", "title", "description", "attachments", "meta", "category"].includes(key)) continue;
			if (value === void 0) continue;
			challengeExtra[key] = value;
		}
		const at = nowIso();
		const plan = {
			planId,
			title: title ?? `CTF 题目 ${planId}`,
			description,
			attachments: Array.isArray(attachments) ? attachments.map((a) => ({ ...a })) : [],
			category,
			status: "running",
			tasks,
			createdAt: at,
			updatedAt: at,
			startedAt: at,
			meta: { ...(meta ?? {}) },
			challengeExtra
		};
		return plan;
	}

	/** Persist a plan start: challenge record (含透传字段), plan record, current pointer. */
	async _persistStart(plan) {
		await this.blackboard.set("challenges", plan.planId, {
			planId: plan.planId,
			title: plan.title,
			description: plan.description,
			attachments: plan.attachments,
			category: plan.category,
			createdAt: plan.createdAt,
			...plan.challengeExtra
		});
		await this._persistPlan(plan);
		await this.blackboard.set(this.section, "current", { planId: plan.planId, status: plan.status, updatedAt: plan.updatedAt });
	}

	/** Write the plan document into the planner section. */
	async _persistPlan(plan) {
		plan.updatedAt = nowIso();
		await this.blackboard.set(this.section, `plan:${plan.planId}`, plan);
		await this.blackboard.set(this.section, "current", { planId: plan.planId, status: plan.status, updatedAt: plan.updatedAt });
	}

	/** Serialize all plan mutations (read-modify-write) through one chain. */
	_withPlan(planId, fn) {
		const run = this.opChain.then(async () => {
			const plan = await this.blackboard.get(this.section, `plan:${planId}`);
			if (!plan) throw new Error(`planner: plan ${planId} not found in blackboard section ${this.section}`);
			return fn(plan);
		});
		this.opChain = run.then(() => void 0, () => void 0);
		return run;
	}

	//#endregion

	//#region scheduling engine

	/** Start the tick interval when at least one plan is active. */
	_ensureInterval() {
		if (this.intervalHandle !== null || this.closed) return;
		this.intervalHandle = setInterval(() => {
			this._tick().catch((error) => this._handleInternalError("planner tick", error));
		}, this.config.tickMs);
	}

	/** Stop the tick interval when no plan is active. */
	_clearInterval() {
		if (this.intervalHandle !== null) {
			clearInterval(this.intervalHandle);
			this.intervalHandle = null;
		}
	}

	_maybeStopInterval() {
		if (this.activePlans.size === 0) this._clearInterval();
	}

	/** One scheduling pass over every active plan. */
	async _tick() {
		if (this.ticking || this.closed) return;
		this.ticking = true;
		try {
			for (const planId of [...this.activePlans]) {
				try {
					await this._withPlan(planId, async (plan) => {
						if (plan.status !== "running") {
							this.activePlans.delete(planId);
							return;
						}
						await this._advancePlan(plan);
					});
				} catch (error) {
					this._handleInternalError(`plan ${planId} tick`, error);
				}
			}
			this._maybeStopInterval();
		} finally {
			this.ticking = false;
		}
	}

	/** Advance one running plan one step: ready → start → timeout → blocked → done/fail. */
	async _advancePlan(plan) {
		let changed = false;

		// 1. pending/interrupted tasks whose dependencies are all done become
		//    ready (interrupted = in-flight when a previous planner died; the
		//    resume step records them in failures and the scheduler re-runs
		//    them here).
		for (const task of plan.tasks) {
			if (task.status !== "pending" && task.status !== "interrupted") continue;
			if (task.dependencies.every((depId) => {
				const dep = plan.tasks.find((t) => t.id === depId);
				return dep?.status === "done";
			})) {
				task.status = "ready";
				task.updatedAt = nowIso();
				changed = true;
				this._emitTaskUpdate(plan, task, "ready", task.status === "interrupted" ? "rescheduled after interrupt" : void 0);
			}
		}

		// 2. ready tasks start running.
		for (const task of plan.tasks) {
			if (task.status !== "ready") continue;
			task.status = "running";
			task.attempts += 1;
			task.startedAt = nowIso();
			task.updatedAt = nowIso();
			changed = true;
			this._emitTaskUpdate(plan, task, "running");
			if (this.config.executionMode === "internal") this._scheduleInternalExecution(plan.planId, task.id);
		}

		// 2.5 flag 任务收口（external 模式）：flag 阶段任务一旦 running/ready，
		//     且该计划已有 verified=true 的候选 flag（verifier 校验通过），
		//     立即完成 flag 任务 —— 任务-flag 联动闭环，保证计划推进到 done。
		const flagTask = plan.tasks.find((t) => t.phase === "flag" && (t.status === "running" || t.status === "ready"));
		if (flagTask) {
			const flagKeys = (await this.blackboard.keys("candidate_flags")).filter((k) => k.startsWith(`${plan.planId}:`));
			for (const key of flagKeys) {
				const entry = await this.blackboard.get("candidate_flags", key);
				if (entry && entry.verified === true && entry.duplicate !== true) {
					flagTask.status = "done";
					flagTask.result = { flag: entry.flag, verified: true, verify_msg: entry.verify_msg, source: "planner-flag-gate" };
					flagTask.completedAt = nowIso();
					flagTask.updatedAt = nowIso();
					changed = true;
					this._emitTaskUpdate(plan, flagTask, "done", "flag 校验通过");
					this.ctx.logger.info("planner: plan %s flag 任务 %s 由已校验 flag 收口完成", plan.planId, flagTask.id);
					break;
				}
			}
		}

		// 3. running tasks past their timeout fail.
		for (const task of plan.tasks) {
			if (task.status !== "running" || !task.startedAt) continue;
			if (Date.now() - Date.parse(task.startedAt) > task.timeoutMs) {
				await this._recordFailure(plan, task, { type: "timeout", message: `subtask timed out after ${task.timeoutMs}ms` });
				changed = true;
				await this._handleTaskFailure(plan, task, { type: "timeout", message: `subtask timed out after ${task.timeoutMs}ms` });
			}
		}

		// 4. tasks depending on a failed/blocked task become blocked.
		for (const task of plan.tasks) {
			if (task.status !== "pending" && task.status !== "ready") continue;
			const blockedBy = task.dependencies.find((depId) => {
				const dep = plan.tasks.find((t) => t.id === depId);
				return dep?.status === "failed" || dep?.status === "blocked" || dep?.status === "cancelled";
			});
			if (blockedBy) {
				task.status = "blocked";
				task.error = { type: "dependency", message: `dependency ${blockedBy} failed`, at: nowIso() };
				task.updatedAt = nowIso();
				changed = true;
				this._emitTaskUpdate(plan, task, "blocked", `dependency ${blockedBy} failed`);
			}
		}

		// 5. completion / failure of the whole plan.
		const doneCount = plan.tasks.filter((t) => t.status === "done").length;
		const terminalCount = plan.tasks.filter((t) => t.status === "done" || t.status === "failed" || t.status === "blocked" || t.status === "cancelled").length;
		const inFlight = plan.tasks.some((t) => t.status === "running" || t.status === "ready" || t.status === "pending");

		if (doneCount === plan.tasks.length) {
			await this._completePlan(plan);
			changed = true;
		} else if (plan.tasks.length > 0 && terminalCount === plan.tasks.length && !inFlight) {
			await this._failPlan(plan, `all remaining subtasks failed or blocked (${plan.tasks.length - doneCount} of ${plan.tasks.length} not done)`);
			changed = true;
		} else if (plan.tasks.length === 0) {
			await this._failPlan(plan, "no subtasks were generated");
			changed = true;
		}

		if (changed) await this._persistPlan(plan);
	}

	/** Schedule the internal placeholder executor for one task. */
	_scheduleInternalExecution(planId, taskId) {
		const timer = setTimeout(() => {
			this.executorTimers.delete(timer);
			this._runInternalTask(planId, taskId).catch((error) => this._handleInternalError(`internal task ${taskId}`, error));
		}, this.config.internalDelayMs);
		this.executorTimers.add(timer);
	}

	/**
	 * Internal placeholder executor: deterministic, no LLM. Produces
	 * tool-output lines, a phase-appropriate result into clues, and — for the
	 * flag phase — extracts flag-shaped strings from the challenge description
	 * and this plan's clues into candidate_flags. Tasks matching
	 * `internalFailPattern` fail deterministically (exercises the failure
	 * path).
	 */
	async _runInternalTask(planId, taskId) {
		if (this.closed) return;
		const plan = await this.getPlan(planId);
		if (!plan || plan.status !== "running") return;
		const task = plan.tasks.find((t) => t.id === taskId);
		if (!task || task.status !== "running") return;

		if (this.config.internalFailPattern && new RegExp(this.config.internalFailPattern, "i").test(`${task.id} ${task.title} ${task.phase}`)) {
			await this.failTask(planId, taskId, `internal executor failed (matched ${JSON.stringify(this.config.internalFailPattern)})`);
			return;
		}

		await this.addToolOutput(planId, taskId, `[internal-executor] ${task.title} — ok`);
		await this.addToolOutput(planId, taskId, `[internal-executor] phase=${task.phase}, plan=${planId}, task=${taskId}`);

		let result;
		if (task.phase === "flag") {
			const parts = [plan.title, plan.description, ...plan.attachments.map((a) => `${a.name ?? ""} ${a.note ?? ""}`)];
			for (const other of plan.tasks) {
				const clue = await this.blackboard.get("clues", `${planId}:${other.id}`);
				if (clue && typeof clue === "object" && clue.result !== void 0) parts.push(JSON.stringify(clue.result));
			}
			const matches = [...new Set((parts.join("\n").match(FLAG_RE) ?? []).map((m) => m.trim()))];
			for (const flag of matches) await this.submitFlag(planId, flag, "planner-internal", taskId);
			result = { flagsFound: matches, note: matches.length === 0 ? "未在题目描述与线索中发现 flag 形态字符串，等待外部执行器补充" : `提取到 ${matches.length} 个候选 flag` };
		} else {
			result = {
				phase: task.phase,
				title: task.title,
				summary: `已完成「${task.title}」的确定性占位执行（internal executor）`,
				note: "该任务由 planner 内置占位执行器完成；接入真实 Agent 执行器后请改用 executionMode=external 并调用 completeTask/failTask。"
			};
		}

		await this.completeTask(planId, taskId, result, { executor: "internal" });
	}

	/** Record one failure entry into failures/<planId>:<taskId>. */
	async _recordFailure(plan, task, failure) {
		await this.blackboard.append("failures", `${plan.planId}:${task.id}`, {
			planId: plan.planId,
			taskId: task.id,
			...failure,
			attempt: task.attempts,
			at: nowIso()
		});
	}

	/** Transition one task after a failure: retry while attempts remain, else failed. */
	async _handleTaskFailure(plan, task, failure) {
		task.error = { ...failure, at: nowIso() };
		task.updatedAt = nowIso();
		const retrying = task.attempts < task.maxAttempts;
		task.status = retrying ? "ready" : "failed";
		await this._persistPlan(plan);
		this._emitTaskUpdate(plan, task, task.status, retrying ? `retry ${task.attempts}/${task.maxAttempts} after failure` : failure.message);
		return { planId: plan.planId, taskId: task.id, status: task.status, reason: failure.message, at: nowIso() };
	}

	/** Finish a plan successfully: collect flags, emit `planner/done`. */
	async _completePlan(plan) {
		plan.status = "done";
		plan.completedAt = nowIso();
		plan.updatedAt = nowIso();
		const flagKeys = (await this.blackboard.keys("candidate_flags")).filter((key) => key.startsWith(`${plan.planId}:`));
		const flags = [];
		for (const key of flagKeys) {
			const entry = await this.blackboard.get("candidate_flags", key);
			if (entry) flags.push(entry);
		}
		await this.blackboard.set(this.section, "current", { planId: plan.planId, status: plan.status, updatedAt: plan.updatedAt });
		this.activePlans.delete(plan.planId);
		this.ctx.emit("planner/done", { planId: plan.planId, plan, flags, at: nowIso() });
		this.ctx.logger.info("planner: plan %s done (%d tasks, %d candidate flags)", plan.planId, plan.tasks.length, flags.length);
	}

	/** Fail a plan: emit `planner/fail`. */
	async _failPlan(plan, reason) {
		plan.status = "failed";
		plan.failReason = reason;
		plan.updatedAt = nowIso();
		const failedTasks = plan.tasks.filter((t) => t.status === "failed" || t.status === "blocked").map((t) => t.id);
		await this.blackboard.set(this.section, "current", { planId: plan.planId, status: plan.status, updatedAt: plan.updatedAt });
		this.activePlans.delete(plan.planId);
		this.ctx.emit("planner/fail", { planId: plan.planId, reason, failedTasks, at: nowIso() });
		this.ctx.logger.warn("planner: plan %s failed: %s", plan.planId, reason);
	}

	//#endregion

	//#region resume (checkpoint recovery)

	/**
	 * On plugin start, recover the last unfinished plan from the blackboard.
	 * Tasks that were `running` when the harness died become `interrupted`
	 * (failure recorded) and are re-scheduled; the plan continues from its
	 * persisted state — checkpoint resume.
	 */
	async _resumeFromBlackboard() {
		const current = await this.blackboard.get(this.section, "current");
		if (!current?.planId) return;
		const plan = await this.getPlan(current.planId);
		if (!plan) {
			this.ctx.logger.warn("planner: current pointer %s has no plan record; ignoring", current.planId);
			return;
		}
		if (plan.status !== "running" && plan.status !== "paused") {
			this.ctx.logger.info("planner: current plan %s is %s; nothing to resume", plan.planId, plan.status);
			return;
		}
		await this._withPlan(plan.planId, async (p) => {
			let interrupted = 0;
			for (const task of p.tasks) {
				if (task.status === "running") {
					task.status = "interrupted";
					task.updatedAt = nowIso();
					interrupted += 1;
					await this._recordFailure(p, task, { type: "interrupt", message: "planner restarted while the subtask was in flight; rescheduling" });
					this._emitTaskUpdate(p, task, "interrupted", "planner restart");
				}
			}
			p.status = "running";
			p.updatedAt = nowIso();
			await this._persistPlan(p);
			if (interrupted > 0) this.ctx.logger.warn("planner: resumed plan %s, interrupted %d in-flight task(s)", p.planId, interrupted);
		});
		if (this.config.autoRun && !this.closed) {
			this.activePlans.add(plan.planId);
			this._ensureInterval();
			this.ctx.emit("planner/resumed", { planId: plan.planId, plan: await this.getPlan(plan.planId), at: nowIso() });
			this.ctx.logger.info("planner: resumed plan %s from blackboard", plan.planId);
			await this._tick();
		}
	}

	//#endregion

	//#region helpers

	_findTask(plan, taskId) {
		return plan.tasks.find((task) => task.id === taskId);
	}

	_emitTaskUpdate(plan, task, status, reason) {
		if (this.closed) return;
		this.ctx.emit("planner/task-update", {
			planId: plan.planId,
			taskId: task.id,
			status,
			reason,
			task: { ...task },
			at: nowIso()
		});
	}

	_handleInternalError(context, error) {
		this.ctx.logger.error("planner: %s failed: %s", context, error?.message ?? String(error));
		if (!this.closed) this.ctx.emit("planner/error", { context, error, at: nowIso() });
	}

	//#endregion
}

export {
	DECOMPOSITION_TEMPLATES,
	DEFAULT_SECTION,
	FLAG_RE,
	PLAN_STATUSES,
	PlannerService,
	PlannerService as default,
	TASK_STATUSES,
	detectCategory
};
//#endregion
