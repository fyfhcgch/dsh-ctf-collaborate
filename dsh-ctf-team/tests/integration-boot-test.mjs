//#region tests/integration-boot-test.mjs
/**
 * 集成装载测试：把 8 个 CTF 插件（blackboard / planner / sandbox /
 * crypto-expert / misc-expert / web-expert / verifier / submit-gateway）按
 * 真实 dsh profile 的组合方式一次性装进同一棵 cordis 树 —— 与 `dsh plugin
 * --profile web add link:...` 落盘后、dsh web 重启时的装载完全一致（依赖序
 * 由各插件 `static inject` 声明驱动，loader 自动等待）。
 *
 * 端到端冒烟（真实多 Agent 链路，无需 LLM）：
 *   planner.start(crypto 题目) → crypto-expert 认领 recon/analysis/exploit →
 *   base64 解出 CTF{crypto-done} → planner.submitFlag → verifier 自动校验
 *   (verified=true) → planner flag 收口任务 → planner/done。
 * 另外：mock Docker daemon 提供沙箱探测；webServer 用 stub 服务补齐
 * （submit-gateway 依赖 webServer，真实 profile 里由 dsh-web-app 提供）。
 *
 * Usage:  node tests/integration-boot-test.mjs
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { startMockDocker } from "../plugins/docker-sandbox-plugin/tests/mock-docker.mjs";
import { loadHarnessBoot } from "./harness-scope.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)); // D:\dsh-harness-ctf-agent\tests
const WORKSPACE = join(HERE, "..");
const TMP = join(HERE, ".tmp");
const PROFILE_DIR = join(TMP, "profile");
const DATA_FILE = join(TMP, "blackboard.integration.json");
const CONFIG_FILE = join(PROFILE_DIR, "cordis.yml");

const { boot } = await loadHarnessBoot();

/** 插件目录 → 包名（与 profile package.json dependencies 的落盘键一致）。 */
const PLUGINS = [
	["blackboard-plugin", "dsh-blackboard"],
	["planner-agent", "dsh-planner"],
	["crypto-expert-agent", "dsh-crypto-expert"],
	["misc-expert-agent", "dsh-misc-expert"],
	["web-expert-agent", "dsh-web-expert"],
	["verifier-agent", "dsh-verifier"],
	["submit-gateway", "dsh-submit-gateway"],
	["docker-sandbox-plugin", "dsh-docker-sandbox"]
];

/** 临时 profile 目录建 junction（等价 pnpm link: 的落盘结果）。 */
async function ensureProfileLinks() {
	const scope = join(PROFILE_DIR, "node_modules", "@dsh-external");
	await mkdir(scope, { recursive: true });
	const { symlink } = await import("node:fs");
	for (const [dir, pkg] of PLUGINS) {
		const link = join(scope, pkg);
		try {
			await stat(link);
		} catch {
			await new Promise((resolve, reject) => symlink(join(WORKSPACE, "plugins", dir), link, "junction", (error) => error ? reject(error) : resolve()));
		}
	}
	// webServer stub 包（真实 profile 由 dsh-web-app 提供；测试不装载 GUI）
	const stubLink = join(scope, "dsh-webserver-stub");
	try {
		await stat(stubLink);
	} catch {
		await new Promise((resolve, reject) => symlink(join(HERE, "stub-webserver-package"), stubLink, "junction", (error) => error ? reject(error) : resolve()));
	}
	await writeFile(CONFIG_FILE, "[]\n", "utf8");
}

/** 8 个插件行（与各 bundle 的 cordis.patch.yml 同构；测试覆盖配置）。 */
function composePatch(mockUrl) {
	return [
		{ insert: [{ id: "blackboard", name: "@dsh-external/dsh-blackboard", config: { file: DATA_FILE } }] },
		{
			insert: [{
				id: "planner",
				name: "@dsh-external/dsh-planner",
				config: {
					section: "planner",
					executionMode: "external", // 由各专家插件认领执行（真实多 Agent 链路）
					tickMs: 200,
					taskTimeoutMs: 60000,
					maxAttempts: 2,
					resumeOnStart: true,
					autoRun: true
				}
			}]
		},
		{ insert: [{ id: "cryptoExpert", name: "@dsh-external/dsh-crypto-expert", config: { autoClaim: true, resumeOnStart: true } }] },
		{ insert: [{ id: "miscExpert", name: "@dsh-external/dsh-misc-expert", config: { autoClaim: true, resumeOnStart: true } }] },
		{ insert: [{ id: "webExpert", name: "@dsh-external/dsh-web-expert", config: { autoClaim: true, resumeOnStart: true } }] },
		{ insert: [{ id: "verifier", name: "@dsh-external/dsh-verifier", config: { mode: "mock", autoVerify: true, dedupe: true } }] },
		{ insert: [{ id: "webServerStub", name: "@dsh-external/dsh-webserver-stub" }] },
		{ insert: [{ id: "submitGateway", name: "@dsh-external/dsh-submit-gateway" }] },
		{
			insert: [{
				id: "dockerSandbox",
				name: "@dsh-external/dsh-docker-sandbox",
				config: {
					section: "sandbox",
					baseUrl: mockUrl,
					healthCheckMs: 0,
					healthCheckOnStart: true,
					recordToBlackboard: true,
					allowedImages: []
				}
			}]
		}
	];
}

/** 轮询等待谓词成立；成立返回 true，超时抛错。 */
async function waitFor(predicate, timeoutMs = 30000, intervalMs = 100) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
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
const mock = await startMockDocker();

console.log("== boot：8 插件同树装载 ==");
let ctx = await boot("ctf-integration", CONFIG_FILE, composePatch(mock.url));

// webServer 由 stub 插件提供（装载期即就绪），submit-gateway 已随树激活
const registered = ctx.webServer.routes;

for (const [name, key] of [
	["blackboard", "blackboard"],
	["planner", "planner"],
	["cryptoExpert", "cryptoExpert"],
	["miscExpert", "miscExpert"],
	["webExpert", "webExpert"],
	["verifier", "verifier"],
	["submitGateway", "submitGateway"],
	["dockerSandbox", "dockerSandbox"]
]) {
	assert.ok(ctx[key], `ctx.${name} must be provided`);
}
assert.equal(registered.has("/api/ctf/submit"), true, "submit-gateway registered POST /api/ctf/submit on webServer stub");
assert.equal(ctx.dockerSandbox.getAvailable(), true, "sandbox probes the mock docker daemon during init");
ok("8 plugins loaded in one tree (blackboard→planner→experts→verifier→gateway→sandbox); sandbox ping ok");

console.log("== 端到端：crypto 题目 → 专家 → verifier → done ==");
const started = await ctx.planner.start({
	planId: "plan-integration-crypto",
	title: "Crypto Integration Test",
	description: "Decode the base64 ciphertext to reveal the flag.",
	ciphertext: "Q1RGe2NyeXB0by1kb25lfQ=="
});
assert.equal((await ctx.planner.getPlan(started.planId)).category, "crypto", "category detected as crypto");

const planDone = await waitFor(async () => {
	const plan = await ctx.planner.getPlan(started.planId);
	return plan?.status === "done";
}, 45000);
assert.ok(planDone);

const plan = await ctx.planner.getPlan(started.planId);
assert.ok(plan.tasks.every((t) => t.status === "done"), "all subtasks done");
const flagKeys = (await ctx.blackboard.keys("candidate_flags")).filter((k) => k.startsWith("plan-integration-crypto:"));
assert.ok(flagKeys.length > 0, "candidate flag recorded");
const flagEntry = await ctx.blackboard.get("candidate_flags", flagKeys[0]);
assert.equal(flagEntry.flag, "CTF{crypto-done}", "flag solved by crypto-expert");
assert.equal(flagEntry.verified, true, "flag verified by verifier");
assert.equal(flagEntry.duplicate !== true, true, "not a duplicate");
const exploitOutputs = await ctx.blackboard.get("tool_outputs", "plan-integration-crypto:t3");
assert.ok(Array.isArray(exploitOutputs) && exploitOutputs.length > 0, "tool_outputs from crypto-expert exploit");
ok("crypto-expert 求解 → verifier 校验 → planner flag 收口 → plan done (verified flag)");

console.log("== submit-gateway 服务 API ==");
const gatewayResult = await ctx.submitGateway.submit({
	title: "Gateway Test",
	description: "A misc challenge about base64 encoding.",
	ciphertext: "Q1RGe2dhbGV3YXktb2t9"
});
assert.equal(gatewayResult.ok, true, "submitGateway.submit returns ok");
assert.ok(gatewayResult.planId, "plan started via gateway");
await waitFor(async () => {
	const p = await ctx.planner.getPlan(gatewayResult.planId);
	return p?.status === "done" || p?.status === "failed";
}, 45000);
const gatewayPlan = await ctx.planner.getPlan(gatewayResult.planId);
assert.equal(gatewayPlan.status, "done", "gateway plan completes");
ok("submit-gateway API 启动计划并完成");

console.log("== sandbox 与黑板上报 ==");
const sandboxStatus = await ctx.blackboard.get("sandbox", "status");
assert.equal(sandboxStatus.available, true, "sandbox/status persisted");
assert.equal(sandboxStatus.totalRuns, 0, "no sandbox run executed in this integration flow (ping only)");
ok("sandbox/status persisted through blackboard");

console.log("== boot 2：重启持久（计划/flag/sandbox 状态） ==");
await ctx.fiber.dispose();
ctx = await boot("ctf-integration", CONFIG_FILE, composePatch(mock.url));

const planAfter = await ctx.planner.getPlan("plan-integration-crypto");
assert.equal(planAfter.status, "done", "done plan survives restart");
const flagAfter = await ctx.blackboard.get("candidate_flags", flagKeys[0]);
assert.equal(flagAfter.flag, "CTF{crypto-done}", "verified flag survives restart");
const sandboxStatusAfter = await ctx.blackboard.get("sandbox", "status");
assert.equal(sandboxStatusAfter.totalRuns, 0, "sandbox counters survive restart");
ok("全部状态（计划/flag/verifier/sandbox）重启后仍在");

await ctx.fiber.dispose();
await mock.stop();
await rm(TMP, { recursive: true, force: true });
console.log(`\nALL ${passed} INTEGRATION TESTS PASSED`);
//#endregion
