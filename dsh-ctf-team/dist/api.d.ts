import type { Broadcaster } from './sse-broadcast.js';
import type { TeamService } from './team-service.js';
/** Mount the optional legacy HTTP bridge over the shared TeamService. */
export declare function setupApi(ctx: any, mountPath: string, broadcast: Broadcaster, service: TeamService): boolean;
