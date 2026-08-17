//#region lib/types/index.d.ts
/**
 * Type declarations for @dsh-external/dsh-misc-expert.
 *
 * 插件注册 cordis 服务 `miscExpert`（`ctx.miscExpert`）。硬性依赖
 * `["blackboard", "planner"]`。所有读写只经 ctx.blackboard.* /
 * ctx.planner.* API，禁止直接操作磁盘文件；运行阶段离线。
 */
import type { Service } from "@deepseek-ai/cordis";
import type { BlackboardValue } from "@dsh-external/dsh-blackboard";
import type { PlannerTask } from "@dsh-external/dsh-planner";

/** misc 专家可执行的子任务阶段。 */
export type MiscTaskPhase = "recon" | "analysis" | "exploit";

/** 挑战上下文（data 优先，其次 description/attachments）。 */
export interface MiscChallengeContext {
	/** 直接传入的待解数据（编码串/隐写文本/数字列表等）。 */
	data?: string;
	description?: string;
	attachments?: Array<{ name?: string; note?: string; [k: string]: unknown }>;
	[key: string]: BlackboardValue;
}

/** 执行入口参数。 */
export interface MiscExecuteInput {
	planId: string;
	task: Pick<PlannerTask, "id" | "phase" | "title" | "description"> & Partial<PlannerTask>;
	challenge?: MiscChallengeContext;
	options?: Record<string, unknown>;
}

/** 任务运行状态。 */
export interface MiscTaskState {
	planId: string;
	taskId: string;
	phase: MiscTaskPhase;
	title?: string;
	status: "running" | "done" | "failed" | "cancelled" | "interrupted";
	progress?: string;
	startedAt?: string;
	updatedAt: string;
	result?: MiscTaskResult;
	error?: { code?: string; message?: string };
}

/** 一次执行的结果。 */
export interface MiscTaskResult {
	phase: MiscTaskPhase;
	status: "done" | "failed" | "cancelled";
	findings?: MiscFinding[];
	plaintext?: string;
	flag?: string | null;
	error?: { code?: string; message?: string };
	at?: string;
}

/** 单条发现。 */
export interface MiscFinding {
	kind: "type" | "data" | "candidates" | "stego" | "zero-width" | "case-bits" | "acrostic" | "base64" | "base32" | "hex" | "url" | "unicode" | "rot13" | "caesar" | "morse" | "bacon" | "binary" | "reverse" | "numbers-decimal" | "numbers-hex" | "numbers-octal";
	detail?: unknown;
	count?: number;
	plaintext?: string;
}

/** 求解管线单步结果。 */
export interface MiscSolveStep {
	kind: string;
	text: string;
	score: number;
	flags: string[];
	flag: string | null;
	summary: string;
}

/** 求解管线结果。 */
export interface MiscSolveResult {
	steps: MiscSolveStep[];
	attempts: number;
	solved: boolean;
}

/** 插件配置。 */
export interface MiscExpertConfig {
	/** miscExpert 分区名（默认 "miscExpert"）。 */
	section: string;
	/** 监听 planner/task-update 自动认领 misc 子任务。 */
	autoClaim: boolean;
	/** 启动时扫描恢复被中断的 misc 子任务。 */
	resumeOnStart: boolean;
	/** 输入数据长度上限（防超长 DoS）。 */
	maxInputBytes: number;
	/** 凯撒爆破保留 topN。 */
	caesarTop: number;
}

/** `ctx.miscExpert` 服务面。 */
export interface MiscExpertService extends Service {
	/** 执行一个 misc 子任务。 */
	executeTask(input: MiscExecuteInput): Promise<MiscTaskResult>;
	/** 取消一个正在执行的任务。 */
	cancelTask(planId: string, taskId: string): Promise<{ planId: string; taskId: string; cancelled: boolean; at: string }>;
	/** 读取任务运行状态。 */
	getTaskState(planId: string, taskId: string): Promise<MiscTaskState | undefined>;
	/** 列出本插件记录的全部任务状态。 */
	listTasks(): Promise<MiscTaskState[]>;
	/** 公开求解入口：对给定数据执行内置求解管线。 */
	solveData(data: string, options?: { caesarTop?: number }): Promise<MiscSolveResult>;
}

/** `misc-expert/execute-task` 事件 payload。 */
export type MiscExpertExecuteEvent = MiscExecuteInput;

/** `misc-expert/task-progress` 事件 payload。 */
export interface MiscExpertProgressEvent {
	planId: string;
	taskId: string;
	phase: MiscTaskPhase;
	step: string;
	at: string;
}

/** `misc-expert/task-done` 事件 payload。 */
export interface MiscExpertDoneEvent {
	planId: string;
	taskId: string;
	phase: MiscTaskPhase;
	result: MiscTaskResult;
	at: string;
}

/** `misc-expert/task-fail` 事件 payload。 */
export interface MiscExpertFailEvent {
	planId: string;
	taskId: string;
	phase?: MiscTaskPhase;
	error: { code?: string; message?: string };
	reason: string;
	at: string;
}

/** 本插件输出的事件名。 */
export const MISC_EXPERT_EVENTS: readonly [
	"misc-expert/task-claimed",
	"misc-expert/task-progress",
	"misc-expert/task-done",
	"misc-expert/task-fail",
	"misc-expert/error",
] as const;

/** 本插件接收的事件名。 */
export const MISC_EXPERT_COMMANDS: readonly ["misc-expert/execute-task", "misc-expert/cancel-task"] as const;

/** 插件类（cordis 入口导出）。 */
export declare class MiscExpertService extends Service {
	static provide: "miscExpert";
	static inject: ["blackboard", "planner"];
	static Config: import("@deepseek-ai/schemastery").S<MiscExpertConfig>;
}

export default MiscExpertService;
//#endregion
