//#region lib/types/index.d.ts
/**
 * Type declarations for @dsh-external/dsh-docker-sandbox.
 *
 * The plugin registers the cordis service `dockerSandbox` on the context;
 * agent plugins consume it through `ctx.dockerSandbox` (declare
 * `static inject = ["blackboard", "dockerSandbox"]` or await
 * `ctx.dockerSandbox` availability). The name deliberately avoids the
 * built-in `ctx.sandbox` service that powers the harness's own tool
 * sandboxing. All persistence flows through the blackboard service; the
 * Docker daemon is always reached over the Engine API (HTTP / unix socket /
 * named pipe) — never a local shell.
 */
import type { Service } from "@deepseek-ai/cordis";

/** One file injected into the container before start. */
export interface SandboxFile {
	/** Container-relative path, e.g. `work/main.py` (no leading `/`, no `..`). */
	name: string;
	/** File content (string or Buffer). */
	content?: string | Uint8Array;
	/** Unix mode (octal), default 0o644. */
	mode?: number;
	/** mtime (unix seconds). */
	mtime?: number;
	/** `"dir"` creates a directory entry instead of a file. */
	type?: "dir";
}

/** Input to {@link SandboxService.run}. */
export interface SandboxRunInput {
	/** Image name; defaults to config `defaultImage` (`alpine` → `alpine:latest`). */
	image?: string;
	/** Command argv; a plain string runs via `/bin/sh -c`. */
	cmd?: string | string[];
	/** Extra argv appended after `cmd`. */
	args?: string[];
	/** Entrypoint override. */
	entrypoint?: string | string[];
	/** Script body — uploaded as `work/script.sh` and run with `/bin/sh` when no `cmd` is given. */
	script?: string;
	/** Files uploaded as a ustar tar before start. */
	files?: SandboxFile[];
	/** Environment variables. */
	env?: Record<string, string | number | boolean>;
	/** Working directory inside the container (created if absent). */
	workdir?: string;
	/** Container user (e.g. `nobody` or `1000:1000`). */
	user?: string;
	/** Memory limit, e.g. `128m` / `1g`. */
	memory?: string;
	/** CPU limit (fraction allowed). */
	cpus?: number;
	/** Disable container networking. */
	networkDisabled?: boolean;
	/** Run timeout in ms; on expiry the container is SIGKILLed. */
	timeoutMs?: number;
	/** Per-stream output cap in bytes. */
	maxOutputBytes?: number;
	/** Remove the container after the run (default config `autoRemove`). */
	autoRemove?: boolean;
	/** Container name hint. */
	name?: string;
	/** Extra container labels. */
	labels?: Record<string, string>;
	/** Request a privileged container (requires config `allowPrivileged`). */
	privileged?: boolean;
	/** Explicit host bind mounts `[{ hostPath, containerPath }]` (none by default; pwn/reverse 挂载题目二进制用). */
	mounts?: Array<{ hostPath: string; containerPath: string }>;
	/** Planner plan id — records are linked into `tool_outputs/<planId>:<taskId>`. */
	planId?: string;
	/** Planner task id. */
	taskId?: string;
}

/** Result of one sandbox run. */
export interface SandboxRunResult {
	runId: string;
	/** `true` = sandbox machinery completed (command exit code is in `exitCode`). */
	ok: boolean;
	/** Command exit code (`137` after timeout SIGKILL, `null` if unknown). */
	exitCode: number | null;
	stdout: string;
	stderr: string;
	/** `true` when the run was killed by the sandbox timeout. */
	timedOut: boolean;
	durationMs: number;
	containerId: string | null;
	image: string;
	startedAt: string;
	at: string;
}

/** One persisted execution record (blackboard section `sandbox/executions/<runId>`). */
export interface SandboxRunRecord {
	runId: string;
	image: string;
	cmd: string[] | null;
	script: string | null;
	files: Array<{ name: string; mode?: number }>;
	env: Record<string, string>;
	workdir: string;
	user: string;
	memory: string;
	cpus: number;
	networkDisabled: boolean;
	timeoutMs: number;
	planId?: string;
	taskId?: string;
	containerId: string | null;
	exitCode: number | null;
	timedOut: boolean;
	stdout: string;
	stderr: string;
	durationMs: number;
	startedAt: string;
	removed: boolean;
	stage?: string;
	error?: { code: string; message: string };
	cleanupError?: { code: string; message: string } | null;
	at: string;
}

/** Result of one daemon probe (never rejects; `ok: false` on failure). */
export interface SandboxPingResult {
	ok: boolean;
	daemon: string;
	pong?: string;
	version?: string;
	apiVersion?: string;
	os?: string;
	arch?: string;
	containerCount?: number;
	imageCount?: number;
	target: string;
	error?: { code: string; message: string };
	at: string;
}

/** Command-channel payload: `ctx.emit("sandbox/command", payload)`. */
export interface SandboxCommand {
	op: "ping" | "run" | "version" | "info" | "list-images" | "list-containers" | "prune" | "remove-container" | "status";
	/** Used by `op: "run"` and `op: "remove-container"`. */
	id?: string;
	[key: string]: unknown;
}

/** The `ctx.dockerSandbox` service surface. */
export interface SandboxService extends Service {
	/** Whether the last probe reached the docker daemon. */
	getAvailable(): boolean;
	/** Probe the daemon (`/_ping` + `/version` + `/info`). Resolves, never rejects. */
	ping(): Promise<SandboxPingResult>;
	/** GET /version. */
	version(): Promise<Record<string, unknown>>;
	/** GET /info. */
	info(): Promise<Record<string, unknown>>;
	/** GET /images/json. */
	listImages(): Promise<Array<Record<string, unknown>>>;
	/** GET /containers/json?all=1. */
	listContainers(): Promise<Array<Record<string, unknown>>>;
	/** POST /containers/prune?label=dsh.sandbox. */
	prune(): Promise<Record<string, unknown>>;
	/** Delete one container by id (cleanup of leftovers). */
	removeContainer(id: string): Promise<void>;
	/** Execute one command/script in a disposable container. */
	run(input: SandboxRunInput): Promise<SandboxRunResult>;
	/** Read one persisted execution record. */
	getRun(runId: string): Promise<SandboxRunRecord | undefined>;
	/** List all persisted execution records (oldest first). */
	listRuns(): Promise<SandboxRunRecord[]>;
	/** Current daemon status + queue stats. */
	status(): Promise<Record<string, unknown>>;
	/** Dispatch a command-channel payload. */
	dispatch(payload: SandboxCommand): Promise<unknown>;
}

/** Notification event names emitted by the plugin. */
export const SANDBOX_EVENTS: readonly [
	"sandbox/ready",
	"sandbox/ping",
	"sandbox/run-start",
	"sandbox/run-done",
	"sandbox/run-fail",
	"sandbox/error",
] as const;

/** The plugin class (cordis entry export). */
export declare class SandboxServiceClass extends Service {
	static provide: "dockerSandbox";
	static inject: readonly ["blackboard"];
	static Config: import("@deepseek-ai/schemastery").S<Record<string, unknown>>;
}

/** Pure helpers (exported for tests). */
export function buildTar(files: Array<{ name: string; content?: string | Uint8Array; mode?: number; mtime?: number; type?: "dir" }>): Buffer;
export function decodeDockerLogFrames(buffer: Uint8Array, maxOutputBytes?: number): { stdout: string; stderr: string };
export function normalizeImageName(image: string): string;
export function parseMemory(value: string): number;

export default SandboxServiceClass;
//#endregion
