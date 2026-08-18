import { randomUUID } from 'node:crypto'
import type { TeamDb } from './types.js'
import type { TeamService } from './team-service.js'

/** Full URLs copied from the West Lake Sword preliminary manual. */
export const DASCTF_GATEWAY_ENDPOINTS = [
  'https://api.deepseek.com/chat/completions', 'https://api.deepseek.com/v1/chat/completions', 'https://api.deepseek.com/responses', 'https://api.deepseek.com/anthropic/v1/messages',
  'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', 'https://dashscope.aliyuncs.com/compatible-mode/v1/responses', 'https://dashscope.aliyuncs.com/apps/anthropic/v1/messages', 'https://coding.dashscope.aliyuncs.com/v1/chat/completions', 'https://coding.dashscope.aliyuncs.com/apps/anthropic/v1/messages',
  'https://qianfan.baidu.com/v2/chat/completions', 'https://qianfan.baidu.com/v2/responses', 'https://qianfan.baidu.com/anthropic/v1/messages',
  'https://ark.cn-beijing.volces.com/api/v3/chat/completions', 'https://ark.cn-beijing.volces.com/api/v3/responses', 'https://ark.cn-beijing.volces.com/api/compatible/v1/messages', 'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions', 'https://ark.cn-beijing.volces.com/api/coding/v3/responses', 'https://ark.cn-beijing.volces.com/api/coding/v1/messages',
  'https://open.bigmodel.cn/api/paas/v4/chat/completions', 'https://open.bigmodel.cn/api/v1/responses', 'https://open.bigmodel.cn/api/anthropic/v1/messages', 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions', 'https://api.z.ai/api/coding/paas/v4/chat/completions',
  'https://api.hunyuan.cloud.tencent.com/v1/chat/completions', 'https://tokenhub.tencentmaas.com/v1/chat/completions', 'https://tokenhub.tencentmaas.com/v1/responses', 'https://tokenhub.tencentmaas.com/v1/messages',
  'https://api.lkeap.cloud.tencent.com/v1/chat/completions', 'https://api.lkeap.cloud.tencent.com/anthropic/v1/messages', 'https://api.lkeap.cloud.tencent.com/v3/chat/completions', 'https://api.lkeap.cloud.tencent.com/api/anthropic/v1/messages', 'https://api.lkeap.cloud.tencent.com/coding/v3/chat/completions', 'https://api.lkeap.cloud.tencent.com/coding/anthropic/v1/messages',
  'https://api.moonshot.cn/v1/chat/completions', 'https://api.kimi.com/coding/v1/chat/completions', 'https://api.kimi.com/coding/v1/messages', 'https://api.siliconflow.cn/v1/chat/completions', 'https://api.siliconflow.cn/v1/messages',
  'https://api.minimaxi.com/v1/chat/completions', 'https://api.minimaxi.com/v1/responses', 'https://api.minimaxi.com/anthropic/v1/messages', 'https://api.xiaomimimo.com/v1/chat/completions', 'https://api.xiaomimimo.com/v1/responses', 'https://api.xiaomimimo.com/anthropic/v1/messages',
  'https://api.stepfun.com/v1/chat/completions', 'https://api.stepfun.com/v1/responses', 'https://api.stepfun.com/v1/messages', 'https://spark-api-open.xf-yun.com/v1/chat/completions', 'https://api.sensenova.cn/compatible-mode/v2/chat/completions', 'https://api.baichuan-ai.com/v1/chat/completions',
] as const

const ALLOWED_GATEWAYS = new Set<string>(DASCTF_GATEWAY_ENDPOINTS)
const API_PATHS = new Set(['/match/notice/match-info', '/answer-panel/overview', '/answer-panel/answer', '/ctf/exercise-list', '/ctf/exercise', '/ctf/build-exercise-env', '/ctf/recover-exercise-env', '/ctf/expire-exercise-env', '/match/notice/now-list', '/match/notice/detail'])
const SECRET_KEY = /access.?key|authorization|password|passwd|secret|token|api.?key|credential/i
const SECRET_VALUE = /(?:ak_[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+|sk-[A-Za-z0-9_-]+)/g

export class PlatformError extends Error {
  constructor(message: string, readonly kind: 'config' | 'auth' | 'policy' | 'remote' = 'remote') { super(message); this.name = 'PlatformError' }
}

export function validateGatewayEndpoint(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new PlatformError('gatewayEndpoint is required', 'config')
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new PlatformError('gatewayEndpoint must be a valid URL', 'config') }
  if (url.search || url.hash || url.username || url.password || url.port || !ALLOWED_GATEWAYS.has(url.toString())) throw new PlatformError('gatewayEndpoint must exactly match an official full URL allowlist entry', 'policy')
  return url.toString()
}

export function validateServerHost(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new PlatformError('serverHost is required', 'config')
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new PlatformError('serverHost must be a valid URL', 'config') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new PlatformError('serverHost must be an HTTPS origin without a path or credentials', 'policy')
  return url.origin
}

export function validateAccessKey(value: unknown): string {
  if (typeof value !== 'string' || !/^ak_[A-Za-z0-9_-]{8,256}$/.test(value.trim())) throw new PlatformError('accessKey must be a valid platform AccessKey', 'auth')
  return value.trim()
}

export function normalizeDASCTFFlag(value: unknown): string {
  if (typeof value !== 'string') throw new PlatformError('flag must be a string', 'policy')
  const match = /^(?:DASCTF|flag)\{([^{}\s]+)\}$/i.exec(value.trim())
  if (!match) throw new PlatformError('flag must use DASCTF{...} or flag{...} format', 'policy')
  if (match[1].length > 256) throw new PlatformError('flag content exceeds the platform limit', 'policy')
  return match[1]
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) result[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redactSecrets(item)
    return result
  }
  return typeof value === 'string' ? value.replace(SECRET_VALUE, '[REDACTED]') : value
}

export interface DASCTFConfig { competitionId: string; stageId: string; platformHost: string; accessKeyEnv: string; gatewayEndpoint: string; teamId: string; eventStartAt: string; eventEndAt: string; maxSubmissions: number; leaseTtlMs: number }
export interface PlatformConfigureInput { serverHost: unknown; accessKey: unknown; gatewayEndpoint?: unknown }
export interface PlatformStatus {
  enabled: true; competitionId: string; stageId: string; platformHost: string; accessKeyConfigured: boolean; gatewayEndpointConfigured: boolean; gatewayEndpointAllowed: boolean
  event: { startAt: string; endAt: string; active: boolean }
  lease: { ownerId: string; acquiredAt: number; expiresAt: number } | null
  policy: { maxSubmissionsPerExercise: number; requiresHumanConfirmation: true; automaticRetries: false }
}
export interface PlatformSyncResult { stageId: string; notices: number; exercises: number; syncedChallenges: number; score: unknown; rank: unknown }
export interface PlatformExerciseSyncResult { exerciseId: number; challengeId: string; endpoints: number; isNeedCheck: boolean; synced: boolean }

export class DASCTFPlatform {
  private readonly fetchImpl: typeof fetch
  private readonly ownerId: string
  private runtimeServerHost: string
  private runtimeAccessKey: string
  private runtimeGatewayEndpoint: string
  private readonly requestSpacingMs: number
  private lastRequestAt = 0

  constructor(private readonly db: TeamDb, private readonly config: DASCTFConfig, fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? globalThis.fetch
    this.ownerId = `${config.teamId}:${process.pid}`
    this.runtimeServerHost = config.platformHost
    this.runtimeAccessKey = process.env[config.accessKeyEnv]?.trim() ?? ''
    this.runtimeGatewayEndpoint = config.gatewayEndpoint
    this.requestSpacingMs = fetchImpl ? 0 : Math.max(0, Number(process.env.DASCTF_REQUEST_SPACING_MS ?? 1200))
  }

  configure(input: PlatformConfigureInput): PlatformStatus {
    const serverHost = validateServerHost(input.serverHost)
    const accessKey = validateAccessKey(input.accessKey)
    const gatewayEndpoint = input.gatewayEndpoint === undefined ? this.runtimeGatewayEndpoint : String(input.gatewayEndpoint).trim()
    if (gatewayEndpoint) validateGatewayEndpoint(gatewayEndpoint)
    this.runtimeServerHost = serverHost
    this.runtimeAccessKey = accessKey
    this.runtimeGatewayEndpoint = gatewayEndpoint
    this.audit('platform.configure', { serverHost, accessKeyConfigured: true, gatewayEndpointConfigured: Boolean(gatewayEndpoint), gatewayEndpointAllowed: Boolean(gatewayEndpoint) })
    return this.status()
  }

  clearRuntimeAccessKey(): PlatformStatus {
    this.runtimeAccessKey = ''
    delete process.env[this.config.accessKeyEnv]
    this.audit('platform.credentials.clear', { accessKeyConfigured: false })
    return this.status()
  }

  status(now = Date.now()): PlatformStatus {
    const lease = this.db.getAgentLease('dasctf')
    let gatewayAllowed = false
    if (this.runtimeGatewayEndpoint.trim()) { try { validateGatewayEndpoint(this.runtimeGatewayEndpoint); gatewayAllowed = true } catch { /* health endpoint reports false */ } }
    return {
      enabled: true, competitionId: this.config.competitionId, stageId: this.config.stageId, platformHost: this.runtimeServerHost,
      accessKeyConfigured: Boolean(this.accessKey()), gatewayEndpointConfigured: Boolean(this.runtimeGatewayEndpoint.trim()), gatewayEndpointAllowed: gatewayAllowed,
      event: { startAt: this.config.eventStartAt, endAt: this.config.eventEndAt, active: now >= Date.parse(this.config.eventStartAt) && now <= Date.parse(this.config.eventEndAt) },
      lease: lease && lease.expiresAt > now ? lease : null,
      policy: { maxSubmissionsPerExercise: this.config.maxSubmissions, requiresHumanConfirmation: true, automaticRetries: false },
    }
  }

  async sync(service: TeamService): Promise<PlatformSyncResult> {
    this.ensureConfigured(); this.ensureLease()
    const noticeInfo = await this.request('GET', '/match/notice/match-info')
    const notices = await this.request('GET', '/match/notice/now-list')
    const exercises = await this.request('GET', '/ctf/exercise-list')
    const overview = await this.request('GET', '/answer-panel/overview')
    const groups = Array.isArray(exercises.data) ? exercises.data : []
    let syncedChallenges = 0
    for (const group of groups) {
      if (!group || typeof group !== 'object' || !Array.isArray((group as any).corpus)) continue
      for (const exercise of (group as any).corpus) {
        if (!exercise || typeof exercise !== 'object' || !Number.isInteger((exercise as any).id)) continue
        const detail = await this.request('GET', '/ctf/exercise', { exerciseId: (exercise as any).id })
        const safe = redactSecrets(detail.data) as Record<string, any>
        const id = `dasctf-${String((exercise as any).id)}`
        const input = { challengeId: id, title: String(safe.name ?? (exercise as any).name ?? id), category: categoryFor(String(group.name ?? 'misc')), description: JSON.stringify({ noticeInfo: redactSecrets(noticeInfo.data), exercise: safe }, null, 2).slice(0, 20000), attachmentPaths: attachmentUrls(safe), status: safe.hasSolved ? 'solved' : 'pending' } as const
        const existing = service.listChallenges().find((item) => item.challengeId === id)
        if (existing) service.updateChallenge(id, input); else service.createChallenge(input)
        syncedChallenges++
      }
    }
    this.audit('platform.sync', { notices: arrayLength(notices.data), exercises: syncedChallenges })
    return { stageId: this.config.stageId, notices: arrayLength(notices.data), exercises: groups.reduce((sum, group) => sum + (Array.isArray(group?.corpus) ? group.corpus.length : 0), 0), syncedChallenges, score: overview.data?.stagePoint ?? null, rank: overview.data?.stageRank ?? null }
  }

  async syncExercise(service: TeamService, exerciseId: unknown): Promise<PlatformExerciseSyncResult> {
    this.ensureConfigured(); this.ensureLease()
    const id = Number(exerciseId)
    if (!Number.isInteger(id) || id <= 0) throw new PlatformError('exerciseId must be a positive integer', 'policy')
    const detail = await this.request('GET', '/ctf/exercise', { exerciseId: id })
    const safe = redactSecrets(detail.data) as Record<string, any>
    const challengeId = `dasctf-${id}`
    const existing = service.listChallenges().find((item) => item.challengeId === challengeId)
    if (!existing) throw new PlatformError(`challenge ${challengeId} is not synced locally`, 'policy')
    let noticeInfo: unknown = {}
    try { noticeInfo = JSON.parse(existing.description)?.noticeInfo ?? {} } catch { /* keep an empty notice block */ }
    const input = {
      challengeId,
      title: String(safe.name ?? existing.title),
      category: existing.category,
      description: JSON.stringify({ noticeInfo: redactSecrets(noticeInfo), exercise: safe }, null, 2).slice(0, 20000),
      attachmentPaths: attachmentUrls(safe),
      status: safe.hasSolved ? 'solved' : existing.status,
    } as const
    service.updateChallenge(challengeId, input)
    const endpoints = arrayLength(safe.endpoints)
    const isNeedCheck = safe.isNeedCheck === true
    this.audit('platform.exercise.sync', { exerciseId: id, endpoints, isNeedCheck })
    return { exerciseId: id, challengeId, endpoints, isNeedCheck, synced: true }
  }

  async submit(exerciseId: unknown, flag: unknown, confirm: unknown, confirmationText: unknown): Promise<{ accepted: boolean; exerciseId: number; attemptsUsed: number }> {
    this.ensureConfigured(true); this.ensureLease()
    if (confirm !== true || confirmationText !== 'SUBMIT') throw new PlatformError('human confirmation is required: confirm=true and confirmationText=SUBMIT', 'policy')
    const id = Number(exerciseId); if (!Number.isInteger(id) || id <= 0) throw new PlatformError('exerciseId must be a positive integer', 'policy')
    const innerFlag = normalizeDASCTFFlag(flag)
    if (Date.now() < Date.parse(this.config.eventStartAt) || Date.now() > Date.parse(this.config.eventEndAt)) throw new PlatformError('submission is outside the configured event window', 'policy')
    const attemptsUsed = this.db.countPlatformSubmissions(String(id)); if (attemptsUsed >= this.config.maxSubmissions) throw new PlatformError(`submission limit reached for exercise ${id}`, 'policy')
    this.audit('platform.submit.attempt', { exerciseId: id, attempt: attemptsUsed + 1 })
    const response = await this.request('POST', '/answer-panel/answer', { exerciseId: id, flag: innerFlag })
    const accepted = response.data?.isCorrect === true
    this.audit('platform.submit.result', { exerciseId: id, accepted, code: response.code })
    return { accepted, exerciseId: id, attemptsUsed: attemptsUsed + 1 }
  }

  async buildExerciseEnv(exerciseId: unknown, confirm: unknown, confirmationText: unknown): Promise<unknown> {
    return this.changeExerciseEnv('/ctf/build-exercise-env', exerciseId, confirm, confirmationText)
  }

  async recoverExerciseEnv(exerciseId: unknown, confirm: unknown, confirmationText: unknown): Promise<unknown> {
    return this.changeExerciseEnv('/ctf/recover-exercise-env', exerciseId, confirm, confirmationText)
  }

  report(service: TeamService): string {
    const lines = ['# DASCTF 赛事审计报告', '', `- 赛事：${this.config.competitionId}`, `- 阶段：${this.config.stageId}`, `- 生成时间：${new Date().toISOString()}`, '', '## 本地题目']
    for (const challenge of service.listChallenges()) lines.push(`- ${challenge.title} (${challenge.category}, ${challenge.status})`)
    lines.push('', '## 平台事件')
    for (const item of this.db.listPlatformAudit(1000)) lines.push(`- ${new Date(item.createdAt).toISOString()} ${item.event} ${JSON.stringify(item.detail)}`)
    lines.push('', '说明：报告不包含 AccessKey、模型密钥、JWT、靶机密码或 flag 原文。')
    return lines.join('\n') + '\n'
  }

  private accessKey(): string {
    return this.runtimeAccessKey || process.env[this.config.accessKeyEnv]?.trim() || ''
  }
  private ensureConfigured(requireGateway = false): void {
    const accessKey = this.accessKey()
    if (!accessKey) throw new PlatformError(`missing ${this.config.accessKeyEnv} or runtime AccessKey`, 'auth')
    validateAccessKey(accessKey)
    validateServerHost(this.runtimeServerHost)
    if (requireGateway) validateGatewayEndpoint(this.runtimeGatewayEndpoint)
  }
  private ensureLease(): void {
    const now = Date.now(); const current = this.db.getAgentLease('dasctf')
    if (current && current.expiresAt > now && current.ownerId !== this.ownerId) {
      if (this.isStaleLocalOwner(current.ownerId)) {
        this.db.clearAgentLease('dasctf')
        this.audit('platform.lease.stale-cleared', { ownerId: current.ownerId })
      } else {
        throw new PlatformError('another local Agent currently holds the DASCTF lease', 'policy')
      }
    }
    if (!this.db.acquireAgentLease({ scope: 'dasctf', ownerId: this.ownerId, acquiredAt: now, expiresAt: now + this.config.leaseTtlMs })) throw new PlatformError('another local Agent currently holds the DASCTF lease', 'policy')
  }
  private isStaleLocalOwner(ownerId: string): boolean {
    const prefix = `${this.config.teamId}:`
    if (!ownerId.startsWith(prefix)) return false
    const pid = Number(ownerId.slice(prefix.length))
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false
    try { process.kill(pid, 0); return false } catch { return true }
  }

  private async changeExerciseEnv(path: '/ctf/build-exercise-env' | '/ctf/recover-exercise-env', exerciseId: unknown, confirm: unknown, confirmationText: unknown): Promise<unknown> {
    this.ensureConfigured(); this.ensureLease()
    if (confirm !== true || confirmationText !== 'CONFIRM') throw new PlatformError('human confirmation is required: confirm=true and confirmationText=CONFIRM', 'policy')
    const id = Number(exerciseId); if (!Number.isInteger(id) || id <= 0) throw new PlatformError('exerciseId must be a positive integer', 'policy')
    if (Date.now() < Date.parse(this.config.eventStartAt) || Date.now() > Date.parse(this.config.eventEndAt)) throw new PlatformError('environment operation is outside the configured event window', 'policy')
    this.audit('platform.environment.request', { action: path.includes('build') ? 'build' : 'recover', exerciseId: id })
    return (await this.request('POST', path, { exerciseId: id })).data
  }
  private async request(method: 'GET' | 'POST', suffix: string, query?: Record<string, unknown>): Promise<{ data: any; code: string; message: string }> {
    if (!API_PATHS.has(suffix)) throw new PlatformError(`platform API path is not allowlisted: ${suffix}`, 'policy')
    await this.throttlePlatformRequest()
    const host = this.runtimeServerHost.endsWith('/') ? this.runtimeServerHost : `${this.runtimeServerHost}/`
    const url = new URL(`/slab-match/api/v1/agent${suffix}`, host)
    if (query && method === 'GET') for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value))
    const response = await this.fetchImpl(url, { method, headers: { Accept: 'application/json', 'X-Agent-AccessKey': this.accessKey(), ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(query ?? {}) } : {}) })
    let payload: any; try { payload = await response.json() } catch { throw new PlatformError(`platform returned non-JSON response (${response.status})`) }
    this.audit('platform.request', { method, path: `${url.pathname}${url.search}`, status: response.status, code: payload?.code ?? null })
    if (!response.ok || payload?.code !== '00000') throw new PlatformError(`platform request failed: ${payload?.message || response.status}`, response.status === 401 || response.status === 403 ? 'auth' : 'remote')
    return payload
  }
  private async throttlePlatformRequest(): Promise<void> {
    if (!this.requestSpacingMs) return
    const now = Date.now()
    const waitMs = this.lastRequestAt + this.requestSpacingMs - now
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs))
    this.lastRequestAt = Date.now()
  }
  private audit(event: string, detail: unknown): void { this.db.appendPlatformAudit({ id: randomUUID(), event, detail: redactSecrets(detail), createdAt: Date.now() }) }
}

function arrayLength(value: unknown): number { return Array.isArray(value) ? value.length : 0 }
function categoryFor(value: string): 'web' | 'pwn' | 'misc' { return /web/i.test(value) ? 'web' : /pwn/i.test(value) ? 'pwn' : 'misc' }
function attachmentUrls(value: Record<string, any>): string[] { const files = value.attachment?.files; return Array.isArray(files) ? files.flatMap((item) => typeof item?.url === 'string' ? [item.url] : []).slice(0, 64) : [] }
