//#region tests/boot-test.mjs
/**
 * 独立启动测试：@dsh-external/dsh-crypto-expert
 *
 * 用真实 @deepseek-ai/dsh-app-boot 的 `boot()` 挂载 blackboard + planner +
 * verifier + web-expert + crypto-expert 五行（与 dsh profile boot 一致）。
 * 密文全部本地确定性生成（Base64 / 单字节 XOR / 凯撒 / ROT13 / RSA 小整数），
 * 无任何网络依赖。覆盖：
 *   A. 求解管线单元（analyzeText）：base64 / xor-single / caesar / rot13 / rsa
 *   B. recon / analysis / exploit 任务执行 + flag → candidate_flags → verifier 校验
 *   C. planner 自动认领（external 模式 crypto 计划）
 *   D. 异常：无密文（ENOCIPHER）/ 无法求解（ENOHIT）→ failures + task-fail
 *   E. 取消：cancelTask → cancelled
 *   F. 重启恢复：running 任务中断 → 标记 interrupt → 重新调度完成
 *   G. 无直接文件写入
 *
 * 用法：node plugins/crypto-expert-agent/tests/boot-test.mjs
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
const { modPow, FLAG_EXTRACTION_RE } = await import(pathToFileURL(join(PLUGIN_ROOT, "lib/index.js")).href);

async function ensureProfileLinks() {
	await mkdir(join(PROFILE_DIR, "node_modules", "@dsh-external"), { recursive: true });
	await mkdir(join(PLUGIN_ROOT, "node_modules", "@deepseek-ai"), { recursive: true });
	const { symlink } = await import("node:fs");
	for (const [name, dir] of [["dsh-blackboard", "blackboard-plugin"], ["dsh-planner", "planner-agent"], ["dsh-verifier", "verifier-agent"], ["dsh-web-expert", "web-expert-agent"], ["dsh-crypto-expert", "crypto-expert-agent"]]) {
		const link = join(PROFILE_DIR, "node_modules", "@dsh-external", name);
		try {
			await stat(link);
		} catch {
			await new Promise((resolve, reject) => symlink(join(PLUGIN_ROOT, "..", dir), link, "junction", (error) => error ? reject(error) : resolve()));
		}
	}
	await writeFile(CONFIG_FILE, "[]\n", "utf8");
}

/** 五行 patch。 */
function fiveRowPatch({ bbFile = BB_FILE, plannerConfig = {}, cryptoConfig = {} } = {}) {
	return [{
		insert: [
			{ id: "blackboard", name: "@dsh-external/dsh-blackboard", config: { file: bbFile } },
			{ id: "planner", name: "@dsh-external/dsh-planner", config: { ...plannerConfig } },
			{ id: "verifier", name: "@dsh-external/dsh-verifier", config: {} },
			{ id: "webExpert", name: "@dsh-external/dsh-web-expert", config: { autoClaim: false } },
			{ id: "cryptoExpert", name: "@dsh-external/dsh-crypto-expert", config: { ...cryptoConfig } }
		]
	}];
}

function bootTree(options) {
	return boot("crypto-test", CONFIG_FILE, fiveRowPatch(options));
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

// 本地确定性密文
const C_B64 = Buffer.from("CTF{crypto-base64}").toString("base64"); // Q1RGe2NyeXB0by1iYXNlNjR9
const C_XOR = Buffer.from([...Buffer.from("CTF{crypto-xor}")].map((b) => b ^ 0x2a)).toString("hex");
// 凯撒 +7：直接逐字符
function caesarShift(text, shift) {
	return text.replace(/[a-zA-Z]/g, (ch) => {
		const base = ch <= "Z" ? 65 : 97;
		return String.fromCharCode(((ch.charCodeAt(0) - base + shift) % 26 + 26) % 26 + base);
	});
}
const C_CAESAR7 = caesarShift("CTF{crypto-caesar}", 7);
const C_ROT13 = caesarShift("CTF{crypto-rot13}", 13);
const RSA = { p: "61", q: "53", e: "17", n: "3233", m: 42n };
const RSA_C = modPow(42n, 17n, 3233n).toString();

await rm(TMP, { recursive: true, force: true });
await ensureProfileLinks();

//#region A. 求解管线单元
console.log("== A. 求解管线单元 ==");
let ctx = await bootTree({ cryptoConfig: { autoClaim: false } });
assert.ok(ctx.cryptoExpert, "ctx.cryptoExpert 必须可用（inject 已解析 blackboard+planner）");

let sol = await ctx.cryptoExpert.analyzeText(C_B64);
assert.ok(sol.solved, "base64 可解");
assert.ok(sol.steps.some((s) => s.flags.includes("CTF{crypto-base64}")), "base64 解出 flag");
sol = await ctx.cryptoExpert.analyzeText(C_XOR);
assert.ok(sol.solved && sol.steps.some((s) => s.flags.includes("CTF{crypto-xor}")), "单字节 XOR 爆破解出 flag");
sol = await ctx.cryptoExpert.analyzeText(C_CAESAR7);
assert.ok(sol.solved && sol.steps.some((s) => s.flags.includes("CTF{crypto-caesar}")), "凯撒爆破解出 flag");
sol = await ctx.cryptoExpert.analyzeText(C_ROT13);
assert.ok(sol.solved && sol.steps.some((s) => s.flags.includes("CTF{crypto-rot13}")), "ROT13 解出 flag");
sol = await ctx.cryptoExpert.analyzeText("", { rsaParams: { p: RSA.p, q: RSA.q, e: RSA.e, c: RSA_C, n: RSA.n } });
assert.ok(sol.solved, "RSA 可解");
assert.ok(sol.steps.some((s) => s.kind === "rsa" && s.summary.includes("m=42")), "RSA 解出明文 42");
ok("求解管线：base64 / 单字节XOR / 凯撒 / ROT13 / RSA(p,q,e) 全部解出");

// 不可解输入
sol = await ctx.cryptoExpert.analyzeText("zzzzqqqqwwww");
assert.equal(sol.solved, false, "噪声输入不可解");
ok("噪声输入正确判为不可解");

await ctx.fiber.dispose();
//#endregion

//#region B. recon/analysis/exploit 任务执行 + verifier 校验
console.log("== B. 任务执行 + verifier 校验 ==");
ctx = await bootTree({ cryptoConfig: { autoClaim: false } });
const evB = [];
ctx.on("crypto-expert/task-done", (p) => evB.push(p));
ctx.on("verifier/verified-ok", (p) => evB.push(["vok", p]));

await ctx.cryptoExpert.executeTask({
	planId: "plan-c1",
	task: { id: "t1", phase: "recon", title: "信息收集", description: "整理算法参数" },
	challenge: { description: "一个 RSA 题目，n=3233 e=65537，另有密文。", attachments: [] }
});
const clues1 = await ctx.blackboard.get("clues", "plan-c1:t1:notes");
assert.ok(clues1.some((c) => JSON.stringify(c.clue).includes("RSA")), "recon 识别 RSA");
assert.ok(clues1.some((c) => JSON.stringify(c.clue).includes("n=3233")), "recon 提取 RSA 参数");

await ctx.cryptoExpert.executeTask({
	planId: "plan-c2",
	task: { id: "t2", phase: "analysis", title: "密码分析", description: "弱点识别" },
	challenge: { description: "密文如下", ciphertext: C_XOR, attachments: [] }
});
const clues2 = await ctx.blackboard.get("clues", "plan-c2:t2:notes");
assert.ok(clues2.some((c) => JSON.stringify(c.clue).includes("XOR")), "analysis 识别 XOR 特征");

const resultB = await ctx.cryptoExpert.executeTask({
	planId: "plan-c3",
	task: { id: "t3", phase: "exploit", title: "破解实现", description: "求解" },
	challenge: { description: "crypto 题目", ciphertext: C_B64, attachments: [] }
});
assert.equal(resultB.status, "done");
await waitFor(async () => {
	const hit = (await ctx.blackboard.search("CTF{crypto-base64}")).find((h) => h.section === "candidate_flags");
	return hit?.value?.verified === true;
}, 30000);
assert.ok(evB.some((p) => p?.taskId === "t3"), "task-done 事件发出");
ok("exploit 解出 flag → candidate_flags → verifier 自动校验通过");

await ctx.fiber.dispose();
//#endregion

//#region C. planner 自动认领
console.log("== C. planner 自动认领 ==");
ctx = await bootTree({
	plannerConfig: { executionMode: "external", taskTimeoutMs: 60000, tickMs: 50, maxAttempts: 1 },
	cryptoConfig: { autoClaim: true }
});
const cryptoDesc = `一个 crypto 题目：RSA 与编码混合，密文为 ${C_B64}，flag 藏在解出的明文里。`;
await ctx.planner.start({ planId: "plan-crypto", title: "crypto-demo", description: cryptoDesc });
await waitFor(async () => {
	const p = await ctx.planner.getPlan("plan-crypto");
	const t = p.tasks.filter((x) => x.phase === "recon" || x.phase === "analysis" || x.phase === "exploit");
	return t.length > 0 && t.every((x) => x.status === "done");
}, 30000);
const claimPlan = await ctx.planner.getPlan("plan-crypto");
for (const t of claimPlan.tasks) {
	if (t.phase === "recon" || t.phase === "analysis" || t.phase === "exploit") {
		assert.equal(t.status, "done", `${t.id}(${t.phase}) 被 crypto-expert 认领完成`);
	}
}
const stateC = await ctx.cryptoExpert.getTaskState("plan-crypto", claimPlan.tasks.find((t) => t.phase === "recon").id);
assert.equal(stateC.status, "done");
ok("planner 置 running → crypto-expert 自动认领 recon/analysis/exploit 并完成");

await ctx.fiber.dispose();
//#endregion

//#region D. 异常
console.log("== D. 异常处理 ==");
ctx = await bootTree({ cryptoConfig: { autoClaim: false } });
const evD = [];
ctx.on("crypto-expert/task-fail", (p) => evD.push(p));

// 无密文
await ctx.cryptoExpert.executeTask({
	planId: "plan-d1",
	task: { id: "t3", phase: "exploit", title: "破解", description: "x" },
	challenge: { description: "crypto 题目" }
}).catch(() => {});
const failD1 = await ctx.blackboard.get("failures", "plan-d1:t3");
assert.ok(failD1?.some((f) => f.code === "ENOCIPHER"), "无密文 → failures(ENOCIPHER)");

// 无法求解
await ctx.cryptoExpert.executeTask({
	planId: "plan-d2",
	task: { id: "t3", phase: "exploit", title: "破解", description: "x" },
	challenge: { description: "crypto 题目", ciphertext: "zzzzqqqqwwww" }
}).catch(() => {});
const failD2 = await ctx.blackboard.get("failures", "plan-d2:t3");
assert.ok(failD2?.some((f) => f.code === "ENOHIT"), "无法求解 → failures(ENOHIT)");
assert.ok(evD.some((p) => p.taskId === "t3"), "task-fail 事件发出");
assert.equal((await ctx.cryptoExpert.getTaskState("plan-d2", "t3")).status, "failed");
ok("无密文/无法求解 → failures + task-fail + 状态 failed");

await ctx.fiber.dispose();
//#endregion

//#region E. 取消
console.log("== E. 取消 ==");
ctx = await bootTree({ cryptoConfig: { autoClaim: false } });
const noiseBig = "a1b2c3d4e5f6".repeat(10000); // 60000 字节 hex，XOR 爆破约 0.5-1.5s（取消窗口内）
const pendingE = ctx.cryptoExpert.executeTask({
	planId: "plan-e1",
	task: { id: "t3", phase: "exploit", title: "破解", description: "x" },
	challenge: { description: "crypto 题目", ciphertext: noiseBig }
}).catch(() => ({ status: "cancelled" }));
await waitFor(async () => (await ctx.cryptoExpert.getTaskState("plan-e1", "t3"))?.status === "running");
await ctx.cryptoExpert.cancelTask("plan-e1", "t3");
const outcomeE = await pendingE;
assert.equal(outcomeE.status, "cancelled", "取消后任务以 cancelled 结束");
assert.equal((await ctx.cryptoExpert.getTaskState("plan-e1", "t3")).status, "cancelled");
ok("cancelTask → XOR 爆破中 abort → cancelled");
await ctx.fiber.dispose();
//#endregion

//#region F. 重启断点恢复
console.log("== F. 重启断点恢复 ==");
const RESUME_BB = join(TMP, "blackboard.resume.json");
// boot1：预置一条"执行中被中断"的 crypto 任务（running 状态 + 挑战上下文）
ctx = await bootTree({ bbFile: RESUME_BB, cryptoConfig: { autoClaim: false } });
await ctx.blackboard.set("challenges", "plan-rc", { planId: "plan-rc", title: "resume-crypto", description: "crypto 题目", attachments: [], ciphertext: C_ROT13 });
await ctx.blackboard.set("cryptoExpert", "tasks/plan-rc:t3", { planId: "plan-rc", taskId: "t3", phase: "exploit", title: "破解", status: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
await ctx.fiber.dispose();

// boot2：resume → interrupt 标记 + 重新调度 → 完成
ctx = await bootTree({ bbFile: RESUME_BB, cryptoConfig: { autoClaim: false } });
await waitFor(async () => (await ctx.cryptoExpert.getTaskState("plan-rc", "t3"))?.status === "done", 30000);
const afterF = await ctx.cryptoExpert.getTaskState("plan-rc", "t3");
assert.equal(afterF.status, "done", "恢复后任务重新调度并完成");
const resumeFailures = await ctx.blackboard.get("failures", "plan-rc:t3");
assert.ok(resumeFailures?.some((f) => f.type === "crypto-expert-interrupt"), "中断记录写入 failures(crypto-expert-interrupt)");
const flagAfter = await ctx.blackboard.search("CTF{crypto-rot13}");
assert.ok(flagAfter.some((h) => h.section === "candidate_flags"), "恢复执行解出 flag 进入 candidate_flags");
ok("重启恢复：running 任务标记 interrupt → 重新调度 → 完成（interrupt 留痕 + flag 提取）");

await ctx.fiber.dispose();
//#endregion

//#region G. 无直接文件写入
console.log("== G. 无直接文件写入 ==");
const stray = (await readdir(TMP)).filter((name) => !name.startsWith("blackboard.") && name !== "profile");
assert.deepEqual(stray, [], `crypto-expert 不应直接写文件（发现: ${stray.join(", ")}）`);
ok("crypto-expert 全部读写经 blackboard，无直接磁盘文件写入");
//#endregion

await rm(TMP, { recursive: true, force: true });
console.log(`\nALL ${passed} TESTS PASSED`);
process.exit(0);
//#endregion
