import type { Broadcaster } from './sse-broadcast.js';
import type { AgentThought, Challenge, EvidenceItem, SubTask, TeamDb, TeamNote, TeamOperation } from './types.js';
import type { AgentRunner } from './agent-runner.js';
export interface CreateChallengeInput {
    challengeId?: unknown;
    title?: unknown;
    category?: unknown;
    description?: unknown;
    attachmentPaths?: unknown;
    status?: unknown;
    flag?: unknown;
}
export interface UpdateChallengeInput {
    title?: unknown;
    category?: unknown;
    description?: unknown;
    attachmentPaths?: unknown;
    status?: unknown;
    flag?: unknown;
}
export interface AddNoteInput {
    challengeId?: unknown;
    authorUserId?: unknown;
    content?: unknown;
}
export interface AddEvidenceInput {
    challengeId?: unknown;
    type?: unknown;
    content?: unknown;
}
export interface AddThoughtInput {
    challengeId?: unknown;
    source?: unknown;
    content?: unknown;
}
export type OperationSink = (operation: TeamOperation) => void;
export interface ChallengeDetail {
    challenge: Challenge;
    notes: TeamNote[];
    thoughts: AgentThought[];
    evidence: EvidenceItem[];
    tasks: SubTask[];
}
/** Shared domain operations used by commands, HTTP, and the future Remote client. */
export declare class TeamService {
    private readonly db;
    private readonly broadcast;
    private readonly agentRunner?;
    private readonly operationSink?;
    private readonly localPeerId;
    constructor(db: TeamDb, broadcast: Broadcaster, agentRunner?: AgentRunner | undefined, operationSink?: OperationSink | undefined, localPeerId?: string);
    listChallenges(): Challenge[];
    getDetail(challengeId: unknown): ChallengeDetail;
    createChallenge(input: CreateChallengeInput): Challenge;
    updateChallenge(challengeId: unknown, input: UpdateChallengeInput): Challenge;
    deleteChallenge(challengeId: unknown): void;
    addNote(input: AddNoteInput): TeamNote;
    addEvidence(input: AddEvidenceInput): EvidenceItem;
    addThought(input: AddThoughtInput): AgentThought;
    spawnAgent(challengeId: unknown, ownerUserId: unknown, prompt: unknown): Promise<{
        taskId: string;
        response: string;
    }>;
    /** Apply one idempotent operation received from another peer. */
    applyRemoteOperation(operation: TeamOperation): 'applied' | 'ignored' | 'pending';
    private record;
    private requireChallenge;
}
