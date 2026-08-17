//#region lib/types/index.d.ts
/**
 * Type declarations for @dsh-external/dsh-crypto-expert.
 *
 * 插件注册 cordis 服务 `cryptoExpert`（`ctx.cryptoExpert`）。硬性依赖
 * `["blackboard", "planner"]`。所有读写只经 ctx.blackboard.* /
 * ctx.planner.* API，禁止直接操作磁盘文件；运行阶段离线（无远程规则下载）。
 */
import type { Service } from "@deepseek-ai/cordis";
import type { BlackboardValue } from "@dsh-external/dsh-blackboard";
import type { PlannerTask } from "@dsh-external/dsh-planner";

/** crypto 专家可执行的子任务阶段。 */
export type CryptoTaskPhase = "recon" | "analysis" | "exploit";

/** 挑战上下文（ciphertext/params 优先，其次 description/attachments）。 */
export interface CryptoChallengeContext {
	/** 直接传入的密文/待解文本。 */
	ciphertext?: string;
	/** 直接传入的参数（如 "e=3 n=... c=..." 或对象）。 */
	params?: string | Record<string, unknown>;
	description?: string;
	attachments?: Array<{ name?: string; note?: string; [k: string]: unknown }>;
	[key: string]: BlackboardValue;
}

/** 执行入口参数。 */
export interface CryptoExecuteInput {
	planId: string;
	task: Pick<PlannerTask, "id" | "phase" | "title" | "description"> & Partial<PlannerTask>;
	challenge?: CryptoChallengeContext;
	options?: Record<string, unknown>;
}

/** 任务运行状态。 */
export interface CryptoTaskState {
	planId: string;
	taskId: string;
	phase: CryptoTaskPhase;
	title?: string;
	status: "running" | "done" | "failed" | "cancelled" | "interrupted";
	progress?: string;
	startedAt?: string;
	updatedAt: string;
	result?: CryptoTaskResult;
	error?: { code?: string; message?: string };
}

/** 一次执行的结果。 */
export interface CryptoTaskResult {
	phase: CryptoTaskPhase;
	status: "done" | "failed" | "cancelled";
	findings?: CryptoFinding[];
	plaintext?: string;
	flag?: string | null;
	attempts?: number;
	error?: { code?: string; message?: string };
	at?: string;
}

/** 单条发现。 */
export interface CryptoFinding {
	kind: "algorithm" | "params" | "cipher" | "weakness" | "base64" | "hex" | "url" | "rot13" | "caesar" | "xor-single" | "xor-multi" | "rsa";
	detail?: unknown;
	count?: number;
	cipher?: string;
	plaintext?: string;
}

/** 求解管线单步结果。 */
export interface SolveStep {
	kind: string;
	text: string;
	score: number;
	flags: string[];
	flag: string | null;
	summary: string;
}

/** 求解管线结果。 */
export interface SolveResult {
	steps: SolveStep[];
	attempts: number;
	solved: boolean;
}

/** 插件配置。 */
export interface CryptoExpertConfig {
	/** cryptoExpert 分区名（默认 "cryptoExpert"）。 */
	section: string;
	/** 监听 planner/task-update 自动认领 crypto 子任务。 */
	autoClaim: boolean;
	/** 启动时扫描恢复被中断的 crypto 子任务。 */
	resumeOnStart: boolean;
	/** 多字节 XOR 密钥长度上限。 */
	maxXorKeyLen: number;
	/** 凯撒爆破保留 topN。 */
	caesarTop: number;
}

/** `ctx.cryptoExpert` 服务面。 */
export interface CryptoExpertService extends Service {
	/** 执行一个 crypto 子任务。 */
	executeTask(input: CryptoExecuteInput): Promise<CryptoTaskResult>;
	/** 取消一个正在执行的任务。 */
	cancelTask(planId: string, taskId: string): Promise<{ planId: string; taskId: string; cancelled: boolean; at: string }>;
	/** 读取任务运行状态。 */
	getTaskState(planId: string, taskId: string): Promise<CryptoTaskState | undefined>;
	/** 列出本插件记录的全部任务状态。 */
	listTasks(): Promise<CryptoTaskState[]>;
	/** 公开求解入口：对给定密文/文本执行内置求解管线。 */
	analyzeText(text: string, options?: { rsaParams?: Record<string, string>; maxKeyLen?: number; caesarTop?: number }): Promise<SolveResult>;
}

/** `crypto-expert/execute-task` 事件 payload。 */
export type CryptoExpertExecuteEvent = CryptoExecuteInput;

/** `crypto-expert/task-progress` 事件 payload。 */
export interface CryptoExpertProgressEvent {
	planId: string;
	taskId: string;
	phase: CryptoTaskPhase;
	step: string;
	at: string;
}

/** `crypto-expert/task-done` 事件 payload。 */
export interface CryptoExpertDoneEvent {
	planId: string;
	taskId: string;
	phase: CryptoTaskPhase;
	result: CryptoTaskResult;
	at: string;
}

/** `crypto-expert/task-fail` 事件 payload。 */
export interface CryptoExpertFailEvent {
	planId: string;
	taskId: string;
	phase?: CryptoTaskPhase;
	error: { code?: string; message?: string };
	reason: string;
	at: string;
}

/** 本插件输出的事件名。 */
export const CRYPTO_EXPERT_EVENTS: readonly [
	"crypto-expert/task-claimed",
	"crypto-expert/task-progress",
	"crypto-expert/task-done",
	"crypto-expert/task-fail",
	"crypto-expert/error",
] as const;

/** 本插件接收的事件名。 */
export const CRYPTO_EXPERT_COMMANDS: readonly ["crypto-expert/execute-task", "crypto-expert/cancel-task"] as const;

/** 插件类（cordis 入口导出）。 */
export declare class CryptoExpertService extends Service {
	static provide: "cryptoExpert";
	static inject: ["blackboard", "planner"];
	static Config: import("@deepseek-ai/schemastery").S<CryptoExpertConfig>;
}

export default CryptoExpertService;
//#endregion
