# @dsh-external/dsh-crypto-expert

**密码专项专家插件** — 认领 planner 派发的 crypto 类子任务（recon / analysis / exploit），内置离线
算法识别与求解器，产出经 blackboard 持久化，并通过 planner 回报任务状态。

| | |
|---|---|
| 插件代码 | `D:\dsh-harness-ctf-agent\plugins\crypto-expert-agent\` |
| 服务名 | `ctx.cryptoExpert` |
| 硬性依赖 | `inject: ["blackboard", "planner"]`（缺失则 profile 启动失败） |
| 接收事件 | `crypto-expert/execute-task`（`{planId, task, challenge?}`）、`crypto-expert/cancel-task`；另监听 `planner/task-update` 自动认领 |
| 输出事件 | `crypto-expert/task-progress` `crypto-expert/task-done` `crypto-expert/task-fail`（另有 `task-claimed`、`error`） |
| 持久化 | 全部经 `ctx.blackboard.*` / `ctx.planner.*` API；**禁止**直接读写磁盘 JSON 文件 |

## 运行约束（离线优先）

- 算法识别关键字表、求解器（编码/经典密码/RSA）全部固化在本源码（纯 JS + `node:crypto` BigInt），
  运行阶段不访问 GitHub、不下载远程规则。
- 硬性依赖 `inject: ["blackboard", "planner"]`。

## 阶段执行流程

```
recon     整理题目给出的算法与参数
          ├─ 关键字识别（RSA/AES/XOR/凯撒/维吉尼亚/Base64/Hex/摩斯/培根/哈希/仿射/栅栏）
          ├─ 提取 RSA 参数（n/e/c/p/q/d）与候选密文串 → clues
analysis  参数规约与弱点识别
          ├─ RSA：模数偏小 / e=3 低指数 / p,q,e,c 齐全可直接解密
          ├─ XOR：单字节异或可读性探测
          └─ 字母分布 → 凯撒/ROT 爆破候选
exploit   内置求解管线（对 challenge.ciphertext / params / description 提取的候选密文）
          Base64 → Hex → URL → ROT13 → 凯撒爆破 → 单字节 XOR → 多字节 XOR → RSA
          （解出含 flag 或高可读性明文即命中）
```

### 数据流转（全部经 blackboard）

| section | key | 内容 |
|---|---|---|
| `clues` | `<planId>:<taskId>:notes` | 算法识别/弱点/破解结论（append） |
| `tool_outputs` | `<planId>:<taskId>` | 求解过程输出（尝试与结果，append） |
| `candidate_flags` | （经 `ctx.planner.submitFlag`） | 明文中提取的多前缀 flag → **verifier 自动校验** |
| `failures` | `<planId>:<taskId>` | 无输入/无候选密文/未解出（`crypto-expert-error`/`crypto-expert-interrupt`） |
| `cryptoExpert` | `tasks/<planId>:<taskId>` | 本插件任务运行状态 |

## 事件接口

```ts
ctx.emit("crypto-expert/execute-task", {
  planId: "plan-x",
  task: { id: "t3", phase: "exploit", title: "破解实现", description: "…" },
  challenge: { ciphertext: "aGVsbG8gQ1RGe2NyeXB0by1iYXNlNjR9", description: "crypto 题目" }
});
ctx.emit("crypto-expert/cancel-task", { planId: "plan-x", taskId: "t3" });
```

## 服务 API

```ts
await ctx.cryptoExpert.executeTask({ planId, task, challenge? }); // 执行 → CryptoTaskResult
await ctx.cryptoExpert.cancelTask(planId, taskId);
await ctx.cryptoExpert.getTaskState(planId, taskId);
await ctx.cryptoExpert.listTasks();
await ctx.cryptoExpert.analyzeText(text, { rsaParams?, maxKeyLen?, caesarTop? }); // 公开求解管线
```

## 内置求解器摘要

- **编码**：Base64、Hex（`0x` 前缀容忍）、URL 解码（自动尝试并评分）；
- **经典**：ROT13、凯撒 26 位移爆破（英文字母频率评分 topN）、摩斯电码；
- **XOR**：单字节 0–255 爆破（可打印率+频率评分）、多字节（keylen 2..maxKeyLen 逐位频率破解）；
- **RSA**：p/q/e 齐全直接解密（扩展欧几里得求 d）、e=3 低指数开立方、Fermat 分解 / 试除分解小模数，
  明文数字 → hex → ASCII/UTF-8 文本；
- **评分**：可打印率 + 英文字母频率 + 空格（`scoreText`），阈值命中即视为可读明文。

## 异常与重启恢复

- 无输入文本（ETEXT）、无候选密文（ENOCIPHER）、未解出可读明文（ENOHIT）、取消（CANCELLED）
  → `failures` 记录 + `planner.failTask` + `crypto-expert/task-fail`；
- **重启恢复**：启动时扫描 blackboard 中 `category=crypto` 且任务 `running` 的子任务 —— 本插件曾认领
  （`cryptoExpert/tasks` 记录 running）的标记 `interrupt`（写入 failures，type=`crypto-expert-interrupt`）
  并重新调度执行；未认领的 running 任务直接接管。

## 配置

```yaml
- id: cryptoExpert
  name: '@dsh-external/dsh-crypto-expert'
  config:
    section: 'cryptoExpert'
    autoClaim: true
    resumeOnStart: true
    maxXorKeyLen: 4
    caesarTop: 3
```

## 开发

```powershell
node plugins/crypto-expert-agent/tests/boot-test.mjs   # 启动测试（本地确定性密文）
```

> 实现说明：与 dsh 官方插件一致，`lib/index.js` 为可加载实现（ESM + JSDoc 类型），
> `lib/types/index.d.ts` 提供完整 TypeScript 类型面。
