# @dsh-external/dsh-web-expert

**Web 专项专家插件** — 认领 planner 派发的 web 类子任务（recon / audit / exploit），按内置离线规则执行
站点信息探测、目录爆破、备份/源码泄露审计与 SQLi/LFI/SSTI payload 尝试，产出全部经 blackboard 持久化，
并通过 planner 回报任务状态。

| | |
|---|---|
| 插件代码 | `D:\dsh-harness-ctf-agent\plugins\web-expert-agent\` |
| 服务名 | `ctx.webExpert` |
| 硬性依赖 | `inject: ["blackboard", "planner"]`（两服务就绪才启动，缺失则 profile 启动失败） |
| 接收事件 | `web-expert/execute-task`（`{planId, task, challenge?}`）、`web-expert/cancel-task`；另监听 `planner/task-update` 自动认领 |
| 输出事件 | `web-expert/task-progress` `web-expert/task-done` `web-expert/task-fail`（另有 `web-expert/task-claimed` `web-expert/error`） |
| 持久化 | 全部经 `ctx.blackboard.*` / `ctx.planner.*` API；**禁止**直接读写磁盘 JSON 文件 |

## 运行约束（离线优先）

- **离线运行**：目录字典（`DIR_DICTIONARY`）、备份/泄露路径（`LEAK_PATHS`）、SQLi/SSTI/LFI payload
  集合、指纹启发规则、SQL 报错特征全部固化在本插件源码；运行阶段**不访问 GitHub、不下载远程
  payload/规则库**。
- **独立 HTTP 客户端**：基于 `node:http/https` 直连，**不读取** `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`；
  本地回环与进程间通信绝不走代理（避免调度变慢、测试随机超时）。仅允许 `http/https` 协议，带超时、
  手动重定向、响应大小上限。
- **业务范式参考**：NUSGreyhats/ctf-agent-workstation（flag 五前缀检测 `flag{}/CTF{}/HTB{}/picoCTF{}/自定义`、
  状态持久化）、verialabs/ctf-agent（协调器-求解器分工）与 nyuctf_agents 的公开设计文档，仅借鉴流程，
  不复制源码。

## 执行流程（按阶段）

```
recon   站点基础信息探测
        ├─ 首页请求 → 响应头指纹（Server/X-Powered-By/Set-Cookie）、框架特征、页面标题
        └─ /robots.txt /sitemap.xml 探测
audit   内置字典目录爆破（并发池，maxDirProbe 上限）+ 备份/源码泄露专项审计
        （.git/HEAD、.env、*.bak/*.swp、backup.zip、db.sql、package.json …）
exploit 注入点（URL query 参数，无参数时内置常见参数名启发）：
        ├─ SQLi：' OR 1=1-- / UNION SELECT … → SQL 报错特征
        ├─ LFI ：../../../../etc/passwd / php://filter → root: / base64 特征
        └─ SSTI：{{7*7}} / ${7*7} / <%= 7*7 %> → 49 / 7777777 / config 特征
```

### 数据流转（全部经 blackboard）

| section | key | 内容 |
|---|---|---|
| `clues` | `<planId>:<taskId>:notes` | 中间线索：指纹/目录发现/利用结论（append） |
| `tool_outputs` | `<planId>:<taskId>` | 工具原始回显：请求行/状态码/响应摘要/错误（append） |
| `candidate_flags` | （经 `ctx.planner.submitFlag`） | 从响应文本提取的多前缀 flag → **verifier 自动校验** |
| `failures` | `<planId>:<taskId>` | 超时/连接拒绝/利用失败（`web-expert-request`/`web-expert-error`/`web-expert-interrupt`） |
| `webExpert` | `tasks/<planId>:<taskId>` | 本插件任务运行状态（running/done/failed/cancelled/interrupted） |

## 事件接口

```ts
// 手动/编排器派发（planId + planner 任务对象 + 挑战上下文）
ctx.emit("web-expert/execute-task", { planId: "plan-x", task: { id: "t1", phase: "recon", title: "信息收集", description: "…" }, challenge: { url: "http://10.0.0.5:3000", description: "…" } });
// 取消
ctx.emit("web-expert/cancel-task", { planId: "plan-x", taskId: "t1" });
// planner 自动认领：external 模式下 planner 把 web 计划任务置 running 时自动接管
```

输出事件 payload 见 `lib/types/index.d.ts`：`task-progress`（每步）、`task-done`（携带 findings/urls）、
`task-fail`（error/reason）、`task-claimed`、`error`。

## 服务 API

```ts
await ctx.webExpert.executeTask({ planId, task, challenge?, options? }); // 执行 → WebTaskResult
await ctx.webExpert.cancelTask(planId, taskId);
await ctx.webExpert.getTaskState(planId, taskId);
await ctx.webExpert.listTasks();
await ctx.webExpert.probeUrl(url, options?); // 底层探测封装
```

## 异常处理与重启断点恢复

- 网络超时（ETIMEDOUT）、连接拒绝（ECONNREFUSED）、主机不可达、利用无命中（ENOHIT）→ `failures` 分区
  记录详情（code/message/url）+ `planner.failTask` + `web-expert/task-fail`；
- 单请求网络错误不中断整任务：记录 failures 后继续后续步骤；
- **重启恢复**：启动时扫描 blackboard 中 `category=web` 且任务状态 `running` 的子任务 —— 本插件曾认领
  （`webExpert/tasks` 记录 running）的标记 `interrupt`（写入 failures，type=`web-expert-interrupt`）并
  重新调度执行；未认领的 running 任务直接接管（autoClaim）。

## 配置

```yaml
- id: webExpert
  name: '@dsh-external/dsh-web-expert'
  config:
    section: 'webExpert'
    autoClaim: true          # 监听 planner/task-update 自动认领
    timeoutMs: 8000
    maxRedirects: 3
    maxResponseBytes: 262144
    maxDirProbe: 40          # 每次目录爆破路径上限
    concurrentRequests: 4
    userAgent: 'dsh-web-expert/0.1 (offline CTF agent)'
    resumeOnStart: true
```

## 开发

```powershell
node plugins/web-expert-agent/tests/boot-test.mjs   # 启动测试（本地回环靶场）
```

> 实现说明：与 dsh 官方插件一致，`lib/index.js` 为可加载实现（ESM + JSDoc 类型），
> `lib/types/index.d.ts` 提供完整 TypeScript 类型面；harness 运行时不含 TS 编译链。
