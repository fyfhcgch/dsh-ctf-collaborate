# dsh-ctf-collaborate

DSH CTF 协作插件代码仓库，为 DeepSeek Harness 提供多人 CTF 题目管理、共享笔记、Agent 任务和证据整理能力。

## 功能概览

- 统一管理 `web`、`pwn`、`crypto`、`rev`、`misc` 和 `forensic` 题目及解题状态。
- 为每道题提供团队共享笔记、Flag、附件路径和证据记录。
- 支持 Agent 任务、流式思考日志、任务结果持久化和并发限制。
- 通过 SSE 刷新同一 Harness Host 上的协作页面，并支持 WebRTC/P2P 操作同步。
- 提供 Harness 侧边栏入口和独立的 `/ctf-team` Web 面板。

## 环境要求

- Node.js `>= 22.5.0`
- npm
- 已安装并可运行的 DeepSeek Harness（`dsh` 命令）

## 安装与运行

从 GitHub 克隆仓库后，在插件目录安装依赖并构建：

```sh
git clone https://github.com/fyfhcgch/dsh-ctf-collaborate.git
cd dsh-ctf-collaborate/dsh-ctf-team
npm install
npm run build
```

回到仓库根目录后执行以下命令，将本地插件安装到 Harness 的 `web` Profile：

```sh
cd ..
dsh plugin --profile web add file:./dsh-ctf-team
```

随后重启 Harness 服务进程。插件默认提供 `/ctf-team` 页面；队长启动服务后，可将 `http://HOST:3080/ctf-team` 发给其他队员共同使用。

> `127.0.0.1` 只代表当前机器。局域网协作时，请使用队长机器的局域网 IP，并确保 Harness 监听外部网卡且防火墙放行 3080 端口。

## 开发与测试

```sh
cd dsh-ctf-team
npm install
npm run build
npm test
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
```

更多配置项、使用流程、Agent Host 适配器和 HTTP/SSE 接口，请参阅 [`dsh-ctf-team/README.md`](dsh-ctf-team/README.md)。

## 许可

当前仓库未单独声明开源许可证；如需对外分发，请先确认项目许可证和 DeepSeek Harness 的使用要求。
