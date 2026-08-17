import type { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { AddEvidenceInput, AddNoteInput, AddThoughtInput, ChallengeDetail, CreateChallengeInput, TeamService, UpdateChallengeInput } from './team-service.js';
import type { Challenge, EvidenceItem, TeamNote, AgentThought } from './types.js';
import type { TeamSyncService } from './sync-service.js';
import type { SyncBatch, TeamIdentity, TeamOperation } from './types.js';
/** Host service exposed through the Harness Typert gateway. */
export declare class TeamRemoteService extends TypertRemoteService {
    private readonly team;
    private readonly sync;
    static inject: never[];
    constructor(ctx: Context, team: TeamService, sync: TeamSyncService);
    list(): Challenge[];
    detail(challengeId: string): ChallengeDetail;
    create(input: CreateChallengeInput): Challenge;
    update(challengeId: string, input: UpdateChallengeInput): Challenge;
    delete(challengeId: string): {
        challengeId: string;
        deleted: true;
    };
    addNote(input: AddNoteInput): TeamNote;
    addEvidence(input: AddEvidenceInput): EvidenceItem;
    addThought(input: AddThoughtInput): AgentThought;
    spawnAgent(input: {
        challengeId: string;
        ownerUserId?: string;
        prompt: string;
    }): Promise<{
        taskId: string;
        response: string;
    }>;
    identity(): TeamIdentity;
    changes(input?: {
        afterSequence?: number;
        limit?: number;
    }): SyncBatch;
    applyOperations(input: {
        operations: TeamOperation[];
    }): ReturnType<TeamSyncService['applyOperations']>;
    syncStatus(): {
        teamId: string;
        peerId: string;
        operationCursor: number;
        operationCount: number;
    };
}
export default TeamRemoteService;
