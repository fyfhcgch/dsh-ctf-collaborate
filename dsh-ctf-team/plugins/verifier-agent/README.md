# @dsh-external/dsh-verifier

**Verifier flag 校验插件** — CTF 候选 flag 自动校验器。监听 blackboard `candidate_flags` 分区新增条目，
自动做格式校验/垃圾过滤/去重，本地模拟校验并预留外部提交接口，结果写回 blackboard
（`verified` + `verify_msg`），失败与格式错误写入 `failures`，并通过 planner 完成任务联动/失败联动。

| | |
|---|---|
| 插件代码 | `dsh-ctf-team/plugins/verifier-agent/` |
| 服务名 | `ctx.verifier` |
| 硬性依赖 | `inject: ["blackboard", "planner"]`（两服务就绪才启动，缺失则 profile 启动失败） |
| 接收事件 | `verifier/run` `verifier/submit-one` `verifier/clear-cache` |
| 输出事件 | `verifier/verified-ok` `verifier/verified-fail` `verifier/duplicate-flag` `verifier/error`（另有 `verifier/submit-request` `verifier/run-done` `verifier/cache-cleared`） |
| 持久化 | 全部经 `ctx.blackboard.*`（单 JSON 文件原子写）；**禁止**直接读写任何 json 文件 |

## 数据流

```
planner.submitFlag / 其他插件 set
        │  blackboard/set|update (candidate_flags)
        ▼
自动抓取 → 格式校验（CTF{} / flag{} / extraPatterns / 题目 flagFormat）
        │   ├─ 失败/格式错误 → candidate_flags 写回 verified:false + failures 分区
        │   └─ 去重（verifier/seen:<sha256>）→ duplicate 标记 + verifier/duplicate-flag
        ▼
提交：mock 本地模拟（命中 mockRejectPattern 判定被拒）
     external 外部提交器（setSubmitter 注册，或 verifier/submit-request 事件）
        ▼
写回 candidate_flags：verified(boolean) + verify_msg
        ▼
planner 联动：verified-ok → completeTask(planId, taskId, {flag, verified})
             全部已判定失败 → failTask(flag 任务) → planner/fail
```

### blackboard 数据分布

| section | key | 内容 |
|---|---|---|
| `candidate_flags` | `<planId>:flag-<ts>` | 候选 flag（planner 写入），本插件合并写回 `verified`/`verify_msg`/`duplicate?` |
| `verifier` | `state` | 校验状态与计数（version/createdAt/lastRunAt/totals） |
| `verifier` | `seen:<sha256(flag)>` | 去重缓存（首次出现条目与结果） |
| `failures` | `<planId>:<taskId\|verifier>` | 校验失败记录（`verifier-format` / `verifier-reject`，数组追加） |

## 事件接口

**接收**：
```ts
ctx.emit("verifier/run");                                  // 全量补校验（无 verified 字段的条目）
ctx.emit("verifier/submit-one", { key: "plan-x:flag-..." }); // 或 { planId, flag }
ctx.emit("verifier/clear-cache");                          // 清空去重缓存与计数
```

**输出**：
| 事件 | payload 要点 |
|---|---|
| `verifier/verified-ok` | `{ planId, key, flag, taskId, verify_msg, at }` |
| `verifier/verified-fail` | `{ planId, key, flag, taskId, reason, at }` |
| `verifier/duplicate-flag` | `{ planId, key, flag, firstKey, firstVerified, at }` |
| `verifier/error` | `{ context, error, at }` |
| `verifier/submit-request` | `{ planId, flag, taskId, key, at }`（external 模式无提交器时发出，供外部执行器接管） |
| `verifier/run-done` / `verifier/cache-cleared` | 汇总 / 清缓存结果 |

## 服务 API

```ts
await ctx.verifier.verifyOne({ key } | { planId, flag }); // 校验单个 flag
await ctx.verifier.verifyAll();                            // 全量补校验 → 汇总
await ctx.verifier.getVerifiedFlags({ planId? });          // 已通过列表
ctx.verifier.setSubmitter(async ({ planId, flag, taskId, key, entry }) => ({ verified, verify_msg? }));
await ctx.verifier.clearCache();
await ctx.verifier.getState();
```

## 格式校验规则

1. 必须为字符串、非空、长度 ≤ `maxFlagLength`、不含空白/控制字符；
2. 命中任一格式：默认 `CTF{...}` / `flag{...}`（`/^(?:ctf|flag)\{[^}\s]{1,200}\}$/i`）、配置 `extraPatterns`、
   或题目级自定义格式（`challenges/<planId>.flagFormat`，字符串正则）；
3. 命中占位符黑名单（`CTF{flag}`、`CTF{xxx}`、`flag{your_flag_here}` 等，可配置）→ 格式失败；
4. 重复 flag（`verifier/seen:<sha256>` 命中）→ 标记 duplicate，不重复提交/不重复联动。

## 异常与重启恢复

- 校验失败/格式错误：写回 `verified:false` + 记录 `failures` + `verifier/verified-fail`；
- 重启恢复：插件启动时自动扫描 `candidate_flags`，对所有**没有 `verified` 字段**的历史条目补做校验
  （补上宕机期间遗漏的 flag）；校验缓存（`verifier/seen:*`、`verifier/state`）本身也在 blackboard 中，随 harness 重启保留。

## 配置

```yaml
- id: verifier
  name: '@dsh-external/dsh-verifier'
  config:
    section: 'verifier'
    mode: 'mock'              # mock（本地模拟）| external（外部提交器）
    autoVerify: true          # 启动扫描 + 监听新条目
    extraPatterns: []         # 额外 flag 格式正则（整串匹配）
    mockRejectPattern: ''     # mock 模式下命中即判定被拒（模拟提交失败）
    maxFlagLength: 512
    plannerLink: true         # 联动 planner completeTask / failTask
    dedupe: true
```

## 开发

```sh
export DSH_HARNESS_SCOPE=/path/to/deepseek-harness/node_modules/.pnpm/node_modules/@deepseek-ai
node plugins/verifier-agent/tests/boot-test.mjs   # 启动测试（自动抓取/格式/去重/失败/联动/重启恢复）
```

> 实现说明：`lib/index.js` 为可加载实现（ESM + JSDoc 类型），
> `lib/types/index.d.ts` 提供完整 TypeScript 类型面；harness 运行时不含 TS 编译链。
