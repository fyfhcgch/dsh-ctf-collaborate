# @dsh-external/dsh-blackboard

**黑板持久化后台插件** — durable global blackboard (shared memory) for CTF agents, built as a
[dsh-harness](https://github.com/deepseek-ai/deepseek-harness) cordis bundle plugin.

The blackboard stores every piece of cross-step, cross-session CTF knowledge — 题目信息 (challenge info),
工具输出 (tool output), 中间线索 (intermediate clues), 失败记录 (failure records), 候选 flag
(candidate flags) — in **one JSON file on disk**. Nothing lives only in memory: every mutation is
serialized through a write queue and committed atomically (temp file + rename) **before** the in-memory
document advances and before any event fires. A dsh-harness restart or a machine restart loses nothing;
the plugin is a profile bundle, so it auto-loads with the harness.

| | |
|---|---|
| Persistence file | `persistent_data/blackboard.json` relative to the Harness profile working directory; a profile `config.file` takes precedence, otherwise `DSH_BLACKBOARD_FILE` can provide the path |
| Plugin code | `dsh-ctf-team/plugins/blackboard-plugin/` |
| Service name | `ctx.blackboard` |
| Notification events | `blackboard/ready` `blackboard/set` `blackboard/update` `blackboard/append` `blackboard/delete` `blackboard/clear-section` `blackboard/clear` `blackboard/persist` `blackboard/change` `blackboard/error` |
| Command channel | `ctx.emit("blackboard/command", { op, section, key, value })` |

## Data model

Plain, versioned JSON:

```json
{
  "schemaVersion": 1,
  "meta": {
    "createdAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": "2026-01-01T00:00:00.000Z",
    "lastWriteAt": "2026-01-01T00:00:00.000Z"
  },
  "sections": {
    "challenges":      { "web-01": { "name": "flag shop", "service": "http://10.0.0.5:3000" } },
    "tool_outputs":    { "nmap-10.0.0.5": ["22/tcp open ssh", "3000/tcp open http"] },
    "clues":           { "login-bypass": "admin panel leaks token in /api/status" },
    "failures":        { "sql-injection": { "payload": "' OR 1=1 --", "result": "filtered", "at": "..." } },
    "candidate_flags": { "flag-1": "CTF{...}", "flag-2": "CTF{...}" }
  }
}
```

The five canonical sections are seeded automatically; any additional section name is allowed
(`/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/`). Entries are JSON-serializable values. A corrupt file is never
fatal: it is renamed aside to `blackboard.json.corrupt-<timestamp>` and the plugin starts fresh, logging
a warning.

## Usage from another plugin

```ts
import { Context } from "@deepseek-ai/cordis";

// Declare the dependency so the fiber waits for availability:
export function apply(ctx: Context) {
  // or: class MyPlugin { static inject = ["blackboard"]; ... }
  ctx.inject(["blackboard"], async (ctx) => {
    await ctx.blackboard.waitReady();

    await ctx.blackboard.set("challenges", "web-01", { name: "flag shop", port: 3000 });
    await ctx.blackboard.append("tool_outputs", "nmap-01", "3000/tcp open http");
    await ctx.blackboard.update("challenges", "web-01", { service: "http://10.0.0.5:3000" });
    const flags = await ctx.blackboard.search("CTF{");
    await ctx.blackboard.set("candidate_flags", "flag-1", "CTF{...}");

    // Event-driven alternative (command channel):
    ctx.emit("blackboard/command", { op: "set", section: "clues", key: "k1", value: "v1" });

    // Observe changes:
    ctx.on("blackboard/set", (payload) => { /* { section, key, value, previous, at, file } */ });
  });
}
```

## API summary

Reads (sync after ready — call `waitReady()` once):
`get(section, key)` `getSection(section)` `getDocument()` `has(section, key)` `keys(section)`
`size(section)` `count()` `listSections()` `getFile()` `search(query, { caseInsensitive, limit })`

Writes (async, durable, evented — every one writes the file before resolving):
`set(section, key, value)` `update(section, key, patch)` `append(section, key, item)`
`delete/remove(section, key)` `clearSection(section)` `clear()` `touch()`

Each write resolves with `{ section, key, value|item, previous, changed, at, file }` — `changed: false`
means the mutation was a no-op (nothing written, no event). `previous` is the pre-mutation value.

## Events (after each durable write)

| Event | Payload |
|---|---|
| `blackboard/ready` | `{ at, file }` |
| `blackboard/set` / `blackboard/update` | `{ section, key, value, previous, changed, at, file }` |
| `blackboard/append` | `{ section, key, item, previous, changed, at, file }` |
| `blackboard/delete` | `{ section, key, previous, changed, at, file }` |
| `blackboard/clear-section` | `{ section, previous, changed, at, file }` |
| `blackboard/clear` | `{ previous, changed, at, file }` |
| `blackboard/persist` | `{ at, file }` — after every successful disk write |
| `blackboard/change` | `{ op, section, key, at, file }` — generic change notification |
| `blackboard/error` | `{ error, at }` — command failures and background errors |

## Persistence guarantees

- Every mutation: `mkdir -p` → write `blackboard.json.tmp` → atomic `rename` over `blackboard.json`,
  with a bounded retry on transient Windows lock errors (EACCES/EBUSY/EPERM).
- The in-memory document only advances after the disk write succeeds; on write failure the memory state
  is untouched and the error propagates to the caller.
- On boot: the file is read and validated; an absent file produces the canonical empty document (written
  immediately); a corrupt file is backed up and recovered.
- On shutdown: the plugin's disposer drains the write queue, so an in-flight commit is never cut short.
- The file is plain JSON — inspect or hand-edit it while the harness is stopped.

## Development

```sh
# Set this once to the @deepseek-ai directory containing dsh-app-boot.
export DSH_HARNESS_SCOPE=/path/to/deepseek-harness/node_modules/.pnpm/node_modules/@deepseek-ai
node plugins/blackboard-plugin/tests/boot-test.mjs
```
