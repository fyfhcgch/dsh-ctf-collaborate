//#region tests/boot-test.mjs
/**
 * 独立启动测试：@dsh-external/dsh-misc-expert
 *
 * 用真实 @deepseek-ai/dsh-app-boot 的 `boot()` 挂载 blackboard + planner +
 * verifier + web-expert + crypto-expert + misc-expert 六行（与 dsh profile
 * boot 一致）。数据全部本地确定性生成（base32/零宽/大小写位/二进制/十进制/
 * 摩斯/反转/hex），无网络依赖。覆盖：
 *   A. 求解管线单元（solveData）
 *   B. recon/analysis/exploit 任务执行 + flag → candidate_flags → verifier 校验
 *   C. planner 自动认领（external 模式 misc 计划）
 *   D. 异常：无数据（ENODATA）/ 无法求解（ENOHIT）
 *   E. 取消：cancelTask → CANCELLED
 *   F. 重启恢复：running 任务中断 → 标记 interrupt → 重新调度完成
 *   G. 无直接文件写入
 *
 * 用法：node plugins/misc-expert-agent/tests/boot-test.mjs
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

async function ensureProfileLinks() {
	await mkdir(join(PROFILE_DIR, "node_modules", "@dsh-external"), { recursive: true });
	await mkdir(join(PLUGIN_ROOT, "node_modules", "@deepseek-ai"), { recursive: true });
	const { symlink } = await import("node:fs");
	for (const [name, dir] of [["dsh-blackboard", "blackboard-plugin"], ["dsh-planner", "planner-agent"], ["dsh-verifier", "verifier-agent"], ["dsh-web-expert", "web-expert-agent"], ["dsh-crypto-expert", "crypto-expert-agent"], ["dsh-misc-expert", "misc-expert-agent"]]) {
		const link = join(PROFILE_DIR, "node_modules", "@dsh-external", name);
		try {
			await stat(link);
		} catch {
			await new Promise((resolve, reject) => symlink(join(PLUGIN_ROOT, "..", dir), link, "junction", (error) => error ? reject(error) : resolve()));
		}
	}
	await writeFile(CONFIG_FILE, "[]\n", "utf8");
}

/** 六行 patch。 */
function sixRowPatch({ bbFile = BB_FILE, plannerConfig = {}, miscConfig = {} } = {}) {
	return [{
		insert: [
			{ id: "blackboard", name: "@dsh-external/dsh-blackboard", config: { file: bbFile } },
			{ id: "planner", name: "@dsh-external/dsh-planner", config: { ...plannerConfig } },
			{ id: "verifier", name: "@dsh-external/dsh-verifier", config: {} },
			{ id: "webExpert", name: "@dsh-external/dsh-web-expert", config: { autoClaim: false } },
			{ id: "cryptoExpert", name: "@dsh-external/dsh-crypto-expert", config: { autoClaim: false } },
			{ id: "miscExpert", name: "@dsh-external/dsh-misc-expert", config: { ...miscConfig } }
		]
	}];
}

function bootTree(options) {
	return boot("misc-test", CONFIG_FILE, sixRowPatch(options));
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

//#region 本地确定性数据生成
function binaryEncode(text) {
	return [...Buffer.from(text)].map((b) => b.toString(2).padStart(8, "0")).join(" ");
}
function decimalEncode(text) {
	return [...Buffer.from(text)].map((b) => b.toString(10)).join(" ");
}
function zeroWidthEncode(text) {
	const bits = [...Buffer.from(text)].flatMap((b) => b.toString(2).padStart(8, "0").split("").map(Number));
	return bits.map((b) => (b ? "\u200c" : "\u200b")).join("");
}
function caseBitsEncode(text) {
	const bits = [...Buffer.from(text)].flatMap((b) => b.toString(2).padStart(8, "0").split("").map(Number));
	return bits.map((b) => (b ? "A" : "a")).join("");
}
function base32Encode(buf) {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	let bits = 0;
	let value = 0;
	let out = "";
	for (const b of buf) {
		value = (value << 8) | b;
		bits += 8;
		while (bits >= 5) {
			out += alphabet[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
	while (out.length % 8 !== 0) out += "=";
	return out;
}
const MORSE_REV = { a: ".-", b: "-...", c: "-.-.", d: "-..", e: ".", f: "..-.", g: "--.", h: "....", i: "..", j: ".---", k: "-.-", l: ".-..", m: "--", n: "-.", o: "---", p: ".--.", q: "--.-", r: ".-.", s: "...", t: "-", u: "..-", v: "...-", w: ".--", x: "-..-", y: "-.--", z: "--.." };
function morseEncode(text) {
	return text.toLowerCase().split("").map((ch) => (ch === " " ? "/" : (MORSE_REV[ch] ?? ""))).join(" ");
}
//#endregion

await rm(TMP, { recursive: true, force: true });
await ensureProfileLinks();

//#region A. 求解管线单元
console.log("== A. 求解管线单元 ==");
let ctx = await bootTree({ miscConfig: { autoClaim: false } });
assert.ok(ctx.miscExpert, "ctx.miscExpert 必须可用（inject 已解析 blackboard+planner）");

let sol = await ctx.miscExpert.solveData(base32Encode(Buffer.from("CTF{misc-base32}")));
assert.ok(sol.solved && sol.steps.some((s) => s.flags.includes("CTF{misc-base32}")), "base32 解出 flag");
sol = await ctx.miscExpert.solveData(`普通可见文本 ${zeroWidthEncode("CTF{misc-zero-width}")} 更多内容`);
assert.ok(sol.solved && sol.steps.some((s) => s.flags.includes("CTF{misc-zero-width}")), "零宽字符隐写提取");
sol = await ctx.miscExpert.solveData(caseBitsEncode("CTF{misc-case-bits}"));
assert.ok(sol.solved && sol.steps.some((s) => s.flags.includes("CTF{misc-case-bits}")), "大小写位隐写提取");
sol = await ctx.miscExpert.solveData(binaryEncode("CTF{misc-binary}"));
assert.ok(sol.solved && sol.steps.some((s) => s.flags.includes("CTF{misc-binary}")), "二进制串解出 flag");
sol = await ctx.miscExpert.solveData(decimalEncode("CTF{misc-decimal}"));
assert.ok(sol.solved && sol.steps.some((s) => s.flags.includes("CTF{misc-decimal}")), "十进制 ASCII 列表解出 flag");
sol = await ctx.miscExpert.solveData([...("CTF{misc-reverse}")].reverse().join(""));
assert.ok(sol.solved && sol.steps.some((s) => s.flags.includes("CTF{misc-reverse}")), "反转字符串解出 flag");
sol = await ctx.miscExpert.solveData(morseEncode("this is misc morse"));
assert.ok(sol.solved && sol.steps.some((s) => s.kind === "morse" && s.text.includes("misc")), "摩斯解码出可读文本");
sol = await ctx.miscExpert.solveData(Buffer.from("CTF{misc-hex}").toString("hex"));
assert.ok(sol.solved && sol.steps.some((s) => s.flags.includes("CTF{misc-hex}")), "hex 解出 flag");
ok("求解管线：base32/零宽/大小写位/二进制/十进制/反转/摩斯/hex 全部解出");

// 噪声不可解
sol = await ctx.miscExpert.solveData("zzzzqqqqwwww");
assert.equal(sol.solved, false, "噪声输入不可解");
ok("噪声输入正确判为不可解");

await ctx.fiber.dispose();
//#endregion

//#region B. 任务执行 + verifier 校验
console.log("== B. 任务执行 + verifier 校验 ==");
ctx = await bootTree({ miscConfig: { autoClaim: false } });
const evB = [];
ctx.on("misc-expert/task-done", (p) => evB.push(p));

await ctx.miscExpert.executeTask({
	planId: "plan-m1",
	task: { id: "t1", phase: "recon", title: "信息收集", description: "审题" },
	challenge: { description: "一个杂项题目，可能是编码题。", attachments: [{ name: "data.txt", note: "待解数据" }] }
});
const clues1 = await ctx.blackboard.get("clues", "plan-m1:t1:notes");
assert.ok(clues1.some((c) => JSON.stringify(c.clue).includes("编码")), "recon 识别题型");

await ctx.miscExpert.executeTask({
	planId: "plan-m2",
	task: { id: "t2", phase: "analysis", title: "分析", description: "隐写检测" },
	challenge: { description: "misc 题目", data: `可见文本 ${zeroWidthEncode("CTF{misc-hidden}")} 结尾` }
});
const clues2 = await ctx.blackboard.get("clues", "plan-m2:t2:notes");
assert.ok(clues2.some((c) => JSON.stringify(c.clue).includes("零宽")), "analysis 识别零宽隐写");

const resultB = await ctx.miscExpert.executeTask({
	planId: "plan-m3",
	task: { id: "t3", phase: "exploit", title: "求解实现", description: "解码" },
	challenge: { description: "misc 题目", data: base32Encode(Buffer.from("CTF{misc-verify-chain}")) }
});
assert.equal(resultB.status, "done");
await waitFor(async () => {
	const hit = (await ctx.blackboard.search("CTF{misc-verify-chain}")).find((h) => h.section === "candidate_flags");
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
	miscConfig: { autoClaim: true }
});
const b32Flag = base32Encode(Buffer.from("CTF{misc-claim}"));
const miscDesc = `一个杂项编码题目，给出一串 base32 数据：${b32Flag}，解码可得 flag。`;
await ctx.planner.start({ planId: "plan-misc", title: "misc-demo", description: miscDesc });
await waitFor(async () => {
	const p = await ctx.planner.getPlan("plan-misc");
	const t = p.tasks.filter((x) => x.phase === "recon" || x.phase === "analysis" || x.phase === "exploit");
	return t.length > 0 && t.every((x) => x.status === "done");
}, 30000);
const claimPlan = await ctx.planner.getPlan("plan-misc");
for (const t of claimPlan.tasks) {
	if (t.phase === "recon" || t.phase === "analysis" || t.phase === "exploit") {
		assert.equal(t.status, "done", `${t.id}(${t.phase}) 被 misc-expert 认领完成`);
	}
}
ok("planner 置 running → misc-expert 自动认领 recon/analysis/exploit 并完成（其它类别专家不抢）");

await ctx.fiber.dispose();
//#endregion

//#region D. 异常
console.log("== D. 异常处理 ==");
ctx = await bootTree({ miscConfig: { autoClaim: false } });
const evD = [];
ctx.on("misc-expert/task-fail", (p) => evD.push(p));

await ctx.miscExpert.executeTask({
	planId: "plan-d1",
	task: { id: "t3", phase: "exploit", title: "求解", description: "x" },
	challenge: { description: "misc 题目" }
}).catch(() => {});
const failD1 = await ctx.blackboard.get("failures", "plan-d1:t3");
assert.ok(failD1?.some((f) => f.code === "ENODATA"), "无数据 → failures(ENODATA)");

await ctx.miscExpert.executeTask({
	planId: "plan-d2",
	task: { id: "t3", phase: "exploit", title: "求解", description: "x" },
	challenge: { description: "misc 题目", data: "zzzzqqqqwwww" }
}).catch(() => {});
const failD2 = await ctx.blackboard.get("failures", "plan-d2:t3");
assert.ok(failD2?.some((f) => f.code === "ENOHIT"), "无法求解 → failures(ENOHIT)");
assert.ok(evD.some((p) => p.taskId === "t3"), "task-fail 事件发出");
assert.equal((await ctx.miscExpert.getTaskState("plan-d2", "t3")).status, "failed");
ok("无数据/无法求解 → failures + task-fail + 状态 failed");

await ctx.fiber.dispose();
//#endregion

//#region E. 取消
console.log("== E. 取消 ==");
ctx = await bootTree({ miscConfig: { autoClaim: false } });
const noise = Array.from({ length: 80000 }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)]).join("");
const pendingE = ctx.miscExpert.executeTask({
	planId: "plan-e1",
	task: { id: "t3", phase: "exploit", title: "求解", description: "x" },
	challenge: { description: "misc 题目", data: noise }
}).catch(() => ({ status: "cancelled" }));
await waitFor(async () => (await ctx.miscExpert.getTaskState("plan-e1", "t3"))?.status === "running");
await ctx.miscExpert.cancelTask("plan-e1", "t3");
const outcomeE = await pendingE;
assert.equal(outcomeE.status, "cancelled", "取消后任务以 cancelled 结束");
assert.equal((await ctx.miscExpert.getTaskState("plan-e1", "t3")).status, "cancelled");
ok("cancelTask → 求解中 abort → cancelled");
await ctx.fiber.dispose();
//#endregion

//#region F. 重启断点恢复
console.log("== F. 重启断点恢复 ==");
const RESUME_BB = join(TMP, "blackboard.resume.json");
// boot1：预置一条"执行中被中断"的 misc 任务
ctx = await bootTree({ bbFile: RESUME_BB, miscConfig: { autoClaim: false } });
await ctx.blackboard.set("challenges", "plan-rm", { planId: "plan-rm", title: "resume-misc", description: "misc 题目", attachments: [], data: base32Encode(Buffer.from("CTF{misc-restart-ok}")) });
await ctx.blackboard.set("miscExpert", "tasks/plan-rm:t3", { planId: "plan-rm", taskId: "t3", phase: "exploit", title: "求解", status: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
await ctx.fiber.dispose();

// boot2：resume → interrupt 标记 + 重新调度 → 完成
ctx = await bootTree({ bbFile: RESUME_BB, miscConfig: { autoClaim: false } });
await waitFor(async () => (await ctx.miscExpert.getTaskState("plan-rm", "t3"))?.status === "done", 30000);
const afterF = await ctx.miscExpert.getTaskState("plan-rm", "t3");
assert.equal(afterF.status, "done", "恢复后任务重新调度并完成");
const resumeFailures = await ctx.blackboard.get("failures", "plan-rm:t3");
assert.ok(resumeFailures?.some((f) => f.type === "misc-expert-interrupt"), "中断记录写入 failures(misc-expert-interrupt)");
const flagAfter = await ctx.blackboard.search("CTF{misc-restart-ok}");
assert.ok(flagAfter.some((h) => h.section === "candidate_flags"), "恢复执行解出 flag 进入 candidate_flags");
ok("重启恢复：running 任务标记 interrupt → 重新调度 → 完成（interrupt 留痕 + flag 提取）");

await ctx.fiber.dispose();
//#endregion

//#region G. 无直接文件写入
console.log("== G. 无直接文件写入 ==");
const stray = (await readdir(TMP)).filter((name) => !name.startsWith("blackboard.") && name !== "profile");
assert.deepEqual(stray, [], `misc-expert 不应直接写文件（发现: ${stray.join(", ")}）`);
ok("misc-expert 全部读写经 blackboard，无直接磁盘文件写入");
//#endregion

await rm(TMP, { recursive: true, force: true });
console.log(`\nALL ${passed} TESTS PASSED`);
process.exit(0);
//#endregion
