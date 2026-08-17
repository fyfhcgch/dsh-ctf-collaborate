# DSH CTF Team

`dsh-ctf-team` 是 DeepSeek Harness 的持久化 CTF 团队协作插件。0.4.0 提供工作区入口、题目管理、共享笔记、Agent 任务、证据库、better-sqlite3 持久化、SSE 实时刷新和 WebRTC 操作同步。本目录同时维护完成自动化 CTF 工作流所需的 8 个外部插件；仓库中不再保留旧的独立上传目录。

## 核心功能

- **题目管理**：支持 `web / pwn / crypto / rev / misc / forensic`，状态为 `pending / solving / solved`，保存描述、Flag 和附件路径。
- **团队共享笔记**：每道题只有一份共享正文，所有队员都能编辑和查看；保存后通过 SSE 通知其他已打开页面刷新，并记录最后编辑者和时间。
- **Agent 分布式任务**：设置并发上限；任务、流式思考日志和最终结果统一保存到 SQLite。Host 提供 `ctfTeamSessionFork` 适配器时，任务通过独立 Harness 会话执行。
- **证据库**：按题目归档工具输出、文件提取结果和命令日志。
- **多人同步**：默认模式由中心 Host 使用 SSE 广播本机数据库变更；也可以切换为真正的浏览器端 WebRTC/P2P 模式，数据保存在各自浏览器本地，写入通过 DataChannel 在 Peer 之间同步，不依赖中心数据库或 SSE。
- **可视化面板**：Harness 侧边栏工作区区域提供 `CTF Board` 按钮，不再创建覆盖工作区的悬浮按钮；独立页面 `/ctf-team` 内置 Vue 3 + Element Plus，题目、详情、笔记、Agent、证据全部在同一面板中。
- **持久化**：默认数据库位于 `$DSH_HOME/ctf-team/ctf-team.db`，Harness 重启或插件重载后数据仍保留。

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
```

- `dbPath`：better-sqlite3 数据库路径，默认开启 WAL 和外键约束。
- `agentConcurrentLimit`：同时运行的 Agent 任务上限。
- `webMountPath`：Web 面板和 HTTP API 的挂载路径。
- `enableHttpBridge`：是否启用独立 Web 面板及 SSE。
- `teamId`：WebRTC/P2P 同步使用的团队标识。

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

`GET /ctf-team/api/status` 返回 `{ ok, sseClients, challengeCount }`，可用于确认页面后端和 SQLite 黑板已经加载。submit-gateway 的独立入口是 `POST /api/ctf/submit`，不是 `/ctf-team/api` 下的路由。

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
