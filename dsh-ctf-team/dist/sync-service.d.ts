import type { Context } from '@deepseek-ai/cordis';
import type { TeamService, OperationSink } from './team-service.js';
import type { TeamDb, TeamIdentity, TeamOperation, TeamOperationKind, SyncBatch } from './types.js';
export interface SyncApplyResult {
    accepted: string[];
    ignored: string[];
    pending: TeamOperation[];
}
/** Host-side operation log and materializer used by browser P2P peers. */
export declare class TeamSyncService {
    private readonly ctx;
    private readonly db;
    private readonly team;
    readonly identity: TeamIdentity;
    readonly recordLocal: OperationSink;
    constructor(ctx: Context, db: TeamDb, team: TeamService, teamId: string, identityPath?: string);
    getIdentity(): TeamIdentity;
    /** Backfill pre-sync SQLite rows so an upgraded installation can bootstrap peers. */
    private seedExistingState;
    private seedOperation;
    recordMutation(kind: TeamOperationKind, payload: unknown): void;
    getChanges(afterSequence?: number, limit?: number): SyncBatch;
    applyOperations(input: unknown): SyncApplyResult;
    status(): {
        teamId: string;
        peerId: string;
        operationCursor: number;
        operationCount: number;
    };
    /** Used by TeamService construction so every local mutation enters the log. */
    operationSink(): OperationSink;
    logger(message: string): void;
}
