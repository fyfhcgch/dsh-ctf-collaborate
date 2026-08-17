# @dsh-external/dsh-submit-gateway

**HTTP 提交网关插件** — 注册 `POST /api/ctf/submit`，接收 `plan.submit` 格式 JSON，内部调用
`ctx.planner.start()` 发起计划，使外部 PowerShell / curl 可直接提交 CTF 题目进入多 Agent 工作流。

| | |
|---|---|
| 插件代码 | `dsh-ctf-team/plugins/submit-gateway/` |
| 服务名 | `ctx.submitGateway` |
| 硬性依赖 | `inject: ["blackboard", "planner", "webServer"]` |
| 端点 | `POST http://127.0.0.1:3080/api/ctf/submit`（JSON，大小上限 64KB） |

## 用法

```sh
curl -X POST http://127.0.0.1:3080/api/ctf/submit \
  -H 'Content-Type: application/json' \
  --data '{
  "planId":"plan-test-crypto",
  "category":"crypto",
  "title":"Crypto End-To-End Test",
  "description":"Decode base64 ciphertext",
  "ciphertext":"Q1RGe2NyeXB0by1kb25lfQ==",
  "attachments":[]
}'
```

Windows PowerShell 可使用 `Invoke-WebRequest` 发送同样的 JSON。成功响应为 HTTP 200；请求体超过 64 KiB 返回 413，非 POST 请求返回 405。

响应（200）：`{"ok":true,"planId":"plan-test-crypto","category":"crypto","status":"running","message":"计划已送入 planner，专家将自动认领执行","at":"…"}`

提交后：planner 分解 DAG → 对应类别专家（web/crypto/misc）自动认领执行 → 识别 flag 入
candidate_flags → verifier 自动校验。查询走 harness 控制台 `blackboard.get` 系列命令。

## 请求体字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `description` | ✅ | 题目描述 |
| `planId` | 可选 | 计划 id（缺省自动生成） |
| `category` | 可选 | 题目类别（web/crypto/misc/…；缺省按描述关键字检测） |
| `title` | 可选 | 题目标题 |
| `ciphertext` / `url` / 其它 | 可选 | 题目上下文，原样透传到 `challenges/<planId>` 供专家读取 |
| `attachments` / `meta` | 可选 | 附件信息 / 计划元数据 |

## 错误

| HTTP | 场景 |
|---|---|
| 400 | 非 JSON / 缺少 description / planner 校验失败 |
| 405 | 非 POST |
| 413 | 请求体超 64KB |

> 实现说明：`lib/index.js` 为可加载实现（ESM + JSDoc），`lib/types/index.d.ts` 提供类型面。
