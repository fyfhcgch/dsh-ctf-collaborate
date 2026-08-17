import type { BroadcastEvent } from './types.js'

type SseClient = { write(data: string): void; close(): void }
export function createBroadcast() {
  const clients = new Set<SseClient>()
  return {
    connectClient(client: SseClient) { clients.add(client); return () => clients.delete(client) },
    emit<T>(event: BroadcastEvent<T>) {
      const data = `data: ${JSON.stringify(event)}\n\n`
      for (const client of clients) { try { client.write(data) } catch { clients.delete(client) } }
    },
    close() { for (const client of clients) client.close(); clients.clear() },
  }
}
export type Broadcaster = ReturnType<typeof createBroadcast>
