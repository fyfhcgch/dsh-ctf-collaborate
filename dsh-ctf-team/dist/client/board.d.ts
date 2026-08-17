import type { TeamP2PController } from './p2p.js';
export type ChallengeCategory = 'pwn' | 'crypto' | 'web' | 'rev' | 'misc' | 'forensic';
export type ChallengeStatus = 'pending' | 'solving' | 'solved';
export interface Challenge {
    challengeId: string;
    title: string;
    category: ChallengeCategory;
    description: string;
    attachmentPaths: string[];
    status: ChallengeStatus;
    flag?: string;
    createdAt: number;
}
export interface TeamNote {
    id: string;
    challengeId: string;
    authorUserId: string;
    content: string;
    createdAt: number;
}
export interface AgentThought {
    id: string;
    challengeId: string;
    source: string;
    content: string;
    createdAt: number;
}
export interface EvidenceItem {
    id: string;
    challengeId: string;
    type: 'tool_output' | 'file_extract' | 'log';
    content: string;
    createdAt: number;
}
export interface SubTask {
    taskId: string;
    challengeId: string;
    ownerUserId: string;
    prompt: string;
    done: boolean;
    result: string;
    createdAt: number;
}
export interface ChallengeDetail {
    challenge: Challenge;
    notes: TeamNote[];
    thoughts: AgentThought[];
    evidence: EvidenceItem[];
    tasks: SubTask[];
}
export interface TeamIdentity {
    teamId: string;
    peerId: string;
    createdAt: number;
}
export interface SyncStatus {
    teamId: string;
    peerId: string;
    operationCursor: number;
    operationCount: number;
}
export interface TeamBoardRemote {
    list(): Promise<Challenge[]>;
    detail(challengeId: string): Promise<ChallengeDetail>;
    create(input: Partial<Challenge>): Promise<Challenge>;
    update(challengeId: string, input: Partial<Challenge>): Promise<Challenge>;
    delete(challengeId: string): Promise<{
        challengeId: string;
        deleted: true;
    }>;
    addNote(input: {
        challengeId: string;
        authorUserId?: string;
        content: string;
    }): Promise<TeamNote>;
    addEvidence(input: {
        challengeId: string;
        type?: EvidenceItem['type'];
        content: string;
    }): Promise<EvidenceItem>;
    addThought(input: {
        challengeId: string;
        source?: string;
        content: string;
    }): Promise<AgentThought>;
    spawnAgent(input: {
        challengeId: string;
        ownerUserId?: string;
        prompt: string;
    }): Promise<{
        taskId: string;
        response: string;
    }>;
    identity(): Promise<TeamIdentity>;
    syncStatus(): Promise<SyncStatus>;
}
/** Vanilla browser UI for the Host-owned CTF team board. */
export declare class TeamBoard {
    private readonly remote;
    private readonly p2p;
    private readonly log;
    private root?;
    private refreshTimer?;
    private unsubscribeP2P?;
    private sidebarIntegrated;
    private sidebarWide;
    private readonly drafts;
    private readonly state;
    constructor(remote: TeamBoardRemote, p2p: TeamP2PController, log?: (message: string) => void);
    mount(): void;
    setSidebarIntegrated(value: boolean): void;
    setSidebarWide(value: boolean): void;
    toggleOpen(): void;
    openPanel(): void;
    dispose(): void;
    refresh(options?: {
        quiet?: boolean;
    }): Promise<void>;
    private readonly onExternalSync;
    private loadDetail;
    private run;
    private onClick;
    private onInput;
    private onChange;
    private onSubmit;
    private render;
    private renderLauncher;
    private renderPanel;
    private renderAlerts;
    private renderCreateForm;
    private renderChallengeList;
    private renderDetail;
    private renderOverview;
    private renderNotes;
    private renderEvidence;
    private renderThoughts;
    private renderTasks;
    private draft;
    private draftKey;
    private clearDraft;
    private renderP2P;
}
