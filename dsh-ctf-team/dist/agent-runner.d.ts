import type { Broadcaster } from './sse-broadcast.js';
import type { TeamDb, TeamOperationKind } from './types.js';
import type { SessionForkAdapter } from './host-adapter.js';
export type AgentMutationSink = (kind: TeamOperationKind, payload: unknown) => void;
export declare function setupAgentRunner(db: TeamDb, broadcast: Broadcaster, adapter: SessionForkAdapter | undefined, concurrentLimit: number, mutationSink?: AgentMutationSink): {
    available: boolean;
    spawn(challengeId: string, ownerUserId: string, prompt: string): Promise<{
        taskId: `${string}-${string}-${string}-${string}-${string}`;
        response: string;
    }>;
};
export type AgentRunner = ReturnType<typeof setupAgentRunner>;
