import Schema from '@deepseek-ai/schemastery'
import { createDb } from './db.js'
import { createBroadcast } from './sse-broadcast.js'
import { setupApi } from './api.js'
import { setupCommands } from './commands.js'
import { setupAgentRunner } from './agent-runner.js'
import { TeamService } from './team-service.js'
import { getSessionForkAdapter } from './host-adapter.js'
import { TeamRemoteService } from './remote-service.js'
import { TeamSyncService } from './sync-service.js'
import { setupSandboxTool } from './sandbox-tool.js'
import type { OperationSink } from './team-service.js'
import { DASCTFPlatform } from './dasctf-platform.js'

export const name = 'dsh-ctf-team'
/** Required host capability for the built-in /ctf-team HTTP surface. */
export const inject = ['webServer']

/** Current Cordis 4 Standard Schema configuration contract. */
export const Config = Schema.object({
  dbPath: Schema.string().default('./data/ctf-team.db'),
  agentConcurrentLimit: Schema.number().step(1).min(1).default(4),
  webMountPath: Schema.string().default('/ctf-team'),
  enableHttpBridge: Schema.boolean().default(true),
  teamId: Schema.string().default('ctf-team'),
  identityPath: Schema.string().default(''),
  sandboxImage: Schema.string().default('kalilinux/kali-rolling'),
  dasctfEnabled: Schema.boolean().default(true),
  dasctfCompetitionId: Schema.string().default('1625'),
  dasctfStageId: Schema.string().default('3071'),
  dasctfPlatformHost: Schema.string().default('https://pro.dasctf.com'),
  dasctfAccessKeyEnv: Schema.string().default('DASCTF_ACCESS_KEY'),
  dasctfGatewayEndpoint: Schema.string().default(''),
  dasctfEventStartAt: Schema.string().default('2026-08-18T09:00:00+08:00'),
  dasctfEventEndAt: Schema.string().default('2026-08-19T17:00:00+08:00'),
  dasctfMaxSubmissions: Schema.number().step(1).min(1).max(50).default(50),
  dasctfLeaseTtlMs: Schema.number().step(1000).min(10000).default(120000),
})

/**
 * Process-wide collaboration store. This is intentionally a plain Cordis plugin:
 * it provides no global service and owns every cleanup action through its Fiber.
 */
export function apply(ctx: any, config: any) {
  const db = createDb(config.dbPath)
  const broadcast = createBroadcast()
  let sync!: TeamSyncService
  const localSink: OperationSink = (operation) => sync.recordLocal(operation)
  const runner = setupAgentRunner(db, broadcast, getSessionForkAdapter(ctx), config.agentConcurrentLimit, (kind, payload) => sync.recordMutation(kind, payload))
  setupSandboxTool(ctx, config)
  const service = new TeamService(db, broadcast, runner, localSink)
  const platform = config.dasctfEnabled ? new DASCTFPlatform(db, {
    competitionId: config.dasctfCompetitionId, stageId: config.dasctfStageId, platformHost: config.dasctfPlatformHost,
    accessKeyEnv: config.dasctfAccessKeyEnv, gatewayEndpoint: config.dasctfGatewayEndpoint, teamId: config.teamId,
    eventStartAt: config.dasctfEventStartAt, eventEndAt: config.dasctfEventEndAt, maxSubmissions: config.dasctfMaxSubmissions,
    leaseTtlMs: config.dasctfLeaseTtlMs,
  }) : undefined
  sync = new TeamSyncService(ctx, db, service, config.teamId, config.identityPath || `${config.dbPath}.identity.json`)
  const remote = new TeamRemoteService(ctx, service, sync)
  let apiMounted = false
  try {
    if (config.enableHttpBridge) apiMounted = setupApi(ctx, config.webMountPath, broadcast, service, platform)
    setupCommands(ctx, service)
    ctx.logger?.info?.(`dsh-ctf-team loaded; HTTP bridge ${apiMounted ? 'enabled' : 'disabled'}, P2P team ${sync.identity.teamId}`)
  } catch (error) {
    broadcast.close()
    db.close()
    throw error
  }
  ctx.effect(() => () => {
    broadcast.close()
    db.close()
  }, 'dsh-ctf-team cleanup')
}
