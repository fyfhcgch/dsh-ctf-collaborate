//#region tests/boot-test.mjs
/**
 * Standalone boot test for @dsh-external/dsh-planner.
 *
 * Mounts the blackboard + planner rows exactly like dsh profile boot does,
 * using the REAL @deepseek-ai/dsh-app-boot `boot()` from the installed
 * harness. Coverage:
 *   A. end-to-end internal execution: event-driven start → DAG → all sections
 *      written → planner/done with candidate flags; no direct file writes.
 *   B. failure path: internalFailPattern → task failed, failures section,
 *      dependents blocked, planner/fail.
 *   C. timeout path: external mode + tiny taskTimeoutMs → timeout failures.
 *   D. external mode + executor API: completeTask/failTask/addClue/
 *      addToolOutput/submitFlag drive the plan to done / fail.
 *   E. restart resume: kill mid-flight (running tasks), re-boot, interrupted
 *      tasks are recovered from the blackboard and the plan completes.
 *
 * Usage:  node plugins/planner-agent/tests/boot-test.mjs
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { loadHarnessBoot } from "../../../tests/harness-scope.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(HERE, "..");
const TMP = join(HERE, ".tmp");
const PROFILE_DIR = join(TMP, "profile");
const CONFIG_FILE = join(PROFILE_DIR, "cordis.yml");
const BB_FILE = join(TMP, "blackboard.test.json");

const { boot } = await loadHarnessBoot();

async function ensureProfileLinks() {
	await mkdir(join(PROFILE_DIR, "node_modules", "@dsh-external"), { recursive: true });
	await mkdir(join(PLUGIN_DIR, "node_modules", "@deepseek-ai"), { recursive: true });
	const { symlink } = await import("node:fs");
	for (const name of ["dsh-blackboard", "dsh-planner"]) {
		const link = join(PROFILE_DIR, "node_modules", "@dsh-external", name);
		try {
			await stat(link);
		} catch {
			await new Promise((resolve, reject) => symlink(PLUGIN_DIR.replace(/planner-agent$/, `${name === "dsh-blackboard" ? "blackboard-plugin" : "planner-agent"}`), link, "junction", (error) => error ? reject(error) : resolve()));
		}
	}
	await writeFile(CONFIG_FILE, "[]\n", "utf8");
}

/** Build the two-row patch with per-boot configs. */
function blackboardPlannerPatch({ bbFile = BB_FILE, plannerConfig = {} } = {}) {
	return [{
		insert: [
			{ id: "blackboard", name: "@dsh-external/dsh-blackboard", config: { file: bbFile } },
			{ id: "planner", name: "@dsh-external/dsh-planner", config: { ...plannerConfig } }
		]
	}];
}

function bootTree(options) {
	return boot("planner-test", CONFIG_FILE, blackboardPlannerPatch(options));
}

async function waitFor(predicate, timeoutMs = 15000, intervalMs = 25) {
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

const WEB_CHALLENGE = {
	planId: "plan-demo-web",
	title: "flag-shop",
	description: "一个 web 题目：flag shop 存在 SQL 注入与越权漏洞，目标是拿到管理后台的 flag。管理后台返回 CTF{planner-flag-demo}。",
	attachments: [{ name: "app.py", type: "source", note: "后端源码" }]
};

await rm(TMP, { recursive: true, force: true });
await ensureProfileLinks();

//#region A. end-to-end internal execution
console.log("== A. end-to-end internal execution ==");
let ctx = await bootTree({ plannerConfig: { executionMode: "internal", internalDelayMs: 40, tickMs: 50, maxAttempts: 2, autoRun: true } });
const planner = ctx.planner;
assert.ok(planner, "ctx.planner must be provided");
const events = [];
for (const name of ["planner/started", "planner/task-update", "planner/flag", "planner/done", "planner/fail", "planner/resumed"]) {
	ctx.on(name, (payload) => events.push([name, payload]));
}

ctx.emit("planner/start", WEB_CHALLENGE);
await waitFor(() => events.some(([name]) => name === "planner/done"), 20000);
ok("planner/start event → planner/done emitted");

const doneEvt = events.find(([name]) => name === "planner/done")[1];
assert.equal(doneEvt.planId, "plan-demo-web");
const plan = await planner.getPlan("plan-demo-web");
assert.ok(plan, "plan persisted in blackboard planner/plan:<id>");
assert.equal(plan.status, "done");
assert.equal(plan.category, "web");
assert.ok(plan.tasks.length >= 4 && plan.tasks.length <= 16, `DAG generated (${plan.tasks.length} tasks)`);
for (const task of plan.tasks) {
	assert.equal(task.status, "done", `task ${task.id} done`);
	for (const dep of task.dependencies) {
		assert.ok(plan.tasks.some((t) => t.id === dep), `dependency ${dep} of ${task.id} exists`);
	}
}
assert.ok(plan.tasks[0].dependencies.length === 0, "first task has no dependencies (DAG root)");
ok("CoT DAG decomposed, persisted, all tasks done");

const challenge = await ctx.blackboard.get("challenges", "plan-demo-web");
assert.deepEqual(challenge.description, WEB_CHALLENGE.description);
const flags = doneEvt.flags.filter((f) => f.flag === "CTF{planner-flag-demo}");
assert.ok(flags.length > 0, "description flag extracted into candidate_flags and planner/done");
const taskUpdates = events.filter(([name]) => name === "planner/task-update").map(([, p]) => p);
for (const status of ["ready", "running", "done"]) {
	assert.ok(taskUpdates.some((p) => p.status === status), `task-update with status ${status}`);
}
for (const task of plan.tasks) {
	assert.ok(await ctx.blackboard.has("clues", `plan-demo-web:${task.id}`), `clue written for ${task.id}`);
	assert.ok((await ctx.blackboard.get("tool_outputs", `plan-demo-web:${task.id}`))?.length >= 2, `tool outputs written for ${task.id}`);
}
ok("blackboard sections populated: challenges/clues/tool_outputs/candidate_flags");

assert.equal((await planner.listPlans()).length, 1);
assert.equal((await planner.getCurrentPlan()).planId, "plan-demo-web");
assert.equal((await ctx.blackboard.get("planner", "current")).status, "done");
ok("planner service reads (getPlan/getCurrentPlan/listPlans) work");

// the planner must never create files besides the blackboard data file
const stray = (await readdir(TMP)).filter((name) => !name.startsWith("blackboard.test.json") && name !== "profile");
assert.deepEqual(stray, [], `no stray files written by the planner (found: ${stray.join(", ")})`);
ok("planner never writes files directly (only blackboard data file exists)");

await ctx.fiber.dispose();
//#endregion

//#region B. failure path (internalFailPattern)
console.log("== B. failure path ==");
ctx = await bootTree({ plannerConfig: { executionMode: "internal", internalDelayMs: 30, tickMs: 50, maxAttempts: 1, internalFailPattern: "exploit" } });
const plannerB = ctx.planner;
const evB = [];
for (const name of ["planner/done", "planner/fail", "planner/task-update"]) ctx.on(name, (p) => evB.push([name, p]));
await plannerB.start({ planId: "plan-fail", title: "failme", description: "一个 pwn 题目：栈溢出，ROP 利用。" });
await waitFor(() => evB.some(([name]) => name === "planner/fail"), 20000);
const failEvt = evB.find(([name]) => name === "planner/fail")[1];
assert.equal(failEvt.planId, "plan-fail");
assert.ok(failEvt.failedTasks.length > 0, "planner/fail names failed tasks");
const planB = await plannerB.getPlan("plan-fail");
const exploitTask = planB.tasks.find((t) => t.phase === "exploit");
assert.equal(exploitTask.status, "failed");
const failures = await ctx.blackboard.get("failures", `plan-fail:${exploitTask.id}`);
assert.ok(failures.some((f) => f.type === "executor"), "executor failure recorded in failures section");
const flagTask = planB.tasks.find((t) => t.phase === "flag");
assert.equal(flagTask.status, "blocked", "flag task blocked by failed exploit");
assert.equal(planB.status, "failed");
assert.ok(planB.failReason);
ok("task failure → failures section + blocked dependents + planner/fail");

// retryTask re-runs a failed task on a fresh plan
await plannerB.retryTask("plan-fail", exploitTask.id);
const planB2 = await plannerB.getPlan("plan-fail");
assert.equal(planB2.tasks.find((t) => t.id === exploitTask.id).status, "pending");
ok("retryTask resets a failed task for re-scheduling");

await ctx.fiber.dispose();
//#endregion

//#region C. timeout path (external mode + tiny timeout)
console.log("== C. timeout path ==");
ctx = await bootTree({ plannerConfig: { executionMode: "external", taskTimeoutMs: 250, tickMs: 50, maxAttempts: 1 } });
const plannerC = ctx.planner;
const evC = [];
ctx.on("planner/fail", (p) => evC.push(p));
ctx.on("planner/task-update", (p) => evC.push(p));
await plannerC.start({ planId: "plan-timeout", title: "slow", description: "一个 crypto 题目：RSA 弱密钥分析。" });
await waitFor(async () => {
	const p = await plannerC.getPlan("plan-timeout");
	return p?.status === "failed" && p.tasks.some((t) => t.status === "failed");
}, 20000);
const planC = await plannerC.getPlan("plan-timeout");
const timeoutTask = planC.tasks.find((t) => t.phase === "recon");
assert.equal(timeoutTask.status, "failed");
const failuresC = await ctx.blackboard.get("failures", `plan-timeout:${timeoutTask.id}`);
assert.ok(failuresC.some((f) => f.type === "timeout"), "timeout failure recorded with type=timeout");
assert.equal(planC.status, "failed");
ok("subtask timeout → failed with type=timeout in failures, plan fails");

await ctx.fiber.dispose();
//#endregion

//#region D. external mode + executor API
console.log("== D. external executor API ==");
ctx = await bootTree({ plannerConfig: { executionMode: "external", taskTimeoutMs: 60000, tickMs: 50, maxAttempts: 1 } });
const plannerD = ctx.planner;
const evD = [];
ctx.on("planner/done", (p) => evD.push(["done", p]));
ctx.on("planner/fail", (p) => evD.push(["fail", p]));

await plannerD.addToolOutput("plan-x", "t0", "pre-start probe");
await plannerD.addClue("plan-x", "t0", "manual clue");
assert.ok((await ctx.blackboard.get("tool_outputs", "plan-x:t0")).length === 1);
assert.ok((await ctx.blackboard.get("clues", "plan-x:t0:notes")).length === 1);
ok("addToolOutput/addClue write through to blackboard");

await plannerD.start({ planId: "plan-ext", title: "ext", description: "一个 osint 题目：根据图片 EXIF 定位地点。" });
await waitFor(async () => (await plannerD.getPlan("plan-ext")).tasks.some((t) => t.status === "running"));
ok("external mode: tasks go running without auto-completion");

// walk the DAG: complete the currently-running task until the plan is done
for (let guard = 0; guard < 100; guard++) {
	const current = await plannerD.getPlan("plan-ext");
	if (current.status === "done" || current.status === "failed") break;
	const running = current.tasks.find((t) => t.status === "running");
	if (running) await plannerD.completeTask("plan-ext", running.id, { summary: `executed ${running.id}` }, { executor: "test" });
	await new Promise((resolve) => setTimeout(resolve, 60));
}
await waitFor(() => evD.some(([name]) => name === "done"), 10000);
const planD2 = await plannerD.getPlan("plan-ext");
assert.equal(planD2.status, "done");
assert.equal(planD2.tasks.filter((t) => t.status === "done").length, planD2.tasks.length);
const clue = await ctx.blackboard.get("clues", "plan-ext:t1");
assert.ok(clue.result.summary, "completeTask result persisted into clues");
ok("external executors drive the DAG to planner/done via completeTask");

// submitFlag API (dedup)
const first = await plannerD.submitFlag("plan-ext", "CTF{ext-flag}");
const second = await plannerD.submitFlag("plan-ext", "CTF{ext-flag}");
assert.equal(first.changed, true);
assert.equal(second.changed, false);
assert.ok((await ctx.blackboard.get("candidate_flags", first.key)).flag === "CTF{ext-flag}");
ok("submitFlag writes candidate_flags with dedup");

// failTask drives a plan to planner/fail
await plannerD.start({ planId: "plan-ext-fail", title: "extfail", description: "一个 forensics 题目：内存取证。" });
await waitFor(async () => (await plannerD.getPlan("plan-ext-fail")).tasks.some((t) => t.status === "running"));
const current = await plannerD.getPlan("plan-ext-fail");
await plannerD.failTask("plan-ext-fail", current.tasks.find((t) => t.status === "running").id, "executor crashed", { code: 42 });
await waitFor(() => evD.some(([name, p]) => name === "fail" && p.planId === "plan-ext-fail"), 10000);
const planDF = await plannerD.getPlan("plan-ext-fail");
assert.equal(planDF.status, "failed");
const failRec = (await ctx.blackboard.get("failures", `plan-ext-fail:${current.tasks.find((t) => t.status === "running").id}`))[0];
assert.equal(failRec.type, "executor");
assert.equal(failRec.message, "executor crashed");
assert.deepEqual(failRec.meta, { code: 42 });
ok("failTask records executor failure + drives plan to planner/fail");

// cancel
await plannerD.start({ planId: "plan-cancel", title: "cancel", description: "一个 misc 题目：杂项。" });
await waitFor(async () => (await plannerD.getPlan("plan-cancel")).tasks.some((t) => t.status === "running"));
await plannerD.cancel("plan-cancel");
assert.equal((await plannerD.getPlan("plan-cancel")).status, "cancelled");
ok("cancel stops a plan");

await ctx.fiber.dispose();
//#endregion

//#region E. restart resume (checkpoint recovery)
console.log("== E. restart resume ==");
const RESUME_BB = join(TMP, "blackboard.resume.json");
const resumeCfg = (over = {}) => ({ executionMode: "internal", internalDelayMs: 60000, tickMs: 100, maxAttempts: 1, ...over });

// boot 1: long internal delay → tasks stay in-flight
ctx = await bootTree({ bbFile: RESUME_BB, plannerConfig: resumeCfg() });
const plannerE1 = ctx.planner;
const resumeEvents = [];
ctx.on("planner/resumed", (p) => resumeEvents.push(p));
ctx.on("planner/done", (p) => resumeEvents.push(p));
await plannerE1.start({
	planId: "plan-resume",
	title: "resume-me",
	description: "一个 reverse 题目：逆向校验逻辑，算法输出 CTF{resume-flag}。"
});
await waitFor(async () => {
	const p = await plannerE1.getPlan("plan-resume");
	return p.tasks.some((t) => t.status === "running");
}, 10000);
const planBefore = await plannerE1.getPlan("plan-resume");
const runningBefore = planBefore.tasks.filter((t) => t.status === "running").map((t) => t.id);
assert.ok(runningBefore.length >= 1, "at least one task running before kill");
ok(`boot 1: plan in-flight with running task(s) ${runningBefore.join(",")}`);

// "harness restart": dispose the whole tree (blackboard data file survives)
await ctx.fiber.dispose();

// boot 2: same blackboard file, fast internal executor → resume + complete
ctx = await bootTree({ bbFile: RESUME_BB, plannerConfig: resumeCfg({ internalDelayMs: 50 }) });
const plannerE2 = ctx.planner;
await waitFor(async () => (await plannerE2.getPlan("plan-resume"))?.status === "done", 30000);
ok("boot 2: plan resumed and completed after restart");

const planAfter = await plannerE2.getPlan("plan-resume");
assert.equal(planAfter.status, "done");
assert.equal(planAfter.tasks.filter((t) => t.status === "done").length, planAfter.tasks.length, "every task eventually done");

// interrupted tasks recorded with type=interrupt in the failures section
let interruptRecords = 0;
for (const taskId of runningBefore) {
	const recs = await ctx.blackboard.get("failures", `plan-resume:${taskId}`);
	if (recs?.some((f) => f.type === "interrupt")) interruptRecords += 1;
}
assert.ok(interruptRecords >= 1, "interrupt failure recorded for previously-running tasks");
const flagsAfter = await ctx.blackboard.search("CTF{resume-flag}");
assert.ok(flagsAfter.some((h) => h.section === "candidate_flags" && h.value.flag === "CTF{resume-flag}"), "flag from the challenge survives restart and is submitted");
ok("checkpoint resume verified: interrupted tasks recovered from blackboard, failures recorded, plan completes");

await ctx.fiber.dispose();
//#endregion

await rm(TMP, { recursive: true, force: true });
console.log(`\nALL ${passed} TESTS PASSED`);
//#endregion
