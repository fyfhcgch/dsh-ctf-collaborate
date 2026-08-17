//#region scripts/pack-upload.mjs
/**
 * 生成「可提交仓库」的干净打包目录：把项目源码复制到
 * <workspace>\_upload\（排除 node_modules junction / persistent_data /
 * harness 运行日志 / 测试临时产物），保持目录结构不变。
 *
 * 用途： 整个交付物就是本项目文件夹，但提交前必须剔除三类文件：
 *   1. plugins 下各包 node_modules/@deepseek-ai junction
 *      （指向本机 npx 缓存绝对路径）
 *   2. persistent_data/blackboard.json（运行时数据，克隆后自动重建）
 *   3. harness-restart.*.log（harness 运行日志）
 *
 * Usage:
 *   node scripts/pack-upload.mjs            # 生成到 _upload\
 *   node scripts/pack-upload.mjs D:\out     # 生成到指定目录
 *
 * 生成后可用 PowerShell 压缩上传：
 *   Compress-Archive -Path D:\dsh-harness-ctf-agent\_upload\* -DestinationPath dsh-harness-ctf-agent.zip
 */
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = join(HERE, "..");
const OUT = process.argv[2] ?? join(WORKSPACE, "_upload");

/** 顶层/任意层的排除规则（路径段匹配）。 */
const SKIP_SEGMENTS = new Set(["node_modules", ".tmp", ".git", "data", "_upload", "persistent_data"]);
const SKIP_FILE_RE = /^(harness-restart\..*\.log|blackboard\.json|ctf-team\.db(-wal|-shm)?|smoke\.log|diag\.log|restart-harness\.ps1|ctf-team-smoke-test\.mjs|dsh-harness-ctf-agent-upload\.zip)$/;
/** 目录名前缀（含 .tmp-xxx 变体 / 调试残留）。 */
const SKIP_DIR_RE = /^(\.tmp|\.tmp-|tmp-|diag|smoke)/;

async function copyTree(src, dst, rel) {
	await mkdir(dst, { recursive: true });
	const entries = await readdir(src, { withFileTypes: true });
	for (const entry of entries) {
		if (SKIP_SEGMENTS.has(entry.name)) continue;
		if (SKIP_DIR_RE.test(entry.name)) continue; // .tmp / .tmp-xxx / 调试残留目录
		if (entry.isSymbolicLink()) continue; // junction 一律跳过
		const from = join(src, entry.name);
		const to = join(dst, entry.name);
		if (entry.isDirectory()) {
			await copyTree(from, to, join(rel, entry.name));
		} else if (entry.isFile()) {
			if (SKIP_FILE_RE.test(entry.name)) continue;
			await cp(from, to);
			console.log("  +", join(rel, entry.name));
		}
	}
}

await rm(OUT, { recursive: true, force: true });
console.log(`[pack] 开始收集项目源码 → ${OUT}\n`);
await copyTree(WORKSPACE, OUT, WORKSPACE.split(/[\\/]/).pop());
const files = await readdir(OUT, { recursive: true }).then((list) => list.filter((f) => f.includes(".")));
console.log(`\n[pack] 完成：${files.length} 个文件已复制（排除 junction/运行时数据/日志）`);
console.log(`[pack] 下一步压缩：Compress-Archive -Path "${join(OUT, "*")}" -DestinationPath dsh-harness-ctf-agent.zip`);
//#endregion