//#region lib/types/index.d.ts
/**
 * Type declarations for @dsh-external/dsh-verifier.
 *
 * 插件注册 cordis 服务 `verifier`（`ctx.verifier`）。硬性依赖
 * `["blackboard", "planner"]`：两个服务都就绪后本插件才启动。所有读写只经
 * `ctx.blackboard.*` / `ctx.planner.*` API，禁止直接操作磁盘文件。
 */
import type { Service } from "@deepseek-ai/cordis";
import type { BlackboardValue } from "@dsh-external/dsh-blackboard";
import type { PlannerPlan } from "@dsh-external/dsh-planner";

/** candidate_flags 分区内的一条候选 flag（含本插件合并写回的字段）。 */
export interface CandidateFlagEntry {
	planId?: string;
	flag: string;
	source?: string;
	taskId?: string;
	at: string;
	/** 本插件写回：是否校验通过。 */
	verified?: boolean;
	/** 本插件写回：校验备注。 */
	verify_msg?: string;
	/** 本插件写回：重复标记（去重时置 true）。 */
	duplicate?: boolean;
	/** 本插件写回：等待外部提交器（external 模式无提交器时）。 */
	pending?: boolean;
	[key: string]: BlackboardValue;
}

/** 校验结果状态。 */
export type VerifierStatus = "verified" | "failed" | "duplicate" | "pending" | "already" | "not-found" | "busy";

/** 单条校验结果。 */
export interface VerifyResult {
	key?: string;
	planId?: string;
	flag?: string;
	taskId?: string;
	status: VerifierStatus;
	verified?: boolean;
	verify_msg?: string;
	formatError?: boolean;
	duplicate?: boolean;
	firstKey?: string;
	at: string;
}

/** verifyAll() 汇总。 */
export interface VerifyAllSummary {
	total: number;
	verified: number;
	failed: number;
	formatError: number;
	duplicate: number;
	pending: number;
	already: number;
	skipped: number;
}

/** 一条已校验通过的 flag 记录。 */
export interface VerifiedFlagRecord {
	key: string;
	planId?: string;
	flag: string;
	taskId?: string;
	verify_msg?: string;
	at: string;
}

/** 外部提交器入参。 */
export interface VerifierSubmitContext {
	planId?: string;
	flag: string;
	taskId?: string;
	key: string;
	entry: CandidateFlagEntry;
}

/** 外部提交器返回值。 */
export interface VerifierSubmitResult {
	verified: boolean;
	verify_msg?: string;
}

/** 外部提交器函数类型。 */
export type VerifierSubmitter = (context: VerifierSubmitContext) => Promise<VerifierSubmitResult> | VerifierSubmitResult;

/** 插件配置 schema。 */
export interface VerifierConfig {
	/** verifier 分区名（默认 "verifier"）。 */
	section: string;
	/** "mock"（本地模拟校验，默认）| "external"（外部提交器）。 */
	mode: "mock" | "external";
	/** 启动时自动扫描 + 监听 candidate_flags 新条目。 */
	autoVerify: boolean;
	/** 额外的 flag 格式正则（整串匹配）。 */
	extraPatterns: string[];
	/** mock 模式下命中的 flag 判定为提交被拒（正则）。 */
	mockRejectPattern: string;
	/** flag 最大长度。 */
	maxFlagLength: number;
	/** 占位符黑名单（小写比对）。 */
	blockedPlaceholders: string[];
	/** 校验通过/全部失败时联动 planner（completeTask/failTask）。 */
	plannerLink: boolean;
	/** 重复 flag 自动去重（verifier/seen 哈希缓存）。 */
	dedupe: boolean;
}

/** `ctx.verifier` 服务面。 */
export interface VerifierService extends Service {
	/** 校验一个 flag：`{key}` 或 `{planId, flag}`（无条目则先登记再校验）。 */
	verifyOne(input: { key?: string; planId?: string; flag?: string }): Promise<VerifyResult>;
	/** 扫描 candidate_flags，校验所有无 verified 字段的条目。 */
	verifyAll(): Promise<VerifyAllSummary>;
	/** 已校验通过的 flag 列表（可按 planId 过滤）。 */
	getVerifiedFlags(options?: { planId?: string }): Promise<VerifiedFlagRecord[]>;
	/** 注册外部提交器（mode=external 生效）。 */
	setSubmitter(fn: VerifierSubmitter): void;
	/** 清空去重缓存与状态计数。 */
	clearCache(): Promise<{ removed: number; at: string }>;
	/** 读取 verifier/state。 */
	getState(): Promise<Record<string, unknown> | undefined>;
}

/** `verifier/verified-ok` 事件 payload。 */
export interface VerifierOkEvent {
	planId?: string;
	key: string;
	flag: string;
	taskId?: string;
	verify_msg?: string;
	at: string;
}

/** `verifier/verified-fail` 事件 payload。 */
export interface VerifierFailEvent {
	planId?: string;
	key: string;
	flag: string;
	taskId?: string;
	reason: string;
	at: string;
}

/** `verifier/duplicate-flag` 事件 payload。 */
export interface VerifierDuplicateEvent {
	planId?: string;
	key: string;
	flag: string;
	firstKey: string;
	firstVerified?: boolean;
	at: string;
}

/** `verifier/error` 事件 payload。 */
export interface VerifierErrorEvent {
	context: string;
	error: unknown;
	at: string;
}

/** `verifier/submit-request`（预留外部提交接口，external 模式无提交器时发出）。 */
export interface VerifierSubmitRequestEvent {
	planId?: string;
	flag: string;
	taskId?: string;
	key: string;
	at: string;
}

/** 本插件输出的事件名。 */
export const VERIFIER_EVENTS: readonly [
	"verifier/verified-ok",
	"verifier/verified-fail",
	"verifier/duplicate-flag",
	"verifier/error",
	"verifier/submit-request",
	"verifier/run-done",
	"verifier/cache-cleared",
] as const;

/** 本插件接收的事件名。 */
export const VERIFIER_COMMANDS: readonly ["verifier/run", "verifier/submit-one", "verifier/clear-cache"] as const;

/** 插件类（cordis 入口导出）。 */
export declare class VerifierService extends Service {
	static provide: "verifier";
	static inject: ["blackboard", "planner"];
	static Config: import("@deepseek-ai/schemastery").S<VerifierConfig>;
}

export default VerifierService;
//#endregion
