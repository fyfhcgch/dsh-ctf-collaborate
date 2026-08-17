# @dsh-external/dsh-misc-expert

**杂项专项专家插件** — 认领 planner 派发的 misc 类子任务（recon / analysis / exploit），内置离线
编码解码、隐写初检与文本转换求解器，产出经 blackboard 持久化，并通过 planner 回报任务状态。

| | |
|---|---|
| 插件代码 | `D:\dsh-harness-ctf-agent\plugins\misc-expert-agent\` |
| 服务名 | `ctx.miscExpert` |
| 硬性依赖 | `inject: ["blackboard", "planner"]`（缺失则 profile 启动失败） |
| 接收事件 | `misc-expert/execute-task`（`{planId, task, challenge?}`）、`misc-expert/cancel-task`；另监听 `planner/task-update` 自动认领 |
| 输出事件 | `misc-expert/task-progress` `misc-expert/task-done` `misc-expert/task-fail`（另有 `task-claimed`、`error`） |
| 持久化 | 全部经 `ctx.blackboard.*` / `ctx.planner.*` API；**禁止**直接读写磁盘 JSON 文件 |

## 运行约束（离线优先）

- 题型识别关键字、编码/隐写/文本转换求解器全部固化在本源码，运行阶段不访问 GitHub。
- 硬性依赖 `inject: ["blackboard", "planner"]`。

## 阶段执行流程

```
recon     审题、整理输入数据（challenge.data / description / 附件）
          ├─ 题型识别（编码/隐写/文本转换/压缩包/图片音频/二维码）
          └─ 提取候选数据串（hex / base64 / 二进制 / 数字列表）→ clues
analysis  隐写特征检测
          ├─ 零宽字符（U+200B/U+200C 位流）
          ├─ 大小写位（大写=1 小写=0，每 8 位一组）
          └─ 首字母（行首/词首藏头）
exploit   内置求解管线（对 challenge.data / 提取的候选串）
          隐写提取 → 编码解码（Base64/32/Hex/URL/Unicode 转义/ROT13/凯撒/摩斯/培根/反转）
          → 文本转换（二进制→文本 / 十进制/十六进制/八进制→ASCII）
```

### 数据流转（全部经 blackboard）

| section | key | 内容 |
|---|---|---|
| `clues` | `<planId>:<taskId>:notes` | 题型识别/隐写发现/破解结论（append） |
| `tool_outputs` | `<planId>:<taskId>` | 求解过程输出（append） |
| `candidate_flags` | （经 `ctx.planner.submitFlag`） | 明文中提取的多前缀 flag → **verifier 自动校验** |
| `failures` | `<planId>:<taskId>` | 无输入（ETEXT/ENODATA）/未解出（ENOHIT）/取消 |
| `miscExpert` | `tasks/<planId>:<taskId>` | 本插件任务运行状态 |

## 事件接口

```ts
ctx.emit("misc-expert/execute-task", {
  planId: "plan-x",
  task: { id: "t3", phase: "exploit", title: "求解实现", description: "…" },
  challenge: { data: "01000011 01010100 01000110 …", description: "misc 题目" }
});
ctx.emit("misc-expert/cancel-task", { planId: "plan-x", taskId: "t3" });
```

## 服务 API

```ts
await ctx.miscExpert.executeTask({ planId, task, challenge? }); // 执行 → MiscTaskResult
await ctx.miscExpert.cancelTask(planId, taskId);
await ctx.miscExpert.getTaskState(planId, taskId);
await ctx.miscExpert.listTasks();
await ctx.miscExpert.solveData(data, { caesarTop? }); // 公开求解管线
```

## 内置求解器摘要

- **隐写**：零宽字符（U+200B=0/U+200C=1 位流）、大小写位（每 8 位一组转字符）、行首/词首藏头；
- **编码**：Base64、Base32、Hex（`0x` 容忍）、URL、Unicode 转义（`\uXXXX`）、ROT13、凯撒 26 位移爆破、摩斯、培根（24 字母）；
- **文本转换**：二进制串→ASCII、字符串反转、十进制/十六进制/八进制数字列表→ASCII；
- **判定**：可读性评分（可打印率+字母频率+空格−控制字符重罚）+ flag 形态奖励（CTF/flag/picoCTF/HTB 多前缀）；flag 为主判定，无 flag 时要求高可读且含空格。

## 异常与重启恢复

- 无输入（ETEXT/ENODATA）、未解出（ENOHIT）、取消（CANCELLED）→ `failures` + `planner.failTask` + `misc-expert/task-fail`；
- **重启恢复**：启动时扫描 blackboard 中 `category=misc` 且任务 `running` 的子任务 —— 本插件曾认领
  （`miscExpert/tasks` 记录 running）的标记 `interrupt`（写入 failures，type=`misc-expert-interrupt`）
  并重新调度执行；未认领的 running 任务直接接管。

## 配置

```yaml
- id: miscExpert
  name: '@dsh-external/dsh-misc-expert'
  config:
    section: 'miscExpert'
    autoClaim: true
    resumeOnStart: true
    maxInputBytes: 65536
    caesarTop: 3
```

## 开发

```powershell
node plugins/misc-expert-agent/tests/boot-test.mjs   # 启动测试（本地确定性数据）
```

> 实现说明：与 dsh 官方插件一致，`lib/index.js` 为可加载实现（ESM + JSDoc 类型），
> `lib/types/index.d.ts` 提供完整 TypeScript 类型面。
