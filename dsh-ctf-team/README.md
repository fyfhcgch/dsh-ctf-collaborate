# DSH CTF Team

`dsh-ctf-team` 是 DeepSeek Harness 的持久化 CTF 团队协作插件。当前版本同时提供西湖论剑·中国杭州网络安全技能大赛 AI Agent 赛的 DASCTF 平台适配器：只读同步赛事数据，按平台政策保护靶机操作和提交，并生成脱敏审计报告。本目录同时维护完成自动化 CTF 工作流所需的外部插件；仓库中不再保留旧的独立上传目录。

## 核心功能

- **题目管理**：支持 `web / pwn / crypto / rev / misc / forensic`，状态为 `pending / solving / solved`，保存描述、Flag 和附件路径。
- **团队共享笔记**：每道题只有一份共享正文，所有队员都能编辑和查看；保存后通过 SSE 通知其他已打开页面刷新，并记录最后编辑者和时间。
- **Agent 分布式任务**：设置并发上限；任务、流式思考日志和最终结果统一保存到 SQLite。Host 提供 `ctfTeamSessionFork` 适配器时，任务通过独立 Harness 会话执行。
- **证据库**：按题目归档工具输出、文件提取结果和命令日志。
- **多人同步**：默认模式由中心 Host 使用 SSE 广播本机数据库变更；也可以切换为真正的浏览器端 WebRTC/P2P 模式，数据保存在各自浏览器本地，写入通过 DataChannel 在 Peer 之间同步，不依赖中心数据库或 SSE。
- **可视化面板**：Harness 侧边栏工作区区域提供 `CTF Board` 按钮，不再创建覆盖工作区的悬浮按钮；独立页面 `/ctf-team` 内置 Vue 3 + Element Plus，题目、详情、笔记、Agent、证据全部在同一面板中。
- **持久化**：默认数据库位于 `$DSH_HOME/ctf-team/ctf-team.db`，Harness 重启或插件重载后数据仍保留。
- **DASCTF 赛事适配**：固定使用官方 Agent API 路径；同步公告、规则、题目详情、附件、状态和排名；支持在题目详情中人工确认启动/恢复环境、按平台文档自动轮询并同步 endpoint，以及人工确认后的 Flag 提交。
- **赛事安全约束**：模型完整 URL 填写后必须精确命中官方白名单；AccessKey 支持 Web 面板/API 运行时加载或环境变量注入；平台能力接口按官方 `X-Agent-AccessKey` 调用，Flag 提交保留模型 URL 审计门，单 Agent SQLite 租约、赛事时间窗、每题最多 50 次提交、Flag 格式校验和脱敏审计均由后端强制执行。

## 安装

在本目录安装并构建主插件，然后将主插件和 8 个外部插件一次写入 web Profile：

```sh
npm install
npm run build
node scripts/install-profile-plugins.mjs
```

脚本默认使用 `.profile/web`。使用现有 Profile 时设置 `DSH_PROFILE_DIR=/path/to/dsh/profiles/web`，或设置 `DSH_HOME` 后重新执行脚本。只安装主插件时，可在本目录上级执行 `dsh plugin --profile web add file:./dsh-ctf-team`。

重启 Harness。默认配置会在 Host 平面加载插件，并启用 `/ctf-team` Web 页面与 SSE API。

## Agent 插件集合

所有外部插件都位于本目录的 `plugins/`，并由 `scripts/install-profile-plugins.mjs` 与主插件一起安装：

- `blackboard-plugin`：持久化共享黑板。
- `planner-agent`：计划拆分、调度、重试和重启恢复。
- `crypto-expert-agent`、`misc-expert-agent`、`web-expert-agent`：离线优先的专项求解器。
- `verifier-agent`：候选 Flag 格式校验与计划联动。
- `submit-gateway`：`POST /api/ctf/submit` 入口。
- `docker-sandbox-plugin`：通过 Docker Engine API 执行一次性沙箱任务，不调用宿主 shell。

主插件中的 pwn/reverse 专家模板会按题目分类自动应用，`sandbox_run` 会优先委托同目录的 `dockerSandbox` 服务。

Profile 层会把 planner 切换为 `executionMode: external`，由对应专家插件认领任务；没有 Docker daemon 时 `docker-sandbox-plugin` 会保持降级状态，不影响其他插件启动。

## 使用流程

1. 所有队员打开 Harness，点击侧边栏工作区区域的 `CTF Board`；也可直接访问 `http://服务地址/ctf-team`。
2. 创建题目并填写分类、描述、附件路径和当前状态。
3. 队员在题目详情中添加笔记、证据或 Agent 任务。
4. 写操作成功后，所有连接到同一 Host 的页面通过 SSE 自动刷新。
5. 解出题目后录入 Flag，并将状态更新为 `solved`。

## 西湖论剑赛事模式

平台文档要求 Agent 使用团队 AccessKey 调用 `https://pro.dasctf.com/slab-match/api/v1/agent/*`，并把模型原始完整 URL配置为赛事手册列出的白名单地址。插件使用 `X-Agent-AccessKey` 请求头；此 AccessKey 只用于平台比赛能力接口，与大模型网关鉴权分离。插件不读取登录 JWT，AccessKey、JWT、模型 Key、靶机密码和 Flag 原文都会在审计链路脱敏。

1. 默认赛事为 `competitionId=1625`、`stageId=3071`，默认 Server Host 为 `https://pro.dasctf.com`。
2. 打开 `/ctf-team` 页面顶部的 **西湖论剑 DASCTF 平台接入** 面板，填写 Server Host、AccessKey 和可选的模型原始完整 URL，点击 **加载凭证**。AccessKey 只保存在当前 Harness 进程内存中，Harness 重启后重新填写，或改用 `DASCTF_ACCESS_KEY=<平台显示的 AccessKey>` 环境变量。
3. 也可以用 HTTP API 加载运行时凭证：

```sh
curl -X POST http://HOST:3080/ctf-team/api/platform/configure \
  -H 'Content-Type: application/json' \
  -d '{"serverHost":"https://pro.dasctf.com","accessKey":"<平台 AccessKey>","gatewayEndpoint":"https://api.deepseek.com/v1/chat/completions"}'
```

4. 使用 `GET /ctf-team/api/platform/status` 检查 AccessKey、Server Host、赛事窗口和模型 URL 白名单状态；使用 `POST /ctf-team/api/platform/clear-credentials` 清除当前进程内的运行时 AccessKey。
5. 使用 `POST /ctf-team/api/platform/sync` 同步公告、规则、题目详情和排名。同步只读平台；模型 URL 未配置时仍可同步，便于赛前导入题目与公告。
6. 对 `isNeedInit=true` 且 `endpoints=[]` 的题目，先在题目详情上方点击 **启动环境**（或需要时点 **恢复环境**）并确认；插件会按 `api_doc.md` 轮询 `/ctf/exercise`，直到同时满足 `isNeedCheck=false` 且 endpoint 已返回；若平台检查结束但 endpoint 仍为空，会提示手动同步或重试。手动补同步可点 **同步当前题 endpoint**，HTTP 方式可调用 `/platform/exercise/sync`。环境启停只需要 Server Host + AccessKey + 人工确认；请求必须携带 `confirm=true`、`confirmationText=CONFIRM`。
7. 等题目详情显示 endpoint 后再启动“解出 flag”类 Agent 任务；插件会在 endpoint 为空或 `isNeedCheck=true` 时阻止解题型 Agent fork，并在任务/思考日志中提示先完成环境初始化，避免 Agent 盲查本地源码、扫描本机端口并耗尽 DSML 轮次。
8. 提交使用 `/platform/submit`，必须携带 `confirm=true`、`confirmationText=SUBMIT`。Flag 提交需要 AccessKey、赛事窗口、单 Agent 租约、模型 URL 白名单和提交次数策略全部通过。
9. 赛事结束前使用 `GET /ctf-team/api/platform/report` 导出脱敏报告，报告内容应与队伍解题记录和平台流量保持一致。

Flag 只能提交完整的 `DASCTF{...}` 或 `flag{...}`，插件会在发往平台前转换为大括号内部内容。插件不自动爆破、重试或在赛事时间窗外提交。正式初赛前请把 `dasctfEventStartAt`、`dasctfEventEndAt` 改为当届赛事的实际时间；默认值对应当前测试赛。

## 邀请其他队员加入

当前 Web 面板采用“同一 Harness Host + 同一 SQLite 数据库”的共享模式，不需要为每个队员单独创建账号：

1. 队长启动 Harness，并确认服务监听在队员可访问的地址。
2. 将下面的地址发给队员：`http://HOST:3080/ctf-team`。
3. 队员首次打开页面后，在右上角“你的队员名”中填写自己的名字；该名字保存在自己的浏览器中，并用于共享笔记的最后编辑者和 Agent 任务 Owner。
4. 所有人使用同一个页面地址即可看到题目、共享笔记、证据和 Agent 结果；新增内容会通过 SSE 自动刷新。

`127.0.0.1` 只代表队长自己的电脑。局域网协作时请使用队长机器的局域网 IP，例如 `http://192.168.1.20:3080/ctf-team`，并确保 Harness 的 Web 服务监听外部网卡及防火墙放行 3080 端口。当前队员名用于展示和溯源，尚未加入登录/权限控制。

共享笔记不是评论列表：进入某道题的“共享笔记”标签后，编辑并保存这道题唯一的正文；其他队员打开同一道题会看到同一份内容。

## 无服务器 P2P 模式

如果不希望队员共用一台 Harness Host，可以使用侧边栏里的 `CTF Board` 进入浏览器端 P2P 模式：

1. 首先打开一次 `CTF Board`，在 `P2P` 标签点击 **进入无服务器 P2P**。这一步会把当前题目和记录复制到本机浏览器的 `localStorage`；切换成功后，题目、笔记、证据和任务记录都不再请求 HTTP API。
2. 队长点击 **生成 Offer**，把完整的邀请文本通过聊天工具发给另一名队员。
3. 对方粘贴 Offer，点击 **生成 Answer**，再把 Answer 发回队长；队长粘贴 Answer，点击 **完成连接**。
4. 连接建立后，两边会交换幂等操作日志。可以重复邀请多个 Peer，形成 WebRTC mesh；任意已连接 Peer 的新增或修改会转发到其余 Peer。

此模式不需要中心同步服务器，但首次加载插件仍需要一个能打开 Harness 面板的环境，且 Offer/Answer 的复制粘贴本身就是 WebRTC 的手动信令。默认只配置浏览器自身的 ICE 候选，通常适合局域网；跨公网或对称 NAT 时需要在 `TeamP2PController` 的 `iceServers` 中配置 STUN/TURN。Agent 在无服务器模式下只会记录任务，不会执行 Harness Agent，因为执行 Agent 必须依赖 Host。

完全从零加入一个 P2P 团队时，新 Peer 接受 Offer 会自动采用邀请中的 `teamId`；如果本机已有另一套本地数据，程序会拒绝混入不同团队。

## 配置

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
  dasctfPlatformHost: 'https://pro.dasctf.com'
  dasctfAccessKeyEnv: 'DASCTF_ACCESS_KEY'
  dasctfGatewayEndpoint: ''
  dasctfEventStartAt: '2026-08-18T09:00:00+08:00'
  dasctfEventEndAt: '2026-08-19T17:00:00+08:00'
  dasctfMaxSubmissions: 50
  dasctfLeaseTtlMs: 120000
```

- `dbPath`：better-sqlite3 数据库路径，默认开启 WAL 和外键约束。
- `agentConcurrentLimit`：同时运行的 Agent 任务上限。
- `webMountPath`：Web 面板和 HTTP API 的挂载路径。
- `enableHttpBridge`：是否启用独立 Web 面板及 SSE。
- `teamId`：WebRTC/P2P 同步使用的团队标识。
- `dasctfGatewayEndpoint`：赛事手册中的模型原始完整 URL；空值仍允许题目同步、单题 endpoint 同步和靶机启停，Flag 提交要求该值命中官方完整 URL 白名单。
- `dasctfAccessKeyEnv`：AccessKey 的环境变量名，默认 `DASCTF_ACCESS_KEY`；也可在 Web 面板或 `/platform/configure` 中运行时加载。请勿把真实值写入 profile YAML、SQLite、Git、审计正文或报告。
- `dasctfEventStartAt` / `dasctfEventEndAt`：赛事操作时间窗，默认是测试赛时间。
- `dasctfMaxSubmissions`：每题本地提交上限，最大不能超过平台规定的 50 次。

## HTTP / SSE 接口

默认挂载：

- `GET /ctf-team`
- `GET /ctf-team/api/events`
- `GET /ctf-team/api/status`
- `GET /ctf-team/api/challenges`
- `GET /ctf-team/api/challenges/:cid`
- `POST /ctf-team/api/challenges`
- `POST /ctf-team/api/challenges/:cid/update`
- `POST /ctf-team/api/challenges/:cid/delete`
- `POST /ctf-team/api/shared-note`
- `POST /ctf-team/api/notes`
- `POST /ctf-team/api/evidence`
- `POST /ctf-team/api/thoughts`
- `POST /ctf-team/api/agent/spawn`
- `GET /ctf-team/api/platform/status`
- `POST /ctf-team/api/platform/configure`（运行时加载 Server Host、AccessKey、可选模型 URL）
- `POST /ctf-team/api/platform/clear-credentials`（清除当前进程运行时 AccessKey）
- `POST /ctf-team/api/platform/sync`（只读平台同步）
- `POST /ctf-team/api/platform/exercise/build`（需人工确认）
- `POST /ctf-team/api/platform/exercise/recover`（需人工确认）
- `POST /ctf-team/api/platform/exercise/sync`（同步当前题详情与 endpoint）
- `POST /ctf-team/api/platform/submit`（需人工确认；Flag 只接受 `DASCTF{}` / `flag{}`）
- `GET /ctf-team/api/platform/audit`
- `GET /ctf-team/api/platform/report`（Markdown）

`GET /ctf-team/api/status` 返回 `{ ok, sseClients, challengeCount, platform }`，可用于确认页面后端、SQLite 黑板和 DASCTF 配置健康状态。平台适配器的提交入口是 `/ctf-team/api/platform/submit`；`submit-gateway` 的 `/api/ctf/submit` 仍是通用本地规划入口，不会代替赛事平台提交。

## Agent Host 适配器

插件优先从 Host 上读取 `ctfTeamSessionFork` 服务；若当前 Harness Profile 暴露 `ctx.session.fork()`，插件也会自动按兼容形状创建独立会话并采集流式消息：

```ts
interface CtfTeamSessionFork {
  fork(prompt: string): Promise<{
    content: string
    onMessage?(listener: (content: string) => void): () => void
  }>
}
```

`fork()` 应创建独立 Harness 会话并提交 Prompt；`onMessage()` 用于把运行过程日志实时写入题目黑板，`content` 可以是字符串或最终结果 Promise。插件会在 `agentConcurrentLimit` 内运行任务，并在 SQLite 中保存运行中任务、思考日志和最终结果。

启动 Agent 任务时，插件会自动把当前题目的 ID、标题、分类、结构化 DASCTF 题面、附件路径、共享笔记、最近个人笔记和证据注入专家 Prompt，并额外注入平台环境前置规则：如果题目需要初始化且 endpoint 为空或 `isNeedCheck=true`，Agent 应先等待面板启动/恢复环境并轮询同步当前题 endpoint，而不是搜索 Harness 源码或本机端口。后端也会对“解出 flag/solve/exploit”等解题型 Prompt 做前置拦截，直接写入“题目环境尚未就绪”的任务结果。若子 Agent 返回 DSML `shell`/`bash`/`sh`/`terminal` 调用，Host 适配器会按轮次执行命令、脱敏输出中的 AccessKey/JWT/API Key，并把结果回填给同一个子 Agent 继续总结。默认每轮最多执行 4 条命令、最多 8 轮，每条命令 120 秒超时，单轮输出按 80,000 字符限流；实时 thought 日志会去重并截断超长块，完整最终结果仍写入任务记录。

## 开发

```sh
npm install
npm run build
npm test
```

运行环境要求 Node.js 22.5 或更高版本。后端使用 `better-sqlite3`，运行 `npm install` 时需要当前平台可用的 Node 原生扩展构建/预编译环境。

主插件测试：`npm test`。完整 Harness boot 测试还需要设置 `DSH_HARNESS_SCOPE`，指向包含 `dsh-app-boot` 的 `@deepseek-ai` 安装目录：

```sh
export DSH_HARNESS_SCOPE=/path/to/deepseek-harness/node_modules/.pnpm/node_modules/@deepseek-ai
node --test tests/integration-boot-test.mjs tests/merge-ctf-team-boot-test.mjs
```

7 个可独立启动的外部插件测试位于各自的 `plugins/*/tests/boot-test.mjs`；Docker 测试使用本地 mock Docker Engine API，不要求宿主机安装 Docker。生产运行时若 Docker daemon 不可达，沙箱服务会报告 `available=false` 并让执行请求返回 `EUNREACHABLE`。
