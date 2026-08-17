import Schema from '@deepseek-ai/schemastery';
import { createDb } from './db.js';
import { createBroadcast } from './sse-broadcast.js';
import { setupApi } from './api.js';
import { setupCommands } from './commands.js';
import { setupAgentRunner } from './agent-runner.js';
import { TeamService } from './team-service.js';
import { getSessionForkAdapter } from './host-adapter.js';
import { TeamRemoteService } from './remote-service.js';
import { TeamSyncService } from './sync-service.js';
export const name = 'dsh-ctf-team';
/** Required host capability for the built-in /ctf-team HTTP surface. */
export const inject = ['webServer', 'subagents', 'agents'];
/** Current Cordis 4 Standard Schema configuration contract. */
export const Config = Schema.object({
    dbPath: Schema.string().default('./data/ctf-team.db'),
    agentConcurrentLimit: Schema.number().step(1).min(1).default(4),
    webMountPath: Schema.string().default('/ctf-team'),
    enableHttpBridge: Schema.boolean().default(true),
    teamId: Schema.string().default('ctf-team'),
    identityPath: Schema.string().default(''),
});
/**
 * Process-wide collaboration store. This is intentionally a plain Cordis plugin:
 * it provides no global service and owns every cleanup action through its Fiber.
 */
export function apply(ctx, config) {
    const db = createDb(config.dbPath);
    const broadcast = createBroadcast();
    let sync;
    const localSink = (operation) => sync.recordLocal(operation);
    const runner = setupAgentRunner(db, broadcast, getSessionForkAdapter(ctx), config.agentConcurrentLimit, (kind, payload) => sync.recordMutation(kind, payload));
    const service = new TeamService(db, broadcast, runner, localSink);
    sync = new TeamSyncService(ctx, db, service, config.teamId, config.identityPath || `${config.dbPath}.identity.json`);
    const remote = new TeamRemoteService(ctx, service, sync);
    let apiMounted = false;
    try {
        if (config.enableHttpBridge)
            apiMounted = setupApi(ctx, config.webMountPath, broadcast, service);
        setupCommands(ctx, service);
        ctx.logger?.info?.(`dsh-ctf-team loaded; HTTP bridge ${apiMounted ? 'enabled' : 'disabled'}, P2P team ${sync.identity.teamId}`);
    }
    catch (error) {
        broadcast.close();
        db.close();
        throw error;
    }
    ctx.effect(() => () => {
        broadcast.close();
        db.close();
    }, 'dsh-ctf-team cleanup');
}
