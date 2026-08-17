# @dsh-external/dsh-planner

**Planner 总调度 Agent 插件** — CTF 主调度器：接收题目输入（`planner/start` 事件），CoT 式拆解为子任务
DAG，调度执行（就绪/超时/重试/阻塞/失败判定），并通过 **blackboard 服务**（`ctx.blackboard`，硬性依赖
`@dsh-external/dsh-blackboard`）把任务、中间结果、失败记录、候选 flag 全部持久化。支持插件/harness 重启后
从 blackboard 断点续跑未完成任务。

| | |
|---|---|
| 插件代码 | `dsh-ctf-team/plugins/planner-agent/` |
| 服务名 | `ctx.planner` |
| 输入事件 | `planner/start` |
| 输出事件 | `planner/started` `planner/task-update` `planner/flag` `planner/done` `planner/fail` `planner/resumed` `planner/cancelled` `planner/error` |
| 硬性依赖 | `blackboard` 服务（`static inject = ["blackboard"]`；缺失时 harness 启动即失败） |
| 持久化 | 全部经 `ctx.blackboard`（单 JSON 文件原子写），**禁止**直接读写 `persistent_data` 下的文件 |

## 架构与数据流

```
planner/start (题目描述+附件信息)
   │
   ▼
分解引擎 (detectCategory + CoT 模板) ──► DAG: tasks[{id, phase, deps, ...}]
   │
   ▼
调度循环 (tick): pending→ready→running →(internal 执行器 / external 执行器)→ done
   │   ├─ 超时 ──► failures 分区记录 + 重试(maxAttempts) 或 failed
   │   ├─ 依赖失败 ──► blocked
   │   └─ 全部 done ──► planner/done（汇总 candidate_flags）
   │      全部失败/阻塞 ──► planner/fail
   ▼
blackboard 持久化（全部经 ctx.blackboard，写队列+原子临时文件落盘）
```

### blackboard 分区映射

| blackboard section | key | 内容 |
|---|---|---|
| `challenges` | `<planId>` | 题目输入（标题/描述/附件/分类） |
| `planner` | `current` | 最新计划指针（断点续跑依据） |
| `planner` | `plan:<planId>` | 计划文档：任务 DAG + 各任务状态 |
| `clues` | `<planId>:<taskId>` | 任务中间结果（`completeTask` 写入） |
| `clues` | `<planId>:<taskId>:notes` | 过程线索（`addClue` 追加） |
| `tool_outputs` | `<planId>:<taskId>` | 工具输出行数组（`addToolOutput` 追加） |
| `failures` | `<planId>:<taskId>` | 失败记录数组（超时/执行失败/重启中断） |
| `candidate_flags` | `<planId>:flag-<ts>` | 候选 flag（`submitFlag` 写入，去重） |

## 事件接口

**接收**：
```ts
ctx.emit("planner/start", {
  description: "一个 web 题目，存在 SQL 注入…",
  title: "flag-shop",                       // 可选
  attachments: [{ name: "app.py", note: "源码" }],  // 可选
  planId: "plan-demo-0001",                 // 可选
  meta: { source: "upload" }                // 可选
});
```

**输出**（每个事件 payload 见 `lib/types/index.d.ts`）：
| 事件 | 触发时机 |
|---|---|
| `planner/started` | 计划创建并落盘后 |
| `planner/task-update` | 任一子任务状态变化：`ready`/`running`/`done`/`failed`/`interrupted`/`blocked`/`cancelled`（含 `retry` reason） |
| `planner/flag` | 新候选 flag 写入 |
| `planner/done` | 全部子任务完成（payload 携带 `flags` 汇总） |
| `planner/fail` | 全部剩余子任务失败/阻塞，或 `planner/start` 输入非法 |
| `planner/resumed` | 插件启动时从 blackboard 恢复未完成任务 |
| `planner/cancelled` | `ctx.planner.cancel()` |
| `planner/error` | 内部错误（记录日志并广播） |

## 服务 API（`ctx.planner`）

```ts
await ctx.planner.start({ description, title?, attachments?, planId?, meta? });
await ctx.planner.getPlan(planId);          // 读计划（fresh from blackboard）
await ctx.planner.getCurrentPlan();          // 当前计划
await ctx.planner.listPlans();               // 全部计划
// 外部执行器上报：
await ctx.planner.completeTask(planId, taskId, result, meta?);
await ctx.planner.failTask(planId, taskId, error, meta?);
await ctx.planner.addClue(planId, taskId, clue, meta?);
await ctx.planner.addToolOutput(planId, taskId, output, meta?);
await ctx.planner.submitFlag(planId, flag, source?, taskId?);
// 控制：
await ctx.planner.cancel(planId);
await ctx.planner.retryTask(planId, taskId);
```

消费者插件声明依赖：`class X { static inject = ["planner"]; ... }`（或 `ctx.inject(["planner"], fn)`）。

## 执行模型

- `executionMode: "internal"`（默认）：内置**确定性占位执行器**（无 LLM），每个任务在
  `internalDelayMs` 后产出 tool_outputs 与 clues；flag 阶段任务从题目描述与 clues 中提取
  `CTF{...}`/`flag{...}` 形态字符串写入 candidate_flags。任务 id/标题命中 `internalFailPattern`
  时确定性失败（用于演练失败路径）。
- `executionMode: "external"`：planner 只负责调度，Agent 执行插件订阅 `planner/task-update`
  事件、用 `ctx.planner.completeTask/failTask/addClue/addToolOutput/submitFlag` 回报。

## 异常处理与断点续跑

- 子任务失败：写入 `failures/<planId>:<taskId>`（type=`executor`），按 `maxAttempts` 重试，耗尽后置
  `failed`；依赖失败的后续任务置 `blocked`；全部无法推进 → `planner/fail`。
- 子任务超时：超过 `taskTimeoutMs` 的 running 任务置失败（type=`timeout`），写入 failures。
- 重启续跑：插件启动时读取 `planner/current` → 加载计划 → 将上次 `running` 的任务标记 `interrupted`
  （写入 failures，type=`interrupt`）→ 重新调度 → 发出 `planner/resumed`。所有状态都在 blackboard
  单文件中，harness/电脑重启不丢。

## 配置

```yaml
- id: planner
  name: '@dsh-external/dsh-planner'
  config:
    section: 'planner'          # planner 独占 blackboard section
    executionMode: 'internal'   # internal | external
    internalDelayMs: 400
    internalFailPattern: ''     # 例如 'exploit' 让 exploit 阶段任务确定性失败
    taskTimeoutMs: 300000
    tickMs: 250
    maxTasks: 16
    maxAttempts: 2
    resumeOnStart: true
    autoRun: true
```

## 开发

```sh
export DSH_HARNESS_SCOPE=/path/to/deepseek-harness/node_modules/.pnpm/node_modules/@deepseek-ai

# 启动测试（挂载 blackboard + planner，覆盖 DAG/持久化/失败/外部模式/超时/重启续跑）
node plugins/planner-agent/tests/boot-test.mjs
```

> 实现说明：`lib/index.js` 为可加载实现（ESM + JSDoc 类型），
> `lib/types/index.d.ts` 提供完整 TypeScript 类型面；harness 运行时不含 TS 编译链，故不提供需编译的 src。
