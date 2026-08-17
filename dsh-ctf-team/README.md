# DSH CTF Team

`dsh-ctf-team` 是 DeepSeek Harness 的持久化 CTF 团队协作插件。0.4.0 提供工作区入口、题目管理、共享笔记、Agent 任务、证据库、better-sqlite3 持久化、SSE 实时刷新和 WebRTC 操作同步。

## 核心功能

- **题目管理**：支持 `web / pwn / crypto / rev / misc / forensic`，状态为 `pending / solving / solved`，保存描述、Flag 和附件路径。
- **团队共享笔记**：每道题只有一份共享正文，所有队员都能编辑和查看；保存后通过 SSE 通知其他已打开页面刷新，并记录最后编辑者和时间。
- **Agent 分布式任务**：设置并发上限；任务、流式思考日志和最终结果统一保存到 SQLite。Host 提供 `ctfTeamSessionFork` 适配器时，任务通过独立 Harness 会话执行。
- **证据库**：按题目归档工具输出、文件提取结果和命令日志。
- **多人同步**：中心 Host 使用 SSE 广播本机数据库变更；浏览器之间还可使用 WebRTC/P2P 同步幂等操作日志。
- **可视化面板**：Harness 侧边栏工作区区域提供 `CTF Board` 按钮，不再创建覆盖工作区的悬浮按钮；独立页面 `/ctf-team` 内置 Vue 3 + Element Plus，题目、详情、笔记、Agent、证据全部在同一面板中。
- **持久化**：默认数据库位于 `$DSH_HOME/ctf-team/ctf-team.db`，Harness 重启或插件重载后数据仍保留。

## 安装

在项目上级目录执行：

```sh
dsh plugin --profile web add file:./dsh-ctf-team
```

重启 Harness。默认配置会在 Host 平面加载插件，并启用 `/ctf-team` Web 页面与 SSE API。

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
