//#region tests/boot-test.mjs
/**
 * 独立启动测试：@dsh-external/dsh-verifier
 *
 * 用真实 @deepseek-ai/dsh-app-boot 的 `boot()` 挂载 blackboard + planner +
 * verifier 三行（与 dsh profile boot 完全一致的机制）。覆盖：
 *   A. 自动抓取 + mock 校验通过（planner 提交流程全链路）
 *   B. 格式错误 / 占位符 flag → verified:false + failures + verified-fail
 *   C. 重复 flag 自动去重 → duplicate-flag
 *   D. mockRejectPattern 模拟提交被拒 → verifier-reject 失败记录
 *   E. planner 联动：校验通过 → completeTask（external 模式）；全部失败 → failTask → planner/fail
 *   F. 重启恢复：宕机期间写入的未校验 flag，重启后自动补校验
 *   G. 服务 API + 命令事件（verifyOne/verifyAll/getVerifiedFlags/clearCache/submit-one/run）
 *   H. 禁止直接写文件（tmp 目录只允许 blackboard 数据文件）
 *
 * 用法：node plugins/verifier-agent/tests/boot-test.mjs
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { loadHarnessBoot } from "../../../tests/harness-scope.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");
const TMP = join(HERE, ".tmp");
const PROFILE_DIR = join(TMP, "profile");
const CONFIG_FILE = join(PROFILE_DIR, "cordis.yml");
const BB_FILE = join(TMP, "blackboard.test.json");

const { boot } = await loadHarnessBoot();

/** 挂载三个插件（junction 到各自外部插件目录）。 */
async function ensureProfileLinks() {
	await mkdir(join(PROFILE_DIR, "node_modules", "@dsh-external"), { recursive: true });
	await mkdir(join(PLUGIN_ROOT, "node_modules", "@deepseek-ai"), { recursive: true });
	const { symlink } = await import("node:fs");
	for (const [name, dir] of [["dsh-blackboard", "blackboard-plugin"], ["dsh-planner", "planner-agent"], ["dsh-verifier", "verifier-agent"]]) {
		const link = join(PROFILE_DIR, "node_modules", "@dsh-external", name);
		try {
			await stat(link);
		} catch {
			await new Promise((resolve, reject) => symlink(join(PLUGIN_ROOT, "..", dir), link, "junction", (error) => error ? reject(error) : resolve()));
		}
	}
	await writeFile(CONFIG_FILE, "[]\n", "utf8");
}

/** 三行 patch，配置可覆盖。 */
function threeRowPatch({ bbFile = BB_FILE, plannerConfig = {}, verifierConfig = {} } = {}) {
	return [{
		insert: [
			{ id: "blackboard", name: "@dsh-external/dsh-blackboard", config: { file: bbFile } },
			{ id: "planner", name: "@dsh-external/dsh-planner", config: { ...plannerConfig } },
			{ id: "verifier", name: "@dsh-external/dsh-verifier", config: { ...verifierConfig } }
		]
	}];
}

function bootTree(options) {
	return boot("verifier-test", CONFIG_FILE, threeRowPatch(options));
}

async function waitFor(predicate, timeoutMs = 20000, intervalMs = 40) {
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

const iso = () => new Date().toISOString();

await rm(TMP, { recursive: true, force: true });
await ensureProfileLinks();

//#region A. 自动抓取 + mock 校验通过（planner 全链路）
console.log("== A. 自动抓取 + mock 校验通过 ==");
let ctx = await bootTree({
	plannerConfig: { executionMode: "internal", internalDelayMs: 40, tickMs: 50, maxAttempts: 2 },
	verifierConfig: { mode: "mock", autoVerify: true }
});
assert.ok(ctx.verifier, "ctx.verifier 必须可用（inject 已解析 blackboard+planner）");
const evA = [];
for (const n of ["verifier/verified-ok", "verifier/verified-fail", "verifier/duplicate-flag", "verifier/error"]) ctx.on(n, (p) => evA.push([n, p]));

await ctx.emit("planner/start", {
	planId: "plan-a",
	title: "verifier-demo",
	description: "一个 web 题目，拿到 flag CTF{verifier-ok-flag}。"
});
await waitFor(async () => (await ctx.planner.getPlan("plan-a"))?.status === "done");
const planA = await ctx.planner.getPlan("plan-a");
assert.equal(planA.status, "done", "planner 内部执行器完成计划");
await waitFor(async () => {
	const entry = await ctx.blackboard.get("candidate_flags", (await ctx.blackboard.keys("candidate_flags")).find((k) => k.startsWith("plan-a:")) ?? "");
	return entry?.verified === true;
});
const flagKey = (await ctx.blackboard.keys("candidate_flags")).find((k) => k.startsWith("plan-a:"));
const entryA = await ctx.blackboard.get("candidate_flags", flagKey);
assert.equal(entryA.flag, "CTF{verifier-ok-flag}");
assert.equal(entryA.verified, true);
assert.ok(entryA.verify_msg.includes("模拟校验通过"), `verify_msg=${entryA.verify_msg}`);
assert.ok(evA.some(([n, p]) => n === "verifier/verified-ok" && p.flag === "CTF{verifier-ok-flag}"), "verified-ok 事件已发出");
const seenKeys = (await ctx.blackboard.keys("verifier")).filter((k) => k.startsWith("seen:"));
assert.equal(seenKeys.length, 1, "去重缓存已记录");
ok("planner 提交的 flag 被自动抓取并 mock 校验通过，verified/verify_msg/seen 全部落 blackboard");

// 服务 API
const verified = await ctx.verifier.getVerifiedFlags({ planId: "plan-a" });
assert.equal(verified.length, 1);
assert.equal(verified[0].flag, "CTF{verifier-ok-flag}");
const again = await ctx.verifier.verifyOne({ key: flagKey });
assert.equal(again.status, "already", "已校验条目幂等跳过");
const summary = await ctx.verifier.verifyAll();
assert.ok(summary.total >= 1 && summary.already >= 1);
ok("getVerifiedFlags / verifyOne(幂等) / verifyAll 服务 API 正常");

// verifier/submit-one 命令事件（登记并校验一个全新 flag）
ctx.emit("verifier/submit-one", { planId: "plan-a", flag: "CTF{submit-one-ok}" });
await waitFor(async () => (await ctx.blackboard.search("CTF{submit-one-ok}")).some((h) => h.section === "candidate_flags" && h.value?.verified === true));
ok("verifier/submit-one 命令事件登记并校验新 flag");

// verifier/clear-cache 清空 seen
ctx.emit("verifier/clear-cache");
await waitFor(async () => (await ctx.blackboard.keys("verifier")).filter((k) => k.startsWith("seen:")).length === 0);
ok("verifier/clear-cache 清空去重缓存");

await ctx.fiber.dispose();
//#endregion

//#region B. 格式错误 + 占位符 → failures + verified-fail
console.log("== B. 格式错误与占位符 ==");
ctx = await bootTree({ verifierConfig: { mode: "mock", autoVerify: true } });
const evB = [];
ctx.on("verifier/verified-fail", (p) => evB.push(p));
await ctx.blackboard.set("candidate_flags", "plan-x:flag-bad", { planId: "plan-x", flag: "not-a-flag!", source: "test", at: iso() });
await waitFor(async () => (await ctx.blackboard.get("candidate_flags", "plan-x:flag-bad"))?.verified === false);
const bad = await ctx.blackboard.get("candidate_flags", "plan-x:flag-bad");
assert.ok(bad.verify_msg.includes("格式不匹配"), bad.verify_msg);
const failRec = await ctx.blackboard.get("failures", "plan-x:verifier");
assert.ok(failRec?.some((f) => f.type === "verifier-format"), "格式错误写入 failures(verifier-format)");
assert.ok(evB.some((p) => p.key === "plan-x:flag-bad"), "verified-fail 事件已发出");
ok("格式错误 flag → verified:false + failures(verifier-format) + verified-fail");

// 占位符黑名单
await ctx.blackboard.set("candidate_flags", "plan-x:flag-ph", { planId: "plan-x", flag: "CTF{flag}", source: "test", at: iso() });
await waitFor(async () => (await ctx.blackboard.get("candidate_flags", "plan-x:flag-ph"))?.verified === false);
assert.ok((await ctx.blackboard.get("candidate_flags", "plan-x:flag-ph")).verify_msg.includes("占位符"));
ok("占位符 flag（CTF{flag}）被黑名单过滤");

// 自定义格式 extraPatterns
await ctx.verifier.verifyOne({ planId: "plan-x", flag: "MYCTF{abc123}" });
const custom = await ctx.blackboard.search("MYCTF{abc123}");
const customHit = custom.find((h) => h.section === "candidate_flags" && h.value?.flag === "MYCTF{abc123}");
assert.equal(customHit.value.verified, false, "未配置 extraPatterns 时自定义格式被拒");

await ctx.fiber.dispose();
//#endregion

//#region C. 重复 flag 去重
console.log("== C. 重复 flag 去重 ==");
ctx = await bootTree({ verifierConfig: { mode: "mock", autoVerify: true } });
const evC = [];
ctx.on("verifier/duplicate-flag", (p) => evC.push(p));
await ctx.blackboard.set("candidate_flags", "plan-y:flag-1", { planId: "plan-y", flag: "CTF{dup-flag}", source: "t", at: iso() });
await waitFor(async () => (await ctx.blackboard.get("candidate_flags", "plan-y:flag-1"))?.verified === true);
await ctx.blackboard.set("candidate_flags", "plan-y:flag-2", { planId: "plan-y", flag: "CTF{dup-flag}", source: "t", at: iso() });
await waitFor(async () => (await ctx.blackboard.get("candidate_flags", "plan-y:flag-2"))?.duplicate === true);
const dup = await ctx.blackboard.get("candidate_flags", "plan-y:flag-2");
assert.equal(dup.verified, true, "重复 flag 继承首次校验结果");
assert.ok(dup.verify_msg.includes("重复 flag"), dup.verify_msg);
assert.ok(evC.some((p) => p.flag === "CTF{dup-flag}" && p.firstKey === "plan-y:flag-1"), "duplicate-flag 事件带 firstKey");
const seenCount = (await ctx.blackboard.keys("verifier")).filter((k) => k.startsWith("seen:")).length;
assert.equal(seenCount, 1, "去重缓存只有一条");
ok("重复 flag 自动去重：duplicate 标记 + duplicate-flag 事件 + seen 唯一");

await ctx.fiber.dispose();
//#endregion

//#region D. mockRejectPattern 模拟提交被拒
console.log("== D. mock 提交被拒 ==");
ctx = await bootTree({ verifierConfig: { mode: "mock", autoVerify: true, mockRejectPattern: "rejectme" } });
const evD = [];
ctx.on("verifier/verified-fail", (p) => evD.push(p));
await ctx.blackboard.set("candidate_flags", "plan-z:flag-1", { planId: "plan-z", flag: "CTF{rejectme-please}", source: "t", at: iso() });
await waitFor(async () => (await ctx.blackboard.get("candidate_flags", "plan-z:flag-1"))?.verified === false);
const rej = await ctx.blackboard.get("candidate_flags", "plan-z:flag-1");
assert.ok(rej.verify_msg.includes("模拟提交被拒"), rej.verify_msg);
const rejFail = await ctx.blackboard.get("failures", "plan-z:verifier");
assert.ok(rejFail?.some((f) => f.type === "verifier-reject"), "mock 拒绝写入 failures(verifier-reject)");
ok("mockRejectPattern 命中 → 校验失败(verifier-reject) 写入 failures");

await ctx.fiber.dispose();
//#endregion

//#region E. planner 联动（external 模式）
console.log("== E. planner 联动 ==");
ctx = await bootTree({
	plannerConfig: { executionMode: "external", taskTimeoutMs: 120000, tickMs: 50, maxAttempts: 1 },
	verifierConfig: { mode: "mock", autoVerify: true, mockRejectPattern: "bad-format" }
});
const evE = [];
ctx.on("planner/done", (p) => evE.push(["done", p]));
ctx.on("planner/fail", (p) => evE.push(["fail", p]));

/** 推进 external 计划直到 flag 任务 running（跳过 flag 阶段，留给 verifier 联动）。 */
async function walkToFlagTask(planId) {
	for (let guard = 0; guard < 100; guard++) {
		const p = await ctx.planner.getPlan(planId);
		if (p.status !== "running") return p;
		const nonFlag = p.tasks.find((t) => t.status === "running" && t.phase !== "flag");
		if (nonFlag) await ctx.planner.completeTask(planId, nonFlag.id, { ok: true });
		else if (p.tasks.some((t) => t.status === "running" && t.phase === "flag")) return p;
		await new Promise((r) => setTimeout(r, 50));
	}
	return ctx.planner.getPlan(planId);
}

// E1: 校验通过 → completeTask → 计划完成
await ctx.planner.start({ planId: "plan-e1", title: "link-ok", description: "一个 osint 题目。" });
await walkToFlagTask("plan-e1");
const e1 = await ctx.planner.getPlan("plan-e1");
const flagTaskE1 = e1.tasks.find((t) => t.phase === "flag");
assert.equal(flagTaskE1.status, "running", "flag 任务等待外部 flag");
await ctx.planner.submitFlag("plan-e1", "CTF{link-ok-flag}", "test", flagTaskE1.id);
await waitFor(async () => (await ctx.planner.getPlan("plan-e1"))?.status === "done");
const e1b = await ctx.planner.getPlan("plan-e1");
assert.equal(e1b.status, "done");
assert.equal(e1b.tasks.find((t) => t.id === flagTaskE1.id).result.flag, "CTF{link-ok-flag}", "completeTask 结果携带通过 flag");
assert.ok(evE.some(([n]) => n === "done"), "planner/done 发出");
ok("校验通过 → planner.completeTask(flag 任务) → 计划完成");

// E2: 全部失败（mockRejectPattern 命中）→ failTask → planner/fail
await ctx.planner.start({ planId: "plan-e2", title: "link-fail", description: "一个 forensics 题目。" });
await walkToFlagTask("plan-e2");
const e2 = await ctx.planner.getPlan("plan-e2");
const flagTaskE2 = e2.tasks.find((t) => t.phase === "flag");
await ctx.planner.submitFlag("plan-e2", "CTF{bad-format}", "test", flagTaskE2.id);
await waitFor(async () => (await ctx.planner.getPlan("plan-e2"))?.status === "failed");
const e2b = await ctx.planner.getPlan("plan-e2");
assert.equal(e2b.tasks.find((t) => t.id === flagTaskE2.id).error.type, "executor");
assert.ok(evE.some(([n, p]) => n === "fail" && p.planId === "plan-e2"), "全部 flag 校验失败 → planner/fail");
ok("全部 flag 校验失败 → planner.failTask → planner/fail");

await ctx.fiber.dispose();

// E3: external 模式 + setSubmitter 外部提交器
ctx = await bootTree({
	plannerConfig: { executionMode: "external", taskTimeoutMs: 120000, tickMs: 50, maxAttempts: 1 },
	verifierConfig: { mode: "external", autoVerify: true }
});
ctx.verifier.setSubmitter(async ({ flag }) => ({ verified: flag === "CTF{ext-accept}", verify_msg: "外部平台判定" }));
await ctx.planner.start({ planId: "plan-e3", title: "ext-sub", description: "一个 crypto 题目。" });
await walkToFlagTask("plan-e3");
const e3 = await ctx.planner.getPlan("plan-e3");
const flagTaskE3 = e3.tasks.find((t) => t.phase === "flag");
await ctx.planner.submitFlag("plan-e3", "CTF{ext-accept}", "test", flagTaskE3.id);
await waitFor(async () => (await ctx.blackboard.search("CTF{ext-accept}")).some((h) => h.section === "candidate_flags" && h.value?.verified === true));
const extEntry = (await ctx.blackboard.search("CTF{ext-accept}")).find((h) => h.section === "candidate_flags").value;
assert.equal(extEntry.verify_msg, "外部平台判定", "外部提交器结果被采用");
ok("external 模式 setSubmitter 外部提交器生效");

await ctx.fiber.dispose();
//#endregion

//#region F. 重启恢复：补校验历史未校验 flag
console.log("== F. 重启恢复 ==");
const RESUME_BB = join(TMP, "blackboard.resume.json");
// boot 1：verifier autoVerify=false（模拟校验器宕机），planner 正常产出 flag
ctx = await bootTree({
	bbFile: RESUME_BB,
	plannerConfig: { executionMode: "internal", internalDelayMs: 40, tickMs: 50, maxAttempts: 2 },
	verifierConfig: { mode: "mock", autoVerify: false }
});
await ctx.planner.start({ planId: "plan-resume", title: "resume", description: "一个 pwn 题目，flag 为 CTF{restart-verify-ok}。" });
await waitFor(async () => (await ctx.planner.getPlan("plan-resume"))?.status === "done");
const rk = (await ctx.blackboard.keys("candidate_flags")).find((k) => k.startsWith("plan-resume:"));
assert.ok(rk, "candidate_flags 有条目");
const pre = await ctx.blackboard.get("candidate_flags", rk);
assert.equal(pre.verified, void 0, "autoVerify=false 期间条目未校验");
await ctx.fiber.dispose();

// boot 2：verifier autoVerify=true → 启动扫描补校验
ctx = await bootTree({
	bbFile: RESUME_BB,
	plannerConfig: { executionMode: "internal", internalDelayMs: 40, tickMs: 50, maxAttempts: 2 },
	verifierConfig: { mode: "mock", autoVerify: true }
});
const evF = [];
ctx.on("verifier/verified-ok", (p) => evF.push(p));
await waitFor(async () => (await ctx.blackboard.get("candidate_flags", rk))?.verified === true);
const post = await ctx.blackboard.get("candidate_flags", rk);
assert.equal(post.verified, true, "重启扫描后历史 flag 被补校验");
assert.ok(post.verify_msg.includes("模拟校验通过"), post.verify_msg);
// 重启后新增 flag → 事件驱动校验仍正常
await ctx.blackboard.set("candidate_flags", "plan-resume:flag-new", { planId: "plan-resume", flag: "CTF{after-restart-ok}", source: "t", at: iso() });
await waitFor(async () => (await ctx.blackboard.get("candidate_flags", "plan-resume:flag-new"))?.verified === true);
assert.ok(evF.some((p) => p && p.flag === "CTF{after-restart-ok}"), "重启后事件驱动 verified-ok 正常");
ok("重启后自动扫描历史候选 flag 补校验 + 新 flag 事件驱动正常");

await ctx.fiber.dispose();
//#endregion

//#region H. 禁止直接写文件
console.log("== H. 无直接文件写入 ==");
const stray = (await readdir(TMP)).filter((name) => !name.startsWith("blackboard.") && !name.startsWith("blackboard.test.json") && name !== "profile");
assert.deepEqual(stray, [], `verifier 不应直接写文件（发现: ${stray.join(", ")}）`);
ok("verifier 全部读写经 blackboard，无直接磁盘文件写入");
//#endregion

await rm(TMP, { recursive: true, force: true });
console.log(`\nALL ${passed} TESTS PASSED`);
//#endregion
