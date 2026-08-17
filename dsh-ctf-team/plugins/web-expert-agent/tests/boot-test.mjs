//#region tests/boot-test.mjs
/**
 * 独立启动测试：@dsh-external/dsh-web-expert
 *
 * 用真实 @deepseek-ai/dsh-app-boot 的 `boot()` 挂载 blackboard + planner +
 * verifier + web-expert 四行（与 dsh profile boot 一致）。目标靶场为本地
 * 回环 HTTP 服务器（127.0.0.1 随机端口，直连不走代理）。覆盖：
 *   A. recon：指纹/信息文件探测 → clues/tool_outputs + task-done
 *   B. audit：目录爆破 + 备份/源码泄露 → flag 提取 → verifier 自动校验
 *   C. exploit：SQLi / LFI / SSTI payload 命中
 *   D. planner 自动认领（external 模式 task-update(running) → 接管执行）
 *   E. 异常：连接拒绝 / 超时 → failures + task-fail + planner.failTask
 *   F. 取消：cancelTask → cancelled
 *   G. 重启恢复：running 任务中断 → 标记 interrupt → 重新调度完成
 *   H. 无直接文件写入（tmp 仅 blackboard 数据文件）
 *
 * 用法：node plugins/web-expert-agent/tests/boot-test.mjs
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { loadHarnessBoot } from "../../../tests/harness-scope.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");
const TMP = join(HERE, ".tmp");
const PROFILE_DIR = join(TMP, "profile");
const CONFIG_FILE = join(PROFILE_DIR, "cordis.yml");
const BB_FILE = join(TMP, "blackboard.test.json");

const { boot } = await loadHarnessBoot();

async function ensureProfileLinks() {
	await mkdir(join(PROFILE_DIR, "node_modules", "@dsh-external"), { recursive: true });
	await mkdir(join(PLUGIN_ROOT, "node_modules", "@deepseek-ai"), { recursive: true });
	const { symlink } = await import("node:fs");
	for (const [name, dir] of [["dsh-blackboard", "blackboard-plugin"], ["dsh-planner", "planner-agent"], ["dsh-verifier", "verifier-agent"], ["dsh-web-expert", "web-expert-agent"]]) {
		const link = join(PROFILE_DIR, "node_modules", "@dsh-external", name);
		try {
			await stat(link);
		} catch {
			await new Promise((resolve, reject) => symlink(join(PLUGIN_ROOT, "..", dir), link, "junction", (error) => error ? reject(error) : resolve()));
		}
	}
	await writeFile(CONFIG_FILE, "[]\n", "utf8");
}

/** 四行 patch，配置可覆盖。 */
function fourRowPatch({ bbFile = BB_FILE, plannerConfig = {}, verifierConfig = {}, webExpertConfig = {} } = {}) {
	return [{
		insert: [
			{ id: "blackboard", name: "@dsh-external/dsh-blackboard", config: { file: bbFile } },
			{ id: "planner", name: "@dsh-external/dsh-planner", config: { ...plannerConfig } },
			{ id: "verifier", name: "@dsh-external/dsh-verifier", config: { ...verifierConfig } },
			{ id: "webExpert", name: "@dsh-external/dsh-web-expert", config: { ...webExpertConfig } }
		]
	}];
}

function bootTree(options) {
	return boot("web-expert-test", CONFIG_FILE, fourRowPatch(options));
}

async function waitFor(predicate, timeoutMs = 25000, intervalMs = 40) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error("waitFor: 条件在超时内未满足");
}

let passed = 0;
function ok(name) {
	passed += 1;
	console.log(`  ok ${passed} - ${name}`);
}

/** 跟踪所有本地靶场服务器，脚本结束前统一关闭（避免 node 事件循环挂起）。 */
const servers = [];
async function closeAllServers() {
	for (const s of servers) {
		try { s.close(); } catch { /* 已关闭 */ }
	}
	await new Promise((resolve) => setTimeout(resolve, 150));
}

//#region 本地回环靶场（模拟 web CTF 题目；slow=true 时所有请求延迟 5s）
async function startTarget({ slow = false, delayMs = 5000 } = {}) {
	const server = http.createServer((req, res) => {
		const u = new URL(req.url, "http://127.0.0.1");
		const path = u.pathname;
		const send = (status, body, headers = {}) => {
			const done = () => {
				res.writeHead(status, headers);
				res.end(body);
			};
			if (slow) setTimeout(done, delayMs);
			else done();
		};
		if (path === "/") {
			send(200, "<html><head><title>flag shop</title></head><body><h1>Welcome</h1></body></html>", { "Server": "Werkzeug/2.0.1", "Set-Cookie": "session=abc123" });
		} else if (path === "/robots.txt") {
			send(200, "User-agent: *\nDisallow: /admin\n");
		} else if (path === "/admin") {
			send(403, "Forbidden");
		} else if (path === "/secret/flag.txt") {
			send(200, "the flag is CTF{web-expert-local-flag}\n");
		} else if (path === "/config.php.bak") {
			send(200, "<?php $db_pass='s3cret'; ?>\n");
		} else if (path === "/debug") {
			const name = u.searchParams.get("name") ?? "";
			if (name.includes("{{7*7}}") || name.includes("${7*7}")) send(200, "hello 49");
			else send(200, `hello ${name.slice(0, 50)}`);
		} else if (path === "/search") {
			const id = u.searchParams.get("id") ?? "";
			if (id.includes("'")) send(500, "<pre>SQL syntax error near '1' at line 1: SELECT * FROM items WHERE id = '1''</pre>");
			else send(200, `item ${id}`);
		} else if (path === "/download") {
			const file = u.searchParams.get("file") ?? "";
			if (file.includes("etc/passwd")) send(200, "root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\n");
			else send(404, "not found");
		} else {
			send(404, "not found");
		}
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			servers.push(server);
			resolve({ server, port: server.address().port, base: `http://127.0.0.1:${server.address().port}` });
		});
	});
}
//#endregion

await rm(TMP, { recursive: true, force: true });
await ensureProfileLinks();

const target = await startTarget();
const challengeCtx = { url: target.base, description: "一个 web 题目：flag shop，存在 SQL 注入与模板注入。", attachments: [] };
const WEB_DESC = `一个 web 题目：flag shop，存在 SQL 注入。站点地址 ${target.base}`;

//#region A. recon
console.log("== A. recon 信息探测 ==");
let ctx = await bootTree({ webExpertConfig: { autoClaim: false } });
assert.ok(ctx.webExpert, "ctx.webExpert 必须可用（inject 已解析 blackboard+planner）");
const evA = [];
ctx.on("web-expert/task-done", (p) => evA.push(p));
ctx.on("web-expert/task-progress", (p) => evA.push(["progress", p]));
await ctx.emit("web-expert/execute-task", {
	planId: "plan-web",
	task: { id: "t1", phase: "recon", title: "信息收集", description: "站点基础信息探测" },
	challenge: challengeCtx
});
await waitFor(() => evA.some((p) => p?.taskId === "t1" && p?.result?.status === "done"));
const cluesA = await ctx.blackboard.get("clues", "plan-web:t1:notes");
assert.ok(cluesA.some((c) => JSON.stringify(c.clue).includes("Werkzeug")), "指纹识别出 Werkzeug");
assert.ok(cluesA.some((c) => JSON.stringify(c.clue).includes("robots.txt")), "robots.txt 发现写入 clues");
const toolsA = await ctx.blackboard.get("tool_outputs", "plan-web:t1");
assert.ok(toolsA.some((t) => t.output.includes("GET /")), "首页请求回显写入 tool_outputs");
const stateA = await ctx.webExpert.getTaskState("plan-web", "t1");
assert.equal(stateA.status, "done");
ok("recon：指纹/robots.txt → clues/tool_outputs，task-done，状态持久化");

await ctx.fiber.dispose();
//#endregion

//#region B. audit + flag 提取 + verifier 校验
console.log("== B. audit 目录爆破 + flag 全链路 ==");
ctx = await bootTree({ webExpertConfig: { autoClaim: false } });
const evB = [];
ctx.on("web-expert/task-done", (p) => evB.push(p));
ctx.on("verifier/verified-ok", (p) => evB.push(["vok", p]));
await ctx.webExpert.executeTask({
	planId: "plan-audit",
	task: { id: "t2", phase: "audit", title: "目录爆破与源码泄露审计", description: "内置字典目录爆破" },
	challenge: challengeCtx
});
const cluesB = await ctx.blackboard.get("clues", "plan-audit:t2:notes");
assert.ok(cluesB.some((c) => JSON.stringify(c.clue).includes("/secret/flag.txt")), "目录爆破发现 /secret/flag.txt");
assert.ok(cluesB.some((c) => JSON.stringify(c.clue).includes("/config.php.bak")), "备份文件 /config.php.bak 命中");
await waitFor(async () => {
	const hit = (await ctx.blackboard.search("CTF{web-expert-local-flag}")).find((h) => h.section === "candidate_flags");
	return hit?.value?.verified === true;
}, 30000);
ok("audit：目录爆破+泄露审计 → clues；flag 提取 → candidate_flags → verifier 自动校验通过");

await ctx.fiber.dispose();
//#endregion

//#region C. exploit（SQLi/LFI/SSTI）
console.log("== C. exploit payload 集合 ==");
ctx = await bootTree({ webExpertConfig: { autoClaim: false } });
const evC = [];
ctx.on("web-expert/task-done", (p) => evC.push(p));
const resultC = await ctx.webExpert.executeTask({
	planId: "plan-exp",
	task: { id: "t3", phase: "exploit", title: "payload 尝试利用", description: "SQLi/LFI/SSTI" },
	challenge: { url: target.base, description: "web 题目", attachments: [] }
});
const kinds = (resultC.findings ?? []).map((f) => f.kind);
assert.ok(kinds.includes("ssti"), "SSTI 命中（{{7*7}} → 49）");
assert.ok(kinds.includes("sqli"), "SQLi 命中（报错特征）");
assert.ok(kinds.includes("lfi"), "LFI 命中（/etc/passwd）");
const toolsC = await ctx.blackboard.get("tool_outputs", "plan-exp:t3");
assert.ok(toolsC.some((t) => t.output.includes("[ssti]")), "SSTI 回显写入 tool_outputs");
assert.ok(toolsC.some((t) => t.output.includes("[sqli]")), "SQLi 回显写入 tool_outputs");
assert.ok(toolsC.some((t) => t.output.includes("[lfi]")), "LFI 回显写入 tool_outputs");
ok("exploit：内置 SQLi/LFI/SSTI payload 全部命中并记录回显");

await ctx.fiber.dispose();
//#endregion

//#region D. planner 自动认领（external 模式）
console.log("== D. planner 自动认领 ==");
ctx = await bootTree({
	plannerConfig: { executionMode: "external", taskTimeoutMs: 60000, tickMs: 50, maxAttempts: 1 },
	webExpertConfig: { autoClaim: true }
});
await ctx.planner.start({ planId: "plan-claim", title: "claim-web", description: WEB_DESC });
await waitFor(async () => {
	const p = await ctx.planner.getPlan("plan-claim");
	return p.tasks.find((t) => t.id === "t1")?.status === "done";
}, 30000);
const claimPlan = await ctx.planner.getPlan("plan-claim");
assert.equal(claimPlan.tasks.find((t) => t.id === "t1").status, "done", "recon 任务被 web-expert 认领完成");
const stateD = await ctx.webExpert.getTaskState("plan-claim", "t1");
assert.equal(stateD.status, "done");
ok("planner 置 running → web-expert 自动认领执行 → completeTask 回报完成");

await ctx.fiber.dispose();
//#endregion

//#region E. 异常（连接拒绝 / 超时）
console.log("== E. 异常处理 ==");
// E1: 连接拒绝
const closed = await startTarget();
closed.server.close();
await new Promise((r) => setTimeout(r, 200));
ctx = await bootTree({ webExpertConfig: { autoClaim: false } });
const evE = [];
ctx.on("web-expert/task-fail", (p) => evE.push(p));
let failed = await ctx.webExpert.executeTask({
	planId: "plan-refused",
	task: { id: "t1", phase: "recon", title: "recon", description: "x" },
	challenge: { url: closed.base, description: "web 题目", attachments: [] }
}).catch((e) => e?.status === "failed" ? { status: "failed", error: e } : { status: "failed", error: e });
const failRecs = await ctx.blackboard.get("failures", "plan-refused:t1");
assert.ok(failRecs?.some((f) => f.type === "web-expert-error" && f.code === "ECONNREFUSED"), "连接拒绝写入 failures(ECONNREFUSED)");
assert.ok(evE.some((p) => p.taskId === "t1" && p.reason === "ECONNREFUSED"), "task-fail 事件发出");
assert.equal((await ctx.webExpert.getTaskState("plan-refused", "t1")).status, "failed");
ok("连接拒绝 → failures + task-fail + 任务状态 failed");

// E2: 超时（慢服务器 + 短 timeout）
await ctx.fiber.dispose();
const slow = await startTarget({ slow: true, delayMs: 5000 });
ctx = await bootTree({ webExpertConfig: { autoClaim: false, timeoutMs: 300 } });
const evE2 = [];
ctx.on("web-expert/task-fail", (p) => evE2.push(p));
await ctx.webExpert.executeTask({
	planId: "plan-timeout",
	task: { id: "t1", phase: "recon", title: "recon", description: "x" },
	challenge: { url: slow.base, description: "web 题目", attachments: [] }
}).catch(() => {});
await waitFor(() => evE2.some((p) => p.taskId === "t1"));
const timeoutRecs = await ctx.blackboard.get("failures", "plan-timeout:t1");
assert.ok(timeoutRecs?.some((f) => f.code === "ETIMEDOUT"), "超时写入 failures(ETIMEDOUT)");
ok("请求超时 → failures(ETIMEDOUT) + task-fail");
await ctx.fiber.dispose();
//#endregion

//#region F. 取消
console.log("== F. 取消 ==");
ctx = await bootTree({ webExpertConfig: { autoClaim: false, timeoutMs: 15000, maxDirProbe: 8 } });
const pending = ctx.webExpert.executeTask({
	planId: "plan-cancel",
	task: { id: "t2", phase: "audit", title: "audit", description: "x" },
	challenge: { url: slow.base, description: "web 题目", attachments: [] }
}).catch(() => ({ status: "cancelled" }));
await waitFor(async () => (await ctx.webExpert.getTaskState("plan-cancel", "t2"))?.status === "running");
await ctx.webExpert.cancelTask("plan-cancel", "t2");
const outcomeF = await pending;
assert.equal(outcomeF.status, "cancelled", "取消后任务以 cancelled 结束");
assert.equal((await ctx.webExpert.getTaskState("plan-cancel", "t2")).status, "cancelled");
ok("cancelTask → 步骤边界中止 → cancelled");
slow.server.close();
await ctx.fiber.dispose();
//#endregion

//#region G. 重启断点恢复
console.log("== G. 重启断点恢复 ==");
const RESUME_BB = join(TMP, "blackboard.resume.json");
// boot1：慢服务器上 audit 执行中 → dispose（模拟 harness 崩溃）
const slow2 = await startTarget({ slow: true, delayMs: 8000 });
ctx = await bootTree({ bbFile: RESUME_BB, webExpertConfig: { autoClaim: false, timeoutMs: 20000, maxDirProbe: 8 } });
// 挑战上下文落 blackboard（重启恢复时据此重新执行）
await ctx.blackboard.set("challenges", "plan-resume", { planId: "plan-resume", title: "resume-web", description: "web 题目", attachments: [], url: slow2.base });
const runningTask = ctx.webExpert.executeTask({
	planId: "plan-resume",
	task: { id: "t2", phase: "audit", title: "audit", description: "x" },
	challenge: { url: slow2.base, description: "web 题目", attachments: [] }
}).catch(() => ({ status: "failed" }));
await waitFor(async () => (await ctx.webExpert.getTaskState("plan-resume", "t2"))?.status === "running");
const before = await ctx.webExpert.getTaskState("plan-resume", "t2");
assert.equal(before.status, "running");
ok(`boot1：audit 任务执行中（running）`);

// "harness 重启"：拆掉整树；blackboard 数据文件保留
await ctx.fiber.dispose();
const targetPort = slow2.server.address().port;
slow2.server.close();
await new Promise((r) => setTimeout(r, 300));

// 同一端口重建"快"靶场（恢复后能真正执行完）
function createFastHandler() {
	return (req, res) => {
		const u = new URL(req.url, "http://127.0.0.1");
		const send = (status, body, headers = {}) => { res.writeHead(status, headers); res.end(body); };
		if (u.pathname === "/") send(200, "<html><title>flag shop</title></html>", { "Server": "Werkzeug/2.0.1" });
		else if (u.pathname === "/secret/flag.txt") send(200, "flag CTF{resume-ok-flag}");
		else if (u.pathname === "/robots.txt") send(200, "User-agent: *");
		else send(404, "not found");
	};
}
const rebound = await new Promise((resolve) => {
	const s = http.createServer(createFastHandler());
	s.listen(targetPort, "127.0.0.1", () => resolve(s));
});

// boot2：同一 blackboard 文件 → 重启恢复（interrupt → 重新调度 → 完成）
ctx = await bootTree({ bbFile: RESUME_BB, webExpertConfig: { autoClaim: false, timeoutMs: 5000, maxDirProbe: 8 } });
await waitFor(async () => (await ctx.webExpert.getTaskState("plan-resume", "t2"))?.status === "done", 30000);
const after = await ctx.webExpert.getTaskState("plan-resume", "t2");
assert.equal(after.status, "done", "恢复后任务重新调度并完成");
const resumeFailures = await ctx.blackboard.get("failures", "plan-resume:t2");
assert.ok(resumeFailures?.some((f) => f.type === "web-expert-interrupt"), "中断记录写入 failures(web-expert-interrupt)");
ok("重启恢复：running 任务标记 interrupt → 重新调度 → 完成（web-expert-interrupt 留痕）");
rebound.close();
await ctx.fiber.dispose();
//#endregion

//#region H. 无直接文件写入
console.log("== H. 无直接文件写入 ==");
const stray = (await readdir(TMP)).filter((name) => !name.startsWith("blackboard.") && name !== "profile");
assert.deepEqual(stray, [], `web-expert 不应直接写文件（发现: ${stray.join(", ")}）`);
ok("web-expert 全部读写经 blackboard，无直接磁盘文件写入");
//#endregion

await closeAllServers();
await rm(TMP, { recursive: true, force: true });
console.log(`\nALL ${passed} TESTS PASSED`);
// 显式退出：确保所有本地服务器/挂起句柄关闭后进程立即结束，绝不残留
process.exit(0);
//#endregion
