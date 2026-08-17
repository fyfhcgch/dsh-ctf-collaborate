export interface TeamP2POptions {
    /** Optional STUN/TURN servers for peers that are not on the same LAN. */
    iceServers?: RTCIceServer[];
    /** ICE policy can be set to `relay` when a TURN service is required. */
    iceTransportPolicy?: RTCIceTransportPolicy;
}
export interface TeamP2PRemote {
    identity(): Promise<{
        teamId: string;
        peerId: string;
        createdAt: number;
    }>;
    changes(input?: {
        afterSequence?: number;
        limit?: number;
    }): Promise<{
        nextCursor: number;
        hasMore: boolean;
        operations: TeamOperation[];
    }>;
    applyOperations(input: {
        operations: TeamOperation[];
    }): Promise<{
        accepted: string[];
        ignored: string[];
        pending: TeamOperation[];
    }>;
    syncStatus(): Promise<{
        teamId: string;
        peerId: string;
        operationCursor: number;
        operationCount: number;
    }>;
}
export type TeamOperationKind = 'challenge_upsert' | 'challenge_delete' | 'note_add' | 'thought_add' | 'evidence_add' | 'task_upsert';
export interface TeamOperation {
    sequence?: number;
    opId: string;
    peerId: string;
    kind: TeamOperationKind;
    payload: unknown;
    createdAt: number;
}
export interface TeamP2PInvite {
    version: 1;
    mode: 'offer' | 'answer';
    teamId: string;
    peerId: string;
    sessionId: string;
    description: RTCSessionDescriptionInit;
}
export interface TeamP2PPeerStatus {
    peerId: string;
    state: RTCPeerConnectionState | 'new';
    connectedAt?: number;
    lastSeenAt?: number;
}
export interface TeamP2PStatus {
    enabled: boolean;
    teamId?: string;
    peerId?: string;
    peers: TeamP2PPeerStatus[];
}
/** Browser-side WebRTC mesh and operation-log synchronizer. */
export declare class TeamP2PController {
    private readonly remote;
    private readonly log;
    private readonly options;
    private readonly connections;
    private readonly pending;
    private identityValue?;
    private pollTimer?;
    private presenceTimer?;
    private disposed;
    private listeners;
    constructor(remote: TeamP2PRemote, log?: (message: string) => void, options?: TeamP2POptions);
    ready(): Promise<TeamP2PStatus>;
    createInvite(): Promise<string>;
    acceptInvite(value: string): Promise<string>;
    completeInvite(value: string): Promise<void>;
    status(): TeamP2PStatus;
    subscribe(listener: (status: TeamP2PStatus) => void): () => void;
    disconnect(peerId?: string): void;
    dispose(): void;
    private identity;
    private makeConnection;
    private bindChannel;
    private sendHello;
    private receive;
    private syncAll;
    private syncPeer;
    private sendPresence;
    private send;
    private emitStatus;
    private emitSyncEvent;
}
