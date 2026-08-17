//#region lib/types/index.d.ts
/**
 * Type declarations for @dsh-external/dsh-web-expert.
 *
 * 插件注册 cordis 服务 `webExpert`（`ctx.webExpert`）。硬性依赖
 * `["blackboard", "planner"]`。所有读写只经 ctx.blackboard.* /
 * ctx.planner.* API，禁止直接操作磁盘文件；运行阶段不访问 GitHub、不下载
 * 远程 payload/规则库；内部 HTTP 客户端不读取 HTTP_PROXY/HTTPS_PROXY。
 */
import type { Service } from "@deepseek-ai/cordis";
import type { BlackboardValue } from "@dsh-external/dsh-blackboard";
import type { PlannerTask } from "@dsh-external/dsh-planner";

/** web 专家可执行的子任务阶段。 */
export type WebTaskPhase = "recon" | "audit" | "analysis" | "exploit";

/** 挑战上下文（url 优先，其次从 description/attachments 提取）。 */
export interface WebChallengeContext {
	url?: string;
	description?: string;
	attachments?: Array<{ name?: string; path?: string; note?: string; [k: string]: unknown }>;
	planId?: string;
	title?: string;
	category?: string;
	[key: string]: BlackboardValue;
}

/** 执行入口参数。 */
export interface ExecuteTaskInput {
	planId: string;
	/** planner 任务对象（至少 id/phase/title/description）。 */
	task: Pick<PlannerTask, "id" | "phase" | "title" | "description"> & Partial<PlannerTask>;
	/** 挑战上下文（缺省从 challenges/<planId> 读取）。 */
	challenge?: WebChallengeContext;
	options?: Record<string, unknown>;
}

/** 任务运行状态（webExpert/tasks/<planId>:<taskId>）。 */
export interface WebTaskState {
	planId: string;
	taskId: string;
	phase: WebTaskPhase;
	title?: string;
	status: "running" | "done" | "failed" | "cancelled" | "interrupted";
	progress?: string;
	startedAt?: string;
	updatedAt: string;
	result?: WebTaskResult;
	error?: { code?: string; message?: string };
}

/** 一次执行的结果。 */
export interface WebTaskResult {
	phase: WebTaskPhase;
	status: "done" | "failed" | "cancelled";
	findings?: WebFinding[];
	urls?: string[];
	flag?: string | null;
	error?: { code?: string; message?: string };
	at?: string;
}

/** 单条发现。 */
export interface WebFinding {
	kind: "fingerprint" | "info-file" | "dir" | "leak" | "sqli" | "lfi" | "ssti";
	detail?: unknown;
	path?: string;
	param?: string;
	payload?: string;
	status?: number;
	size?: number;
	snippet?: string;
}

/** 原始 HTTP 探测结果。 */
export interface HttpProbeResult {
	status: number;
	headers: Record<string, unknown>;
	text: string;
	finalUrl: string;
}

/** 插件配置。 */
export interface WebExpertConfig {
	/** webExpert 分区名（默认 "webExpert"）。 */
	section: string;
	/** 监听 planner/task-update(running) 自动认领 web 子任务。 */
	autoClaim: boolean;
	/** 单请求超时（ms）。 */
	timeoutMs: number;
	/** 手动跟随重定向上限。 */
	maxRedirects: number;
	/** 响应体大小上限（字节）。 */
	maxResponseBytes: number;
	/** 每次目录爆破的路径上限。 */
	maxDirProbe: number;
	/** 目录爆破并发数。 */
	concurrentRequests: number;
	/** 请求 User-Agent。 */
	userAgent: string;
	/** 启动时扫描恢复被中断的 web 子任务。 */
	resumeOnStart: boolean;
}

/** `ctx.webExpert` 服务面。 */
export interface WebExpertService extends Service {
	/** 执行一个 web 子任务（recon/audit/exploit）。 */
	executeTask(input: ExecuteTaskInput): Promise<WebTaskResult>;
	/** 取消一个正在执行的任务（步骤边界生效）。 */
	cancelTask(planId: string, taskId: string): Promise<{ planId: string; taskId: string; cancelled: boolean; at: string }>;
	/** 读取任务运行状态。 */
	getTaskState(planId: string, taskId: string): Promise<WebTaskState | undefined>;
	/** 列出本插件记录的全部 web 任务状态。 */
	listTasks(): Promise<WebTaskState[]>;
	/** 对单个 URL 发起探测（服务 API 复用/测试）。 */
	probeUrl(url: string, options?: Partial<WebExpertConfig> & { method?: string; headers?: Record<string, string>; body?: unknown }): Promise<HttpProbeResult>;
}

/** `web-expert/execute-task` 事件 payload（同 executeTask 入参）。 */
export type WebExpertExecuteEvent = ExecuteTaskInput;

/** `web-expert/task-progress` 事件 payload。 */
export interface WebExpertProgressEvent {
	planId: string;
	taskId: string;
	phase: WebTaskPhase;
	step: string;
	at: string;
}

/** `web-expert/task-done` 事件 payload。 */
export interface WebExpertDoneEvent {
	planId: string;
	taskId: string;
	phase: WebTaskPhase;
	result: WebTaskResult;
	at: string;
}

/** `web-expert/task-fail` 事件 payload。 */
export interface WebExpertFailEvent {
	planId: string;
	taskId: string;
	phase?: WebTaskPhase;
	error: { code?: string; message?: string };
	reason: string;
	at: string;
}

/** `web-expert/task-claimed` 事件 payload（认领时发出）。 */
export interface WebExpertClaimedEvent {
	planId: string;
	taskId: string;
	phase: WebTaskPhase;
	at: string;
}

/** 本插件输出的事件名。 */
export const WEB_EXPERT_EVENTS: readonly [
	"web-expert/task-claimed",
	"web-expert/task-progress",
	"web-expert/task-done",
	"web-expert/task-fail",
	"web-expert/error",
] as const;

/** 本插件接收的事件名。 */
export const WEB_EXPERT_COMMANDS: readonly ["web-expert/execute-task", "web-expert/cancel-task"] as const;

/** 插件类（cordis 入口导出）。 */
export declare class WebExpertService extends Service {
	static provide: "webExpert";
	static inject: ["blackboard", "planner"];
	static Config: import("@deepseek-ai/schemastery").S<WebExpertConfig>;
}

export default WebExpertService;
//#endregion
