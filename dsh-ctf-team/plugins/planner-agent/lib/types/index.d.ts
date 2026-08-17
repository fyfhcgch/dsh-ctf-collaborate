//#region lib/types/index.d.ts
/**
 * Type declarations for @dsh-external/dsh-planner.
 *
 * The plugin registers the cordis service `planner` on the context. Agent
 * plugins consume it through `ctx.planner` (declare
 * `static inject = ["planner"]` — the fiber waits for availability), and the
 * blackboard service it orchestrates through `ctx.blackboard`.
 *
 * Hard dependency: the planner declares `inject: ["blackboard"]`, so it never
 * activates unless @dsh-external/dsh-blackboard is deployed in the same
 * profile. It never reads/writes persistent_data files itself — all durable
 * state goes through `ctx.blackboard` (single JSON file, atomic writes).
 */
import type { Service } from "@deepseek-ai/cordis";
import type { BlackboardValue } from "@dsh-external/dsh-blackboard";

/** One attachment of a challenge. */
export interface PlannerAttachment {
	name?: string;
	path?: string;
	type?: string;
	size?: number;
	note?: string;
	[key: string]: unknown;
}

/** Payload of the `planner/start` event / `ctx.planner.start()` call. */
export interface PlannerStartInput {
	/** Challenge description (required). */
	description: string;
	/** Optional challenge title. */
	title?: string;
	/** Optional attachment information. */
	attachments?: PlannerAttachment[];
	/** Optional explicit plan id (`/^[A-Za-z0-9_-]{1,80}$/`). */
	planId?: string;
	/** Free-form plan metadata. */
	meta?: Record<string, unknown>;
}

/** Challenge categories recognized by the CoT decomposition. */
export type PlannerCategory = "web" | "pwn" | "crypto" | "reverse" | "forensics" | "osint" | "misc";

/** Sub-task lifecycle statuses. */
export type PlannerTaskStatus = "pending" | "ready" | "running" | "done" | "failed" | "interrupted" | "blocked" | "cancelled";

/** Plan-level statuses. */
export type PlannerPlanStatus = "running" | "done" | "failed" | "cancelled" | "paused";

/** Why a task failed. */
export interface PlannerTaskError {
	type: "executor" | "timeout" | "dependency" | "interrupt" | "cancelled";
	message: string;
	at: string;
	attempt?: number;
	meta?: Record<string, unknown>;
}

/** One sub-task in a plan's DAG. */
export interface PlannerTask {
	id: string;
	phase: "recon" | "analysis" | "exploit" | "flag" | string;
	title: string;
	description: string;
	status: PlannerTaskStatus;
	/** Task ids that must be `done` before this task may run. */
	dependencies: string[];
	result?: BlackboardValue;
	error?: PlannerTaskError;
	attempts: number;
	maxAttempts: number;
	startedAt?: string;
	completedAt?: string;
	timeoutMs: number;
	createdAt: string;
	updatedAt: string;
	metadata: Record<string, unknown>;
}

/** One CTF plan: the challenge + its task DAG + plan status. */
export interface PlannerPlan {
	planId: string;
	title: string;
	description: string;
	attachments: PlannerAttachment[];
	category: PlannerCategory;
	status: PlannerPlanStatus;
	tasks: PlannerTask[];
	createdAt: string;
	updatedAt: string;
	startedAt?: string;
	completedAt?: string;
	failReason?: string;
	meta: Record<string, unknown>;
}

/** A candidate flag recorded in the blackboard candidate_flags section. */
export interface CandidateFlag {
	planId: string;
	flag: string;
	source?: string;
	taskId?: string;
	at: string;
	key?: string;
}

/** `planner/task-update` event payload. */
export interface PlannerTaskUpdateEvent {
	planId: string;
	taskId: string;
	status: PlannerTaskStatus;
	reason?: string;
	task?: PlannerTask;
	at: string;
}

/** `planner/done` event payload. */
export interface PlannerDoneEvent {
	planId: string;
	plan: PlannerPlan;
	flags: CandidateFlag[];
	at: string;
}

/** `planner/fail` event payload. */
export interface PlannerFailEvent {
	planId?: string;
	reason: string;
	failedTasks: string[];
	at: string;
}

/** `planner/started` event payload. */
export interface PlannerStartedEvent {
	planId: string;
	plan: PlannerPlan;
	at: string;
}

/** `planner/resumed` event payload. */
export interface PlannerResumedEvent {
	planId: string;
	plan: PlannerPlan;
	at: string;
}

/** `planner/flag` event payload. */
export interface PlannerFlagEvent {
	planId: string;
	flag: string;
	source?: string;
	taskId?: string;
	at: string;
}

/** `planner/error` event payload. */
export interface PlannerErrorEvent {
	context: string;
	error: unknown;
	at: string;
}

/** Result of `ctx.planner.completeTask / failTask`. */
export interface PlannerTaskResult {
	planId: string;
	taskId: string;
	status: PlannerTaskStatus;
	reason?: string;
	at: string;
}

/** Plugin config schema. */
export interface PlannerConfig {
	/** Planner-owned blackboard section (default `"planner"`). */
	section: string;
	/** `"internal"` (built-in placeholder executor) or `"external"` (agent executors). */
	executionMode: "internal" | "external";
	/** Delay before the internal executor runs each task (ms). */
	internalDelayMs: number;
	/** Regex; matching task ids/titles fail deterministically in internal mode. */
	internalFailPattern: string;
	/** Per-task timeout (ms); overdue running tasks fail with `timeout`. */
	taskTimeoutMs: number;
	/** Scheduling tick interval (ms). */
	tickMs: number;
	/** Cap on generated sub-tasks. */
	maxTasks: number;
	/** Failure retries per task before it stays `failed`. */
	maxAttempts: number;
	/** Resume the last unfinished plan from the blackboard on plugin start. */
	resumeOnStart: boolean;
	/** Automatically schedule/execute after `planner/start`. */
	autoRun: boolean;
}

/** The `ctx.planner` service surface. */
export interface PlannerService extends Service {
	/**
	 * Start a plan: decompose the challenge into a task DAG, persist it
	 * through the blackboard, emit `planner/started`, and schedule execution.
	 */
	start(input: PlannerStartInput): Promise<{ planId: string; plan: PlannerPlan }>;
	/** Read one plan fresh from the blackboard. */
	getPlan(planId: string): Promise<PlannerPlan | undefined>;
	/** Read the plan pointed to by `planner/current`. */
	getCurrentPlan(): Promise<PlannerPlan | undefined>;
	/** List every persisted plan. */
	listPlans(): Promise<PlannerPlan[]>;
	/** External-executor hook: report a task as successfully completed. */
	completeTask(planId: string, taskId: string, result?: BlackboardValue, meta?: Record<string, unknown>): Promise<PlannerTaskResult>;
	/** External-executor hook: report a task as failed. */
	failTask(planId: string, taskId: string, error: string | Error, meta?: Record<string, unknown>): Promise<PlannerTaskResult>;
	/** Record one intermediate finding into the clues section. */
	addClue(planId: string, taskId: string, clue: BlackboardValue, meta?: Record<string, unknown>): Promise<unknown>;
	/** Append one tool-output line into the tool_outputs section. */
	addToolOutput(planId: string, taskId: string, output: BlackboardValue, meta?: Record<string, unknown>): Promise<unknown>;
	/** Submit one candidate flag into the candidate_flags section (dedup). */
	submitFlag(planId: string, flag: string, source?: string, taskId?: string): Promise<{ planId: string; flag: string; source?: string; taskId?: string; changed: boolean; key?: string }>;
	/** Cancel a running plan. */
	cancel(planId: string): Promise<PlannerPlan>;
	/** Reset one failed/blocked task for re-scheduling. */
	retryTask(planId: string, taskId: string): Promise<PlannerTaskResult>;
}

/** Notification event names emitted by the planner. */
export const PLANNER_EVENTS: readonly [
	"planner/started",
	"planner/task-update",
	"planner/flag",
	"planner/done",
	"planner/fail",
	"planner/resumed",
	"planner/cancelled",
	"planner/error",
] as const;

/** The plugin class (cordis entry export). */
export declare class PlannerService extends Service {
	static provide: "planner";
	static inject: ["blackboard"];
	static Config: import("@deepseek-ai/schemastery").S<PlannerConfig>;
}

export default PlannerService;
//#endregion
