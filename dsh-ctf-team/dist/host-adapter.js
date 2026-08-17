export function getHttpServer(ctx) {
    const server = ctx.get?.('http')?.server ?? ctx.http?.server;
    return server && typeof server.get === 'function' && typeof server.post === 'function' ? server : undefined;
}
export function getSessionForkAdapter(ctx) {
    const adapter = ctx.get?.('ctfTeamSessionFork');
    return adapter && typeof adapter.fork === 'function' ? adapter : undefined;
}
