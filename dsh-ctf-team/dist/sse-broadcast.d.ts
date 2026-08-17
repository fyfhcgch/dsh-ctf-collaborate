import type { BroadcastEvent } from './types.js';
type SseClient = {
    write(data: string): void;
    close(): void;
};
export declare function createBroadcast(): {
    connectClient(client: SseClient): () => boolean;
    emit<T>(event: BroadcastEvent<T>): void;
    close(): void;
};
export type Broadcaster = ReturnType<typeof createBroadcast>;
export {};
