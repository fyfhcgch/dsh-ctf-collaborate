import type { Broadcaster } from './sse-broadcast.js';
import type { TeamService } from './team-service.js';
/** Mount the built-in Web UI, JSON API, and SSE stream over the shared TeamService. */
export declare function setupApi(ctx: any, mountPath: string, broadcast: Broadcaster, service: TeamService): boolean;
