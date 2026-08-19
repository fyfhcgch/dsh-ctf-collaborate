# DSH CTF Console

`@dsh-external/dsh-ctf-console` 是 DeepSeek Harness / DSH Web GUI 的 CTF 解题控制台插件。它在左侧侧边栏和会话头部提供 `🖥️ CTF` 入口，并在右侧独立详情面板中集成平台题目、靶机环境、自动化解题流水线、队伍协作和最终 flag 提交。

## 功能概览

- **独立控制台面板**：通过侧边栏或会话头部按钮打开，不占用聊天区。
- **DASCTF 平台接入**：配置 `serverHost` 与 `AccessKey` 后，加载题目列表、题目详情、公告、积分排名。
- **环境管理**：支持启动和回收单题靶机环境，并刷新 endpoint 状态。
- **CTF Board 同步**：控制台配置会同步到 `CTF Board`，题目可写入共享题库。
- **自动化解题流水线**：点击“开始解题”会启动旧审计链路：
  `Planner → 多专家插件 → Blackboard → Verifier`。
- **当前对话接管**：如果从会话头部 `🖥️ CTF` 入口打开过控制台，开始解题后会自动把题目信息提交到当前对话，让当前 agent 直接接管解题。
- **队伍协作模式**：队长发布题库，队员同步题目并提交候选 flag，最终由队长汇总提交。

## 队伍协作流程

### 队长

1. 在控制台配置平台 `serverHost` 与 `AccessKey`。
2. 点击“加载题目”。
3. 点击“队长发布题库”，将平台题目发布到 `CTF Board` 共享题库。
4. 查看队员汇总的候选 flag 和证据。
5. 在题目详情中使用“队长提交最终 flag”统一提交。

### 队员

1. 打开控制台，将身份切换为“队员”，填写队员名称。
2. 点击“同步队伍题目”，从 `CTF Board` 获取队长发布的题目。
3. 选择题目并独立解题。
4. 在“候选 flag 汇总”中填写候选 flag、证据或复现步骤。
5. 点击“汇总给队长”。候选 flag 会写入 `CTF Board` evidence/note，并更新题目的候选 flag 字段。

## 数据流

```text
队长平台凭据
  ↓
CTF Console /api/ctf-console/*
  ↓
DASCTF 平台 API

队伍共享题库 / 候选 flag / 证据
  ↓
CTF Console 前端
  ↓
CTF Board API (/ctf-team/api/*)
  ↓
CTF Board SQLite / SSE 同步
```

## 入口和路由

### Client UI

- `sidebar.footer.action`：左侧侧边栏按钮。
- `conversation.session.header.actions`：会话头部按钮，用于捕获当前会话 `inputActions`。
- `details`：右侧独立详情面板。

### Host API

插件 Host 侧注册前缀路由：

```text
/api/ctf-console/*
```

主要动作：

- `configure`：配置平台地址与 AccessKey。
- `status`：查看控制台平台配置状态。
- `overview`：加载积分和排名。
- `notices`：加载比赛公告。
- `list`：加载平台题目列表。
- `detail`：加载单题详情。
- `build`：启动题目环境。
- `recover`：回收题目环境。
- `submit`：提交 flag。
- `solve`：启动 Planner 自动化解题流水线。

## 依赖关系

推荐与以下插件一起启用：

- `dsh-ctf-team`：提供 `CTF Board`、SQLite 数据层、SSE 同步、平台适配器。
- `@dsh-external/dsh-blackboard`：旧审计流水线黑板。
- `@dsh-external/dsh-planner`：自动化任务规划。
- `@dsh-external/dsh-web-expert` / `crypto` / `misc` 等专家插件：执行专项分析。
- `@dsh-external/dsh-verifier`：候选 flag 校验。

## 安装到 DSH profile

在 DSH profile 的 `package.json` 中加入依赖和 bundle：

```json
{
  "dependencies": {
    "@dsh-external/dsh-ctf-console": "link:C:/Users/Lenovo/dsh-ctf-collaborate/dsh-ctf-team/plugins/ctf-console"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@dsh-external/dsh-ctf-console"
      ]
    }
  }
}
```

插件自身通过 `cordis.patch.yml` 挂载：

```yaml
- insert:
    - id: ctf-console
      name: '@dsh-external/dsh-ctf-console'
```

## 注意事项

- AccessKey 只应在授权比赛环境中使用，不应写入仓库或 README。
- 控制台 Host 侧使用正式插件环境中的 `globalThis.fetch` 调用平台 API；动态 Cordis 插件沙箱不适合直接复用该网络逻辑。
- Client 文件必须保持 `window.__ModuleLoader__.load(...)` 包装格式，不能改成裸 ESM。
- 修改 Host 逻辑通常需要重启 DSH；仅修改 Client UI 通常刷新页面即可。
- 队员不应直接提交平台 flag；默认由队长统一提交，便于审计和避免重复提交。
