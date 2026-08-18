import type { Broadcaster } from './sse-broadcast.js'
import { TeamInputError, TeamNotFoundError } from './types.js'
import type { AddEvidenceInput, AddNoteInput, AddThoughtInput, CreateChallengeInput, TeamService, UpdateChallengeInput, UpdateSharedNoteInput } from './team-service.js'
import { getHttpServer } from './host-adapter.js'
import { renderWebUi, webAsset } from './web-ui.js'
import type { DASCTFPlatform } from './dasctf-platform.js'
import { PlatformError } from './dasctf-platform.js'

const bodyOf = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}

function sendError(res: { status(code: number): { json(value: unknown): void } }, error: unknown): void {
  if (error instanceof TeamNotFoundError) return res.status(404).json({ error: error.message })
  if (error instanceof TeamInputError) {
    const status = error.kind === 'conflict' ? 409 : error.kind === 'unsupported' ? 501 : 400
    return res.status(status).json({ error: error.message })
  }
  if (error instanceof PlatformError) {
    const status = error.kind === 'auth' ? 401 : error.kind === 'config' || error.kind === 'policy' ? 400 : 502
    return res.status(status).json({ error: error.message })
  }
  res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
}

/** Mount the built-in Web UI, JSON API, and SSE stream over the shared TeamService. */
export function setupApi(ctx: any, mountPath: string, broadcast: Broadcaster, service: TeamService, platform?: DASCTFPlatform) {
  const server = getHttpServer(ctx)
  if (!server) {
    ctx.logger?.warn?.('dsh-ctf-team: no compatible HTTP server; HTTP bridge was not mounted')
    return false
  }
  const api = `${mountPath.replace(/\/$/, '')}/api`
  const webPath = mountPath.replace(/\/$/, '') || '/ctf-team'
  const sendPage = (_req: unknown, res: any) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.write(renderWebUi(webPath))
    res.end()
  }
  server.get(webPath, sendPage)
  server.get(`${webPath}/`, sendPage)
  const sendAsset = (name: 'app.js' | 'app.css') => (_req: unknown, res: any) => {
    const asset = webAsset(name)
    res.setHeader('Content-Type', asset.contentType)
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    res.write(asset.content)
    res.end()
  }
  server.get(`${webPath}/assets/app.js`, sendAsset('app.js'))
  server.get(`${webPath}/assets/app.css`, sendAsset('app.css'))
  server.get(`${api}/events`, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.write('retry: 3000\n: connected\n\n')
    let heartbeat: ReturnType<typeof setInterval> | undefined
    const close = () => { if (heartbeat) clearInterval(heartbeat); res.end() }
    const detach = broadcast.connectClient({ write: (data) => res.write(data), close })
    heartbeat = setInterval(() => { res.write(': heartbeat\n\n') }, 15000)
    heartbeat.unref?.()
    req.on?.('close', () => { close(); detach() })
  })
  server.get(`${api}/status`, (_req, res) => res.json({
    ok: true,
    sseClients: broadcast.clientCount(),
    challengeCount: service.listChallenges().length,
    platform: platform?.status() ?? null,
  }))
  server.get(`${api}/platform/status`, (_req, res) => res.json(platform ? platform.status() : { enabled: false }))
  server.post(`${api}/platform/configure`, (req, res) => {
    try {
      if (!platform) throw new TeamInputError('DASCTF platform adapter is disabled', 'unsupported')
      res.json({ ok: true, platform: platform.configure(bodyOf(req.body) as { serverHost: unknown; accessKey: unknown; gatewayEndpoint?: unknown }) })
    } catch (error) { sendError(res, error) }
  })
  server.post(`${api}/platform/clear-credentials`, (_req, res) => {
    try {
      if (!platform) throw new TeamInputError('DASCTF platform adapter is disabled', 'unsupported')
      res.json({ ok: true, platform: platform.clearRuntimeAccessKey() })
    } catch (error) { sendError(res, error) }
  })
  server.get(`${api}/platform/audit`, (_req, res) => res.json({ entries: service.platformAudit() }))
  server.get(`${api}/platform/report`, (_req, res) => {
    if (!platform) return res.status(404).json({ error: 'DASCTF platform adapter is disabled' })
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
    res.write(platform.report(service))
    res.end()
  })
  server.post(`${api}/platform/sync`, async (_req, res) => {
    try {
      if (!platform) throw new TeamInputError('DASCTF platform adapter is disabled', 'unsupported')
      res.json({ ok: true, sync: await platform.sync(service) })
    } catch (error) { sendError(res, error) }
  })
  server.post(`${api}/platform/submit`, async (req, res) => {
    try {
      if (!platform) throw new TeamInputError('DASCTF platform adapter is disabled', 'unsupported')
      const body = bodyOf(req.body)
      res.json({ ok: true, submission: await platform.submit(body.exerciseId, body.flag, body.confirm, body.confirmationText) })
    } catch (error) { sendError(res, error) }
  })
  server.post(`${api}/platform/exercise/build`, async (req, res) => {
    try {
      if (!platform) throw new TeamInputError('DASCTF platform adapter is disabled', 'unsupported')
      const body = bodyOf(req.body)
      res.json({ ok: true, result: await platform.buildExerciseEnv(body.exerciseId, body.confirm, body.confirmationText) })
    } catch (error) { sendError(res, error) }
  })
  server.post(`${api}/platform/exercise/recover`, async (req, res) => {
    try {
      if (!platform) throw new TeamInputError('DASCTF platform adapter is disabled', 'unsupported')
      const body = bodyOf(req.body)
      res.json({ ok: true, result: await platform.recoverExerciseEnv(body.exerciseId, body.confirm, body.confirmationText) })
    } catch (error) { sendError(res, error) }
  })
  server.get(`${api}/challenges`, (_req, res) => res.json(service.listChallenges()))
  server.get(`${api}/challenges/:cid`, (req, res) => {
    try { res.json(service.getDetail(req.params.cid)) } catch (error) { sendError(res, error) }
  })
  server.post(`${api}/challenges`, (req, res) => {
    try { res.json({ ok: true, challenge: service.createChallenge(bodyOf(req.body) as CreateChallengeInput) }) } catch (error) { sendError(res, error) }
  })
  server.post(`${api}/challenges/:cid/update`, (req, res) => {
    try { res.json({ ok: true, challenge: service.updateChallenge(req.params.cid, bodyOf(req.body) as UpdateChallengeInput) }) } catch (error) { sendError(res, error) }
  })
  server.post(`${api}/challenges/:cid/delete`, (req, res) => {
    try { service.deleteChallenge(req.params.cid); res.json({ ok: true }) } catch (error) { sendError(res, error) }
  })
  server.post(`${api}/shared-note`, (req, res) => {
    try { res.json({ ok: true, sharedNote: service.updateSharedNote(bodyOf(req.body) as UpdateSharedNoteInput) }) } catch (error) { sendError(res, error) }
  })
  server.post(`${api}/notes`, (req, res) => {
    try { res.json({ ok: true, note: service.addNote(bodyOf(req.body) as AddNoteInput) }) } catch (error) { sendError(res, error) }
  })
  server.post(`${api}/evidence`, (req, res) => {
    try { res.json({ ok: true, evidence: service.addEvidence(bodyOf(req.body) as AddEvidenceInput) }) } catch (error) { sendError(res, error) }
  })
  server.post(`${api}/thoughts`, (req, res) => {
    try { res.json({ ok: true, thought: service.addThought(bodyOf(req.body) as AddThoughtInput) }) } catch (error) { sendError(res, error) }
  })
  server.post(`${api}/agent/spawn`, async (req, res) => {
    try {
      const body = bodyOf(req.body)
      res.json({ ok: true, task: await service.spawnAgent(body.challengeId, body.ownerUserId, body.prompt, body.expertType) })
    } catch (error) { sendError(res, error) }
  })
  if (server.dispose && typeof ctx.effect === 'function') {
    ctx.effect(() => () => server.dispose?.(), 'dsh-ctf-team HTTP routes cleanup')
  }
  return true
}
