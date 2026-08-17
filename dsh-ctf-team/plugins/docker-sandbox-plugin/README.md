# @dsh-external/dsh-docker-sandbox

**外部 Docker 沙箱执行服务** — run arbitrary commands / scripts inside disposable containers through the
**Docker Engine API**, built as a [dsh-harness](https://github.com/deepseek-ai/deepseek-harness) cordis bundle plugin.

本插件把 CTF 题目代码执行放入一次性容器，通过 Docker Engine API 完成调用；宿主机不会执行题目命令：

- **纯 HTTP 客户端，零本地 shell**：整个插件只用 `node:http` / `node:https` / `node:net` 与 Docker Engine API
  对话（`/_ping`、`/version`、`/info`、`/images/create`、`/containers/create|start|wait|kill|logs|json|archive|remove`）。
  没有任何 `child_process` / `spawn` / `exec` / `shell` 调用；
- **传输自动探测**：`baseUrl`（http(s) TCP）→ `socketPath`（unix socket）→ `npipe`（Windows named pipe）→
  自动（win32 走 `\\.\pipe\docker_engine`，否则 `/var/run/docker.sock`）。socket/named pipe 传输是手写的
  HTTP/1.1（net socket + Content-Length/chunked 解析），因此无 Docker Desktop 暴露 TCP 也能用；
- **沙箱化执行**：镜像白名单（`allowedImages`）、内存/CPU 限制、`no-new-privileges`、`PidsLimit`、
  可选断网（`networkDisabled`）、输出截断（`maxOutputBytes`）、运行超时 **SIGKILL 强杀**、
  运行结束自动 `force remove` 容器（`keepFailedContainers` 可选保留）；
- **文件/脚本注入**：`files` 与 `script` 以零依赖 **ustar tar**（`buildTar`）经
  `PUT /containers/{id}/archive` 上传进容器工作目录（默认 `/work`）；
- **全程持久化**：每次执行记录写入 blackboard（`sandbox/executions/<runId>` 全量记录、
  `sandbox/status` 守护状态与运行计数、`tool_outputs/<planId>:<taskId>` 联动），重启不丢失；
- **ctx.effect() 托管后台任务与定时器**：健康检查定时器与运行超时定时器都用 `ctx.effect()` 注册，
  fiber 销毁自动清理；`/wait` 长轮询支持 AbortSignal，插件卸载时中止全部在飞请求，disposer 排空信号量队列。

| | |
|---|---|
| Plugin code | `dsh-ctf-team/plugins/docker-sandbox-plugin/` |
| Service name | `ctx.dockerSandbox`（dsh-base 内置 `ctx.sandbox` 供 harness 自身工具沙箱使用，本插件以独立服务名注册避免冲突） |
| Hard dependency | `inject: ["blackboard"]` |
| Command channel | `ctx.emit("sandbox/command", { op, ... })` |
| Notification events | `sandbox/ready` `sandbox/ping` `sandbox/run-start` `sandbox/run-done` `sandbox/run-fail` `sandbox/error` |
| Persistence | blackboard section `sandbox`（`executions/<runId>`、`status`、`state`） |

## 配置（Config schema）

| Key | Default | 说明 |
|---|---|---|
| `section` | `"sandbox"` | blackboard 分区名 |
| `baseUrl` / `socketPath` / `npipe` | `""` | Docker Engine API 端点；空串自动探测 |
| `connectTimeoutMs` / `requestTimeoutMs` | `3000` / `30000` | API 连接/请求超时（`/wait` 除外，见下） |
| `defaultImage` | `"alpine:latest"` | 默认镜像（可被 run 参数覆盖） |
| `pullPolicy` | `"missing"` | `missing` 缺失才拉 / `always` 每次拉 / `never` 禁止拉 |
| `defaultTimeoutMs` / `maxRunTimeoutMs` | `30000` / `600000` | 运行超时与上限 |
| `maxOutputBytes` | `262144` | 单流输出截断（stdout/stderr 各） |
| `maxConcurrentRuns` | `4` | 并发执行槽位（FIFO 队列） |
| `healthCheckMs` | `30000` | 健康检查周期；`0` 关闭（`healthCheckOnStart` 控制启动探测） |
| `recordToBlackboard` | `true` | 是否持久化执行记录 |
| `recordOutputMaxChars` | `4000` | 记录里 stdout/stderr 的截断长度 |
| `allowedImages` | `[]` | 镜像正则白名单；空 = 允许全部 |
| `autoRemove` / `keepFailedContainers` | `true` / `false` | 容器清理策略 |
| `memoryLimit` / `cpus` | `"256m"` / `1` | 默认资源限制 |
| `networkDisabled` | `false` | 默认断网 |
| `defaultUser` / `defaultWorkdir` | `""` / `"/work"` | 容器用户 / 工作目录 |
| `allowPrivileged` | `false` | 禁止 privileged（安全默认） |
| `tarUploadLimit` | `10485760` | 文件注入总大小上限 |

## 使用示例

```ts
import { Context } from "@deepseek-ai/cordis";

export function apply(ctx: Context) {
  ctx.inject(["blackboard", "dockerSandbox"], async (ctx) => {
    // 1) 健康探测（不抛，daemon 不可达时 ok=false）
    const ping = await ctx.dockerSandbox.ping();
    if (!ping.ok) ctx.logger.warn("docker daemon 不可达: %s", ping.error?.message);

    // 2) 执行一条命令（超时强杀、自动清理容器、记录入库）
    const r = await ctx.dockerSandbox.run({
      image: "python:3.12-alpine",
      cmd: ["python3", "solve.py"],
      script: "print('hello from container')",      // 或 files 注入任意文件
      files: [{ name: "work/solve.py", content: "print('CTF{demo}')" }],
      env: { PYTHONUNBUFFERED: "1" },
      timeoutMs: 30000,
      planId: "plan-1", taskId: "t3"                 // 联动 tool_outputs
    });
    if (r.timedOut) { /* 超时被 SIGKILL（exitCode=137） */ }
    console.log(r.stdout, r.stderr, r.exitCode);

    // 3) 事件驱动（命令通道）
    ctx.emit("sandbox/command", { op: "ping" });
    ctx.on("sandbox/run-done", (p) => { /* ... */ });
  });
}
```

## 事件

| Event | Payload |
|---|---|
| `sandbox/ready` | `{ available, daemon, at }` — init 完成（含首次探测）后发出 |
| `sandbox/ping` | 完整 `SandboxPingResult`（每次探测/健康检查） |
| `sandbox/run-start` | `{ runId, image, cmd, script, at }` |
| `sandbox/run-done` | `{ runId, ok, exitCode, stdout, stderr, timedOut, durationMs, containerId, image, at }` |
| `sandbox/run-fail` | `{ runId, stage, error: { code, message }, at }` — 基础设施错误 |
| `sandbox/error` | `{ context, error, at }` — 后台任务/命令通道错误 |

## 安全与边界

- 绝不执行本地 shell；需要执行代码时经 Docker API 在容器内运行；
- `allowedImages` 白名单在发起任何 HTTP 请求前拦截（`EIMAGE`）；
- `privileged` 容器默认禁止（`EINVAL`），需显式 `allowPrivileged: true`；
- 输出按 `maxOutputBytes` 截断、记录按 `recordOutputMaxChars` 截断，防止黑板上 JSON 膨胀；
- daemon 不可达 = 降级模式：插件照常启动（`available=false`），健康检查持续重试，`run` 抛 `EUNREACHABLE`；
- 错误码：`EUNREACHABLE`（连接失败）、`EAPI_TIMEOUT`（API 请求超时）、`ETIMEOUT`（运行超时，已转结果）、
  `EABORTED`（插件卸载中止）、`EIMAGE`（白名单/镜像缺失）、`EPULL`（拉取失败）、`EHTTP<status>`、
  `EINVAL`（参数）、`ETAR`（tar/上传）、`EBODY`（响应过大）。

## 开发

```sh
export DSH_HARNESS_SCOPE=/path/to/deepseek-harness/node_modules/.pnpm/node_modules/@deepseek-ai

# standalone boot 测试：mock Docker daemon（HTTP）+ 真实 dsh-app-boot 装载
node plugins/docker-sandbox-plugin/tests/boot-test.mjs

# 全插件集成装载测试（8 个外部插件 + dsh-ctf-team）
node tests/integration-boot-test.mjs
node tests/merge-ctf-team-boot-test.mjs
```

standalone 测试使用本地 mock Docker Engine API，不需要实际 Docker daemon。生产环境没有 daemon 时，插件仍会启动并进入 `available=false` 的降级模式，`run()` 返回 `EUNREACHABLE`。
