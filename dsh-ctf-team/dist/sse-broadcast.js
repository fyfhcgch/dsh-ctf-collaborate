export function createBroadcast() {
    const clients = new Set();
    return {
        connectClient(client) { clients.add(client); return () => clients.delete(client); },
        emit(event) {
            const data = `data: ${JSON.stringify(event)}\n\n`;
            for (const client of clients) {
                try {
                    client.write(data);
                }
                catch {
                    clients.delete(client);
                }
            }
        },
        close() { for (const client of clients)
            client.close(); clients.clear(); },
    };
}
