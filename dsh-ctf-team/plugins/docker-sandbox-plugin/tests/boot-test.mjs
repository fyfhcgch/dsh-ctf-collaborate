//#region tests/boot-test.mjs
/**
 * Standalone boot test for @dsh-external/dsh-docker-sandbox.
 *
 * Mounts the plugin exactly the way dsh profile boot does — a root Include
 * over a cordis.yml plus patch insert rows for the blackboard (hard dependency)
 * and the sandbox — using the REAL @deepseek-ai/dsh-app-boot `boot()` from the
 * installed harness. The Docker daemon is simulated by a local mock Engine API
 * server (tests/mock-docker.mjs); the plugin talks to it over plain HTTP, so
 * the whole execute path (create → archive upload → start → wait → kill →
 * logs → remove) is exercised without a real docker daemon and without any
 * local shell.
 *
 * Coverage:
 *   1. service loads, sandbox/ready fires, ping() against the mock daemon
 *   2. run(): exit code / stdout / stderr, container auto-removed
 *   3. blackboard recording: executions/<runId> + sandbox/status + tool_outputs
 *   4. script + files injection: archive uploaded, tar entries round-trip
 *   5. timeout path: SIGKILL → timedOut=true, exitCode=137, kill called
 *   6. allowedImages allowlist enforcement (no HTTP call issued)
 *   7. command channel (sandbox/command) event-driven ops
 *   8. concurrency: maxConcurrentRuns honored
 *   9. restart persistence: records survive a full tree restart
 *  10. unreachable daemon: degraded mode + EUNREACHABLE on run
 *
 * Usage:  node plugins/docker-sandbox-plugin/tests/boot-test.mjs
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { startMockDocker, readTarEntries } from "./mock-docker.mjs";
import { loadHarnessBoot } from "../../../tests/harness-scope.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = join(HERE, ".tmp");
const PROFILE_DIR = join(TMP, "profile");
const DATA_FILE = join(TMP, "blackboard.test.json");
const CONFIG_FILE = join(PROFILE_DIR, "cordis.yml");

const { boot } = await loadHarnessBoot();

/** Ensure the temp profile dir resolves the plugins exactly like a real profile. */
async function ensureProfileLinks() {
	const pluginsRoot = join(TMP, "..", "..", ".."); // docker-sandbox-plugin/tests/.tmp → plugins/
	const scope = join(PROFILE_DIR, "node_modules", "@dsh-external");
	await mkdir(scope, { recursive: true });
	const { symlink } = await import("node:fs");
	for (const [pkg, dir] of [["dsh-blackboard", "blackboard-plugin"], ["dsh-docker-sandbox", "docker-sandbox-plugin"]]) {
		const link = join(scope, pkg);
		try {
			await stat(link);
		} catch {
			await new Promise((resolve, reject) => symlink(join(pluginsRoot, dir), link, "junction", (error) => error ? reject(error) : resolve()));
		}
	}
	await writeFile(CONFIG_FILE, "[]\n", "utf8");
}

/** Patch rows (same shape the bundle cordis.patch.yml files produce). */
function sandboxPatch(file, sandboxConfig) {
	return [
		{
			insert: [{
				id: "blackboard",
				name: "@dsh-external/dsh-blackboard",
				config: { file }
			}]
		},
		{
			insert: [{
				id: "dockerSandbox",
				name: "@dsh-external/dsh-docker-sandbox",
				config: sandboxConfig
			}]
		}
	];
}

/** Boot one throwaway tree and return its context. */
function bootTree(sandboxConfig, file = DATA_FILE) {
	return boot("sandbox-test", CONFIG_FILE, sandboxPatch(file, sandboxConfig));
}

/** Poll until a predicate holds. */
async function waitFor(predicate, timeoutMs = 8000, intervalMs = 25) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error("waitFor: condition not met within timeout");
}

let passed = 0;
function ok(name) {
	passed += 1;
	console.log(`  ok ${passed} - ${name}`);
}

await rm(TMP, { recursive: true, force: true });
await ensureProfileLinks();

console.log("== mock docker daemon ==");
const mock = await startMockDocker();
console.log(`  mock daemon on ${mock.url}`);

const BASE_SANDBOX_CONFIG = {
	baseUrl: mock.url,
	healthCheckMs: 0,
	recordToBlackboard: true,
	allowedImages: ["^alpine:", "^node:20-alpine"]
};

console.log("== boot 1: fresh start + ping ==");
let ctx = await bootTree(BASE_SANDBOX_CONFIG);
const sandbox = ctx.dockerSandbox;
assert.ok(sandbox, "ctx.dockerSandbox must be provided");
// sandbox/ready 在 init 期间已发出（boot 返回前）；直接断言初始探测状态
assert.equal(sandbox.getAvailable(), true, "initial probe completed during init (available=true)");
const ping = await sandbox.ping();
assert.equal(ping.ok, true, "ping against mock daemon succeeds");
assert.equal(ping.daemon, "Docker Engine API");
assert.equal(ping.apiVersion, "1.46");
assert.equal(ping.containerCount, 0);
assert.equal(sandbox.getAvailable(), true, "getAvailable() after ping");
ok("service available; sandbox/ready fired; ping ok (version/api/containers)");

console.log("== run: cmd + env, stdout/stderr, auto-remove ==");
const run1 = await sandbox.run({
	cmd: ["sh", "-c", "echo hello"],
	env: { MOCK_STDOUT: "hello from mock\n", MOCK_STDERR: "warn to stderr\n", MOCK_EXIT: "0" },
	timeoutMs: 3000
});
assert.equal(run1.ok, true);
assert.equal(run1.exitCode, 0);
assert.equal(run1.stdout, "hello from mock\n");
assert.equal(run1.stderr, "warn to stderr\n");
assert.equal(run1.timedOut, false);
assert.ok(run1.runId.startsWith("sandbox-"), "runId format");
assert.ok(run1.containerId.startsWith("mock-c-"), "container id from mock");
await waitFor(() => !mock.state.containers.has(run1.containerId));
ok("run() returns exit/stdout/stderr; container removed after run");

console.log("== blackboard recording ==");
const record = await sandbox.getRun(run1.runId);
assert.ok(record, "executions/<runId> recorded");
assert.equal(record.exitCode, 0);
assert.equal(record.stdout, "hello from mock\n");
assert.equal(record.image, "alpine:latest");
const status = await sandbox.status();
assert.equal(status.totalRuns, 1, "totalRuns incremented");
assert.equal(status.available, true);
const persisted = await ctx.blackboard.get("sandbox", "status");
assert.equal(persisted.totalRuns, 1, "sandbox/status persisted to blackboard");
ok("run recorded durably (executions/<runId> + sandbox/status)");

console.log("== tool_outputs 联动（planId/taskId） ==");
await sandbox.run({
	cmd: ["true"],
	env: { MOCK_EXIT: "0" },
	planId: "plan-x",
	taskId: "t2"
});
await waitFor(async () => {
	const lines = await ctx.blackboard.get("tool_outputs", "plan-x:t2");
	return Array.isArray(lines) && lines.some((l) => l?.source === "docker-sandbox");
});
const lines = await ctx.blackboard.get("tool_outputs", "plan-x:t2");
assert.ok(lines.some((l) => l?.source === "docker-sandbox"), "tool_outputs/<planId>:<taskId> appended");
ok("tool_outputs 联动写入（source=docker-sandbox）");

console.log("== script + files 注入 ==");
const run3 = await sandbox.run({
	script: "echo from-script",
	files: [
		{ name: "work/main.py", content: "print('py')" },
		{ name: "data/secret.txt", content: "CTF{mock}" }
	],
	env: { MOCK_EXIT: "0" },
	timeoutMs: 3000
});
const archiveReq = mock.state.requests.find((r) => r.method === "PUT" && r.path === `/containers/${run3.containerId}/archive`);
assert.ok(archiveReq, "PUT /containers/{id}/archive called");
const archiveBody = mock.state.archives.at(-1);
assert.ok(archiveBody && archiveBody.length > 0, "archive body retained by mock");
const entries = readTarEntries(archiveBody);
const names = entries.map((e) => e.name);
assert.ok(names.includes("work"), "workdir dir entry");
assert.ok(names.includes("work/script.sh"), "script entry");
assert.ok(names.includes("work/main.py"), "file entry");
assert.ok(names.includes("data"), "nested dir entry");
assert.ok(names.includes("data/secret.txt"), "nested file entry");
assert.equal(new Set(names).size, names.length, "no duplicate tar entries");
const scriptEntry = entries.find((e) => e.name === "work/script.sh");
assert.equal(scriptEntry.content, "echo from-script");
const secretEntry = entries.find((e) => e.name === "data/secret.txt");
assert.equal(secretEntry.content, "CTF{mock}");
const run3Record = await sandbox.getRun(run3.runId);
assert.deepEqual(run3Record.files, [{ name: "work/main.py" }, { name: "data/secret.txt" }], "record lists uploaded files");
ok(`archive uploaded: ${names.join(", ")} (tar round-trip ok)`);

console.log("== 超时强杀 ==");
const beforeKill = mock.state.requests.filter((r) => r.method === "POST" && /\/kill$/.test(r.path)).length;
const run4 = await sandbox.run({
	cmd: ["sleep", "10"],
	env: { MOCK_DELAY: "5000", MOCK_EXIT: "0" },
	timeoutMs: 200
});
assert.equal(run4.timedOut, true, "timedOut flagged");
assert.equal(run4.exitCode, 137, "SIGKILL exit code");
const afterKill = mock.state.requests.filter((r) => r.method === "POST" && /\/kill$/.test(r.path)).length;
assert.equal(afterKill, beforeKill + 1, "kill endpoint called once");
await waitFor(() => !mock.state.containers.has(run4.containerId));
ok("timeout → SIGKILL → exit 137 → container removed");

console.log("== allowedImages 白名单 ==");
const createsBefore = mock.state.requests.filter((r) => r.method === "POST" && r.path === "/containers/create").length;
let imageError = null;
try {
	await sandbox.run({ image: "ubuntu:latest", cmd: ["true"] });
} catch (error) {
	imageError = error;
}
assert.ok(imageError, "run with disallowed image rejected");
assert.equal(imageError.code, "EIMAGE");
const createsAfter = mock.state.requests.filter((r) => r.method === "POST" && r.path === "/containers/create").length;
assert.equal(createsAfter, createsBefore, "no container create issued for disallowed image");
ok("allowedImages 白名单拦截（EIMAGE，无 HTTP 调用）");

console.log("== 命令通道 ==");
const pingEvents = [];
ctx.on("sandbox/ping", (p) => pingEvents.push(p));
ctx.emit("sandbox/command", { op: "ping" });
await waitFor(() => pingEvents.length > 0);
assert.equal(pingEvents[0].ok, true);
ok("sandbox/command { op: ping } → sandbox/ping event");

console.log("== 并发上限（maxConcurrentRuns=2） ==");
await ctx.fiber.dispose();
const ctxC = await bootTree({ ...BASE_SANDBOX_CONFIG, maxConcurrentRuns: 2 });
const results = await Promise.all([
	ctxC.dockerSandbox.run({ cmd: ["a"], env: { MOCK_EXIT: "0", MOCK_DELAY: "150" } }),
	ctxC.dockerSandbox.run({ cmd: ["b"], env: { MOCK_EXIT: "0", MOCK_DELAY: "150" } }),
	ctxC.dockerSandbox.run({ cmd: ["c"], env: { MOCK_EXIT: "0", MOCK_DELAY: "150" } })
]);
assert.ok(results.every((r) => r.ok), "all concurrent runs succeed");
const stC = await ctxC.dockerSandbox.status();
assert.equal(stC.activeSlots, 0, "slots released after runs");
assert.equal(stC.queued, 0, "queue drained");
ok("3 concurrent runs complete under maxConcurrentRuns=2; queue drained");

console.log("== boot 2: 重启持久 ==");
await ctxC.fiber.dispose();
ctx = await bootTree(BASE_SANDBOX_CONFIG);
const sandbox2 = ctx.dockerSandbox;
const runs = await sandbox2.listRuns();
assert.ok(runs.length >= 4, `execution history survives restart (${runs.length} runs)`);
const persisted2 = await ctx.blackboard.get("sandbox", "status");
assert.ok(persisted2.totalRuns >= 4, "status.totalRuns survives restart");
const ping2 = await sandbox2.ping();
assert.equal(ping2.ok, true, "ping works after restart");
ok("execution history + counters survive full tree restart");

console.log("== 守护不可达（降级模式） ==");
await ctx.fiber.dispose();
await mock.stop();
const deadPort = mock.port;
const ctx3 = await bootTree({ baseUrl: `http://127.0.0.1:${deadPort}`, healthCheckMs: 0, recordToBlackboard: true, allowedImages: [] });
const sandbox3 = ctx3.dockerSandbox;
const pingDead = await sandbox3.ping();
assert.equal(pingDead.ok, false, "ping reports unavailable");
assert.equal(pingDead.error.code, "EUNREACHABLE");
assert.equal(sandbox3.getAvailable(), false);
let runError = null;
try {
	await sandbox3.run({ cmd: ["true"] });
} catch (error) {
	runError = error;
}
assert.ok(runError, "run against dead daemon rejects");
assert.equal(runError.code, "EUNREACHABLE", "EUNREACHABLE surfaced to caller");
ok("daemon 不可达 → 降级模式 + run reject EUNREACHABLE");

await ctx3.fiber.dispose();
await rm(TMP, { recursive: true, force: true });
console.log(`\nALL ${passed} TESTS PASSED`);
//#endregion
