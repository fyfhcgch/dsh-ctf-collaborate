# DSH CTF Team

A persistent CTF collaboration store for DeepSeek Harness. Version 0.3.0 includes a Host Typert service, browser Remote contribution, WebRTC peer synchronizer, durable operation log, validated domain service, SQLite persistence, SSE notifications, and an optional legacy HTTP bridge.

## What it provides

- Shared challenges, notes, evidence, agent thoughts, and tasks.
- One global SQLite database at `$DSH_HOME/ctf-team/ctf-team.db`, retained across Harness restarts.
- Challenge create, update, detail, and delete operations. Deleting a challenge removes its notes, thoughts, evidence, and tasks in the same transaction.
- Central validation for command and HTTP callers, including field length limits, enum checks, challenge existence checks, and duplicate ID detection.
- Optional `/team` commands on hosts that provide the legacy command API.
- An opt-in HTTP/SSE bridge (`enableHttpBridge: true`) on hosts exposing a compatible HTTP adapter. It remains disabled in the shipped profile patch.
- A Cordis 4 `@deepseek-ai/schemastery` configuration schema.
- A Host `./typert` artifact with 13 gateway descriptors and a browser `./remote` projection.
- Browser WebRTC offer/answer exchange with idempotent operation synchronization and peer presence.

## Install into a Harness profile

From the directory containing this project:

```sh
dsh plugin --profile web add file:./dsh-ctf-team
```

Restart the Harness process after installation. The package declares a DSH bundle patch, so the CLI adds the Host plugin row to the selected profile.

## Current scope

The Client face is loaded on web profiles and mounts the `ctfTeam` Typert Remote during startup. The Host `./typert` artifact registers the matching invocation descriptors with the Harness gateway. The browser then starts `TeamP2PController`, available for diagnostics as `globalThis.__DSH_CTF_TEAM_P2P__`. It intentionally contains no database access and no legacy HTTP bridge calls. A visual board is the next Client milestone.

## Domain operations

`src/team-service.ts` is the single operation layer shared by commands, the optional HTTP bridge, and the active Typert Remote surface:

- `listChallenges()` and `getDetail()`
- `createChallenge()`, `updateChallenge()`, and `deleteChallenge()`
- `addNote()`, `addEvidence()`, and `addThought()`
- `spawnAgent()` when the Host supplies a `ctfTeamSessionFork` adapter

The browser Client bundle exports the static `TYPERT_REMOTE` contribution and mounts it through the Host-provided Remote service. `src/typert.host.ts` publishes the same descriptors on the Host face, preventing Host/Client wire drift. All write notifications are emitted after the corresponding database operation succeeds.

## Optional HTTP bridge

When `enableHttpBridge` is enabled, the plugin mounts these routes under `webMountPath` (default `/ctf-team`):

- `GET /api/events`
- `GET /api/challenges`
- `GET /api/challenges/:cid`
- `POST /api/challenges`
- `POST /api/challenges/:cid/update`
- `POST /api/challenges/:cid/delete`
- `POST /api/notes`
- `POST /api/evidence`
- `POST /api/thoughts`
- `POST /api/agent/spawn`

The bridge is compatibility infrastructure for a custom Host. Before exposing it beyond a loopback listener, place authentication, origin checks, authorization, request-size limits, and CSRF protection in front of it.

## Agent task integration

Agent task execution activates only when the Host provides a `ctfTeamSessionFork` adapter. Browser requests do not receive or submit a Harness session object. Without that adapter, the operation reports that agent tasks are not configured.

## Development

```sh
npm install
npm run build
npm test
```

The runtime uses the Harness-provided `@deepseek-ai/cordis` peer and Node's built-in `node:sqlite` driver, so Node 22.5 or newer is required and no native SQLite addon is compiled.
