//#region scripts/install-profile-plugins.mjs
/**
 * 把 8 个 CTF 插件落盘到 `@deepseek-ai/dsh` 的 web profile —— 等价于
 * `dsh plugin --profile web add link:<repo>/dsh-ctf-team/plugins/<dir>`
 * 逐一执行后的最终磁盘状态（本环境无 pnpm，故用手动等价物）：
 *
 *   1. profile package.json：
 *        dependencies:   8 个插件 link: 指向插件目录
 *        dsh.profile.bundles: 8 个包名（追加到官方 bundle 之后）
 *   2. profile node_modules/@dsh-external → plugins/ junction
 *      （pnpm link: 的落盘形态；loader 按包名解析）
 *   3. profile cordis.patch.yml：profile 层覆盖 planner 配置
 *      （executionMode: external —— 由各专家插件认领执行，而非
 *      planner 内置占位执行器），并保留原文件备份
 *
 * 幂等：已装过则跳过并打印现状。进程重启（dsh web 重新拉起）时，这些
 * 插件随 profile 自动装载。
 *
 * 注意：web profile 实际位于 $env:DSH_HOME 之下（本机 D:\dsh_data\profiles\web），
 * 该路径可被 `dsh web --dump-config` 校验。
 *
 * Usage: node scripts/install-profile-plugins.mjs
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = join(HERE, "..");
// web profile 的实际位置（$env:DSH_HOME 由 dsh 启动方设置；本机为 D:\dsh_data）
const PROFILE_DIR = process.env.DSH_PROFILE_DIR
	?? (process.env.DSH_HOME ? join(process.env.DSH_HOME, "profiles", "web") : join(WORKSPACE, ".profile", "web"));
/** 插件目录 → 包名（与各插件 package.json 的 name 一致）。 */
const PLUGINS = [
	["plugins/blackboard-plugin", "@dsh-external/dsh-blackboard"],
	["plugins/planner-agent", "@dsh-external/dsh-planner"],
	["plugins/crypto-expert-agent", "@dsh-external/dsh-crypto-expert"],
	["plugins/misc-expert-agent", "@dsh-external/dsh-misc-expert"],
	["plugins/web-expert-agent", "@dsh-external/dsh-web-expert"],
	["plugins/verifier-agent", "@dsh-external/dsh-verifier"],
	["plugins/submit-gateway", "@dsh-external/dsh-submit-gateway"],
	// docker-sandbox：以 dockerSandbox 服务名注册 —— dsh-base 内置的
	// `sandbox` 行（@deepseek-ai/dsh-sandbox-local，提供 ctx.sandbox）服务于
	// harness 自身工具沙箱，不能占用；插件 patch 行 id 亦为 dockerSandbox。
	["plugins/docker-sandbox-plugin", "@dsh-external/dsh-docker-sandbox"],
	// dsh-ctf-team：分享包融合（B 方案）——团队黑板 WebUI/SSE/pwn-reverse
	// 子 agent；sandbox_run 工具委托 ctx.dockerSandbox（纯 HTTP），不 spawn CLI。
	[".", "dsh-ctf-team"]
];

/** profile 层覆盖：把 planner 切成 external 执行（多 Agent 认领协同）。 */
const PATCH_LAYER = `# dsh CTF plugin profile layer — applied over the bundle layers.
# planner 使用 external 模式：由各专项专家插件（crypto/misc/web-expert）
# 经事件总线认领子任务执行；verifier 负责 flag 校验；sandbox 提供外部
# docker 沙箱执行（daemon 不可达时降级，不影响启动）。
- id: planner
  config:
    executionMode: external
    tickMs: 250
    taskTimeoutMs: 300000
    maxAttempts: 2
    autoRun: true
`;

const packageFile = join(PROFILE_DIR, "package.json");
const patchFile = join(PROFILE_DIR, "cordis.patch.yml");

async function installJunction() {
	const scope = join(PROFILE_DIR, "node_modules", "@dsh-external");
	await mkdir(scope, { recursive: true });
	const { symlink } = await import("node:fs");
	for (const [dir, pkg] of PLUGINS) {
		const packageDir = pkg.includes("/") ? pkg.split("/")[1] : pkg;
		const link = join(scope, packageDir);
		if (existsSync(link)) continue;
		const source = join(WORKSPACE, dir);
		await new Promise((resolve, reject) => symlink(source, link, process.platform === "win32" ? "junction" : "dir", (error) => error ? reject(error) : resolve()));
		console.log("[link]", link, "→", source);
	}
}

async function main() {
	const raw = await readFile(packageFile, "utf8");
	const manifest = JSON.parse(raw);
	const existing = new Set(Object.keys(manifest.dependencies ?? {}));
	const bundles = new Set(manifest.dsh?.profile?.bundles ?? []);

	// 备份（仅在首次落盘前）
	if (!PLUGINS.some(([, pkg]) => existing.has(pkg))) {
		const bak = `${packageFile}.bak-${Date.now()}`;
		await rename(packageFile, bak);
		const patchBak = `${patchFile}.bak-${Date.now()}`;
		if (existsSync(patchFile)) await rename(patchFile, patchBak);
		console.log("[backup]", bak, "/", patchBak);
	} else {
		console.log("[backup] 已落盘过，跳过备份");
	}

	// dependencies（link: 形态，等价 pnpm add link:... 的落盘）
	const dependencies = { ...manifest.dependencies };
	for (const [dir, pkg] of PLUGINS) {
		if (!existing.has(pkg)) {
			dependencies[pkg] = `link:${join(WORKSPACE, dir).replace(/\\/g, "/")}`;
		}
	}

	// bundles（官方 bundle 之后追加）
	const nextBundles = [...bundles];
	for (const [, pkg] of PLUGINS) {
		if (!nextBundles.includes(pkg)) nextBundles.push(pkg);
	}

	manifest.dependencies = dependencies;
	manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: nextBundles } };
	await writeFile(packageFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	console.log("[package.json] 已写入", PLUGINS.length, "个插件依赖 + bundles");

	// profile patch 层（planner external 覆盖）
	if (!(await readFile(patchFile, "utf8")).includes("executionMode: external")) {
		await writeFile(patchFile, PATCH_LAYER, "utf8");
		console.log("[cordis.patch.yml] 已写入 planner external 覆盖");
	} else {
		console.log("[cordis.patch.yml] 已存在 planner external 覆盖，跳过");
	}

	await installJunction();

	// 校验
	for (const [, pkg] of PLUGINS) {
		const packageDir = pkg.includes("/") ? pkg.split("/")[1] : pkg;
		const resolved = join(PROFILE_DIR, "node_modules", "@dsh-external", packageDir, "package.json");
		if (!existsSync(resolved)) throw new Error(`解析失败: ${pkg} → ${resolved}`);
	}
	console.log(`\n[OK] ${PLUGINS.length} 个插件已在 web profile 落盘完成；下次 dsh web 重启自动拉起。`);
	console.log("     插件源码根目录:", WORKSPACE);
	console.log(`     profile 目录: ${PROFILE_DIR}`);
}

main().catch((error) => {
	console.error("[FAIL]", error);
	process.exit(1);
});
//#endregion
