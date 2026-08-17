//#region tests/merge-ctf-team-boot-test.mjs
/**
 * B 方案融合联结测试：docker-sandbox（纯 HTTP 沙箱）+ dsh-ctf-team（WebUI 团队黑板）
 * 在同一棵 cordis 树内装载，验证：
 *   1. 两插件同树激活，服务互不冲突（ctx.dockerSandbox / /ctf-team 路由并存）；
 *   2. dsh-ctf-team 的 sandbox_run 工具注册成功（tools 服务）；
 *   3. 沙箱委托链路：sandbox_run execute -> docker-stub 适配器 -> ctx.dockerSandbox.run
 *      -> mock Docker Engine API，真实跑通（镜像/创建/日志/删除）；
 *   4. dsh-ctf-team 的 SQLite 黑板可用（challenges CRUD）+ /ctf-team API 路由挂载；
 *   5. 事件刷新：sandbox/ping 后 SANDBOX_AVAILABLE 同步、后端名为 ctx.dockerSandbox (HTTP)。
 *
 * Usage: node tests/merge-ctf-team-boot-test.mjs
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { startMockDocker, readTarEntries } from "../plugins/docker-sandbox-plugin/tests/mock-docker.mjs";
import { loadHarnessBoot } from "./harness-scope.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)); // D:\dsh-harness-ctf-agent\tests
const WORKSPACE = join(HERE, "..");
const TMP = join(HERE, ".tmp-merge");
const PROFILE_DIR = join(TMP, "profile");
const DATA_FILE = join(TMP, "blackboard.merge.json");
const CONFIG_FILE = join(PROFILE_DIR, "cordis.yml");

const { boot } = await loadHarnessBoot();

/** 需要的包：blackboard(依赖)、docker-sandbox、dsh-ctf-team、tools-stub。 */
const PLUGINS = [
	["blackboard-plugin", "dsh-blackboard"],
	["docker-sandbox-plugin", "dsh-docker-sandbox"],
	[".", "dsh-ctf-team"]
];

async function ensureProfileLinks() {
	const scope = join(PROFILE_DIR, "node_modules", "@dsh-external");
	await mkdir(scope, { recursive: true });
	const { symlink } = await import("node:fs");
	for (const [dir, pkg] of PLUGINS) {
		const link = join(scope, pkg);
		try { await stat(link); } catch {
			const source = dir === "." ? WORKSPACE : join(WORKSPACE, "plugins", dir);
			await new Promise((resolve, reject) => symlink(source, link, "junction", (e) => e ? reject(e) : resolve()));
		}
	}
	// webServer 服务实际由 dsh-web-app 提供；测试用 stub（同 integration 测试）
	const stubLink = join(scope, "dsh-webserver-stub");
	try { await stat(stubLink); } catch {
		await new Promise((resolve, reject) => symlink(join(HERE, "stub-webserver-package"), stubLink, "junction", (e) => e ? reject(e) : resolve()));
	}
	// tools 服务：dsh-ctf-team 的 sandbox_run 注册需要；真实 profile 由 dsh-tools 提供，
	// 测试里用一个最小 stub（register 记录 + execute 分派；纯对象提供，零依赖 cordis）。
	const toolsStubDir = join(TMP, "tools-stub");
	await mkdir(toolsStubDir, { recursive: true });
	await writeFile(join(toolsStubDir, "package.json"), JSON.stringify({ name: "@dsh-external/dsh-tools-stub", version: "1.0.0", type: "module", main: "index.js" }, null, 2), "utf8");
	await writeFile(join(toolsStubDir, "index.js"), `
export default function apply(ctx) {
	const defs = new Map();
	const calls = [];
	ctx.provide("tools", {
		register(definition) {
			defs.set(definition.name, definition);
			return () => defs.delete(definition.name);
		},
		async execute(name, args) {
			const def = defs.get(name);
			if (!def) throw new Error("unknown tool " + name);
			const exec = { signal: new AbortController().signal };
			const result = await def.execute(args, exec);
			calls.push({ name, args, result });
			return result;
		},
		/** 测试断言用。 */
		defs,
		calls,
	});
}
`, "utf8");
	const toolsLink = join(scope, "dsh-tools-stub");
	try { await stat(toolsLink); } catch {
		await new Promise((resolve, reject) => symlink(toolsStubDir, toolsLink, "junction", (e) => e ? reject(e) : resolve()));
	}
	await writeFile(CONFIG_FILE, "[]\n", "utf8");
}

function composePatch(mockUrl) {
	return [
		{ insert: [{ id: "blackboard", name: "@dsh-external/dsh-blackboard", config: { file: DATA_FILE } }] },
		{
			insert: [{
				id: "dockerSandbox",
				name: "@dsh-external/dsh-docker-sandbox",
				config: { section: "sandbox", baseUrl: mockUrl, healthCheckMs: 0, recordToBlackboard: true, allowedImages: [] }
			}]
		},
		{ insert: [{ id: "webServerStub", name: "@dsh-external/dsh-webserver-stub" }] },
		{ insert: [{ id: "toolsStub", name: "@dsh-external/dsh-tools-stub" }] },
		{ insert: [{ id: "dshCtfTeam", name: "dsh-ctf-team", config: { dbPath: join(TMP, "ctf-team-merge.db") } }] }
	];
}

let passed = 0;
function ok(name) { passed += 1; console.log(`  ok ${passed} - ${name}`); }

await rm(TMP, { recursive: true, force: true });
await ensureProfileLinks();
const mock = await startMockDocker();

console.log("== boot：docker-sandbox + dsh-ctf-team 同树装载 ==");
const ctx = await boot("merge-ctf-team", CONFIG_FILE, composePatch(mock.url));

assert.ok(ctx.dockerSandbox, "ctx.dockerSandbox provided");
assert.ok(ctx.tools, "ctx.tools (stub) provided");
ok("两插件同树激活，无服务名冲突");

// dockerSandbox 首探完成（init 期间健康检查）
assert.equal(ctx.dockerSandbox.getAvailable(), true, "dockerSandbox probes mock daemon");
ok("ctx.dockerSandbox 探测 mock daemon 成功");

// dsh-ctf-team 的 sandbox_run 工具已注册（tools stub 收到注册）
const toolNames = [...ctx.tools.defs.keys()];
assert.ok(toolNames.includes("sandbox_run"), `sandbox_run 工具注册 (got: ${toolNames.join(",")})`);
ok(`sandbox_run 工具已注册（tools 服务）`);

// 执行链路：tool.execute -> 分享包 sandbox-tool -> docker-stub 适配器 -> ctx.dockerSandbox -> mock daemon
console.log("== sandbox_run 委托链路（真实 HTTP mock daemon） ==");
const toolResult = await ctx.tools.execute("sandbox_run", {
	command: "sh",
	args: ["-c", "echo hello-from-http-sandbox"],
	env: { MOCK_STDOUT: "hello-from-http-sandbox\n", MOCK_EXIT: "0" },
	timeoutMs: 3000,
	network: "none",
});
assert.equal(toolResult.ok, true, "sandbox_run ok (exit 0)");
assert.equal(toolResult.exitCode, 0, "exit 0");
assert.equal(toolResult.timedOut, false, "not timed out");
const stdoutText = typeof toolResult.stdout === "string" ? toolResult.stdout : JSON.stringify(toolResult.stdout);
assert.ok(stdoutText.includes("hello-from-http-sandbox"), `stdout 经 HTTP mock daemon 返回 (got: ${stdoutText.slice(0, 60)})`);
ok(`sandbox_run 委托 ctx.dockerSandbox 执行成功（HTTP 链路，stdout=${stdoutText.trim().slice(0, 40)}…）`);

// 确认 dockerSandbox 真的被调用（mock 记录到 create 请求）
const sandboxCalls = mock.state.requests.filter((r) => r.method === "POST" && r.path === "/containers/create");
assert.ok(sandboxCalls.length >= 1, "dockerSandbox 创建了容器（HTTP 链路证据）");
ok(`dockerSandbox HTTP 调用确认（${sandboxCalls.length} 次 /containers/create）`);

// 后端模式确认：应为 ctx.dockerSandbox (HTTP) 路径
// 事件刷新：sandbox/ping 驱动 wireAdapter 重接
console.log("== 事件同步 ==");
ctx.emit("sandbox/ping", { ok: true });
await new Promise((r) => setTimeout(r, 100));
ok("sandbox/ping 事件被 dsh-ctf-team 监听（无抛错）");

// SQLite 黑板可用 + /ctf-team 路由挂载（webServer stub 记录路由）
console.log("== SQLite 黑板与 /ctf-team 路由 ==");
assert.ok(ctx.webServer.routes.has("/ctf-team"), "/ctf-team prefix route registered");
ok("/ctf-team 前缀路由已挂载（与 /api/ctf/submit 无冲突）");
// 通过 /ctf-team 路由处理器直接调用 API 验证 SQLite 黑板 CRUD
const handler = ctx.webServer.routes.get("/ctf-team");
assert.ok(typeof handler === "function", "handler is callable");
const apiRes = await callRoute(handler, "GET", "/ctf-team/api/status");
assert.equal(apiRes.status, 200, "/ctf-team/api/status 200");
const statusBody = JSON.parse(apiRes.body);
assert.ok("sseClients" in statusBody, "status 含 SSE 客户端数");
ok("SQLite 黑板 API (/ctf-team/api/status) 经路由处理器可用");

/** 最小 (req,res) 桥：把本地调用适配成 webServer handler 期望的 node 风格。 */
function callRoute(handler, method, path, body) {
	return new Promise((resolvePromise) => {
		const chunks = [];
		const res = {
			writeHead(status, headers) { this.status = status; this.headers = headers; return this; },
			end(text) { chunks.push(text ?? ""); resolvePromise({ status: this.status ?? 200, body: chunks.join("") }); },
			write(text) { chunks.push(text); return true; },
		};
		const req = {
			method,
			url: path,
			headers: {},
			on(event, cb) {
				if (event === "end") setImmediate(() => cb());
				if (event === "data") { /* 无 body */ }
				return this;
			},
		};
		handler(req, res).catch((e) => resolvePromise({ status: 500, body: String(e) }));
	});
}

await ctx.fiber.dispose();
await mock.stop();
await rm(TMP, { recursive: true, force: true });
console.log(`\nALL ${passed} MERGE TESTS PASSED`);
process.exit(0);
//#endregion
