# dsh-ctf-collaborate

DeepSeek Harness 的 CTF 协作插件集合。仓库当前只保留 `dsh-ctf-team` 一个项目目录；原独立 CTF Agent 插件已经整合到 `dsh-ctf-team/plugins/`，可以作为一个 web Profile 一次安装。

## 功能概览

- 统一管理 `web`、`pwn`、`crypto`、`rev`、`misc` 和 `forensic` 题目及解题状态。
- 为每道题提供团队共享笔记、Flag、附件路径和证据记录。
- 支持 Agent 任务、题目上下文自动注入、DSML shell 续跑、流式思考日志去重、任务结果持久化和并发限制。
- 通过 SSE 刷新同一 Harness Host 上的协作页面，并支持 WebRTC/P2P 操作同步。
- 提供 Harness 侧边栏入口和独立的 `/ctf-team` Web 面板。
- 提供 blackboard、planner、crypto/misc/web 专家、verifier、submit-gateway 和 Docker sandbox 八个协作插件。
- 内置西湖论剑 AI Agent 赛事适配：平台只读同步、Web/API 运行时填写 Server Host 与 AccessKey、官方模型完整 URL 白名单、单 Agent 租约、提交次数/时间/格式保护和脱敏审计报告。

## 环境要求

- Node.js `>= 22.5.0`
- npm
- 已安装并可运行的 DeepSeek Harness（`dsh` 命令）
- Docker daemon（可选；不可用时 Docker sandbox 会以降级模式启动）

## 安装与运行

从 GitHub 克隆仓库后，在唯一项目目录安装依赖并构建：

```sh
git clone https://github.com/fyfhcgch/dsh-ctf-collaborate.git
cd dsh-ctf-collaborate/dsh-ctf-team
npm install
npm run build
```

将主插件和 `plugins/` 下的 8 个外部插件一次安装到 Harness 的 `web` Profile：

```sh
node scripts/install-profile-plugins.mjs
```

脚本默认使用仓库内 `.profile/web` 作为临时 Profile。使用现有 Profile 时设置 `DSH_PROFILE_DIR`，或设置 `DSH_HOME` 让脚本定位 `$DSH_HOME/profiles/web`：

```sh
DSH_PROFILE_DIR=/path/to/dsh/profiles/web node scripts/install-profile-plugins.mjs
```

随后重启 Harness 服务进程。插件默认提供 `/ctf-team` 页面；队长启动服务后，可将 `http://HOST:3080/ctf-team` 发给其他队员共同使用。只安装主插件时才使用 `dsh plugin --profile web add file:./dsh-ctf-team`。

> `127.0.0.1` 只代表当前机器。局域网协作时，请使用队长机器的局域网 IP，并确保 Harness 监听外部网卡且防火墙放行 3080 端口。

## 开发与测试

```sh
cd dsh-ctf-team
npm install
npm run build
npm test
```

完整 Harness boot 测试需要设置 `DSH_HARNESS_SCOPE`，指向包含 `dsh-app-boot` 的 `@deepseek-ai` 目录：

```sh
export DSH_HARNESS_SCOPE=/path/to/deepseek-harness/node_modules/.pnpm/node_modules/@deepseek-ai
node --test tests/integration-boot-test.mjs tests/merge-ctf-team-boot-test.mjs
```

也可以运行各外部插件的独立 boot 测试：

```sh
node plugins/blackboard-plugin/tests/boot-test.mjs
node plugins/planner-agent/tests/boot-test.mjs
node plugins/crypto-expert-agent/tests/boot-test.mjs
node plugins/misc-expert-agent/tests/boot-test.mjs
node plugins/web-expert-agent/tests/boot-test.mjs
node plugins/verifier-agent/tests/boot-test.mjs
node plugins/docker-sandbox-plugin/tests/boot-test.mjs
```

也可以分别构建 Web UI、后端和客户端：

```sh
npm run build:web
npm run build:backend
npm run build:client
```

## 目录结构

- `dsh-ctf-team/src/` — TypeScript 源码及 Web UI 源码
- `dsh-ctf-team/tests/` — Node.js 测试用例
- `dsh-ctf-team/plugins/` — 与主插件一起维护的 8 个外部 CTF 插件
- `dsh-ctf-team/scripts/install-profile-plugins.mjs` — 一次安装完整 web Profile
- `dsh-ctf-team/cordis-manifest.yml` / `dsh-ctf-team/cordis.patch.yml` — Harness 插件配置
- `dsh-ctf-team/package.json` — npm 包信息、依赖和构建脚本
- `dsh-ctf-team/README.md` — 功能、配置和 HTTP/SSE 接口说明

构建生成的 `dist/`、依赖目录 `node_modules/`、本地 SQLite 数据库和浏览器/IDE 运行日志均不会提交到仓库，详见根目录 `.gitignore`。

## 配置

插件默认将数据库保存到 `$DSH_HOME/ctf-team/ctf-team.db`。如需覆盖配置，可使用：

```yaml
config:
  dbPath: ./data/ctf-team.db
  agentConcurrentLimit: 4
  webMountPath: /ctf-team
  enableHttpBridge: true
  teamId: ctf-team
  dasctfEnabled: true
  dasctfCompetitionId: '1625'
  dasctfStageId: '3071'
  dasctfAccessKeyEnv: 'DASCTF_ACCESS_KEY'
  dasctfGatewayEndpoint: ''
```

更多配置项、使用流程、Agent Host 适配器和 HTTP/SSE 接口，请参阅 [`dsh-ctf-team/README.md`](dsh-ctf-team/README.md)。

赛事调试时可在 `/ctf-team` 顶部面板或 `POST /ctf-team/api/platform/configure` 填写 Server Host 与 AccessKey，也可用进程环境变量 `DASCTF_ACCESS_KEY` 注入；AccessKey 只用于平台比赛能力接口，与模型网关鉴权分离。请勿把 AccessKey、登录 JWT 或模型 API Key 写入仓库。平台适配器默认不自动同步、不自动启停靶机、不自动提交，也不自动重试。

## 当前限制

- Docker sandbox 只通过 Docker Engine API 执行容器，不会在宿主机执行题目命令；没有 Docker daemon 时插件仍会启动，但执行请求返回 `EUNREACHABLE`。
- `/api/ctf/submit` 由独立的 submit-gateway 插件提供，默认路径为 `http://HOST:3080/api/ctf/submit`。
- 当前协作页面没有登录和权限控制；需要在可信网络中使用，并自行配置 Harness 的监听地址和防火墙。
- 赛事 API 写操作仍依赖可信的 Harness 网络访问；虽然后端要求人工确认文本、租约和时间/次数策略，但部署时仍应限制 3080 端口的访问范围。

## 许可

当前仓库未单独声明开源许可证；如需对外分发，请先确认项目许可证和 DeepSeek Harness 的使用要求。
