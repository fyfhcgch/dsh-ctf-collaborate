/* Host APIs differ between Cordis deployments. This is the only compatibility boundary. */
export interface HttpRequest { body?: unknown; params: Record<string, string>; on?(event: string, cb: () => void): void }
export interface HttpResponse { json(value: unknown): void; status(code: number): HttpResponse; setHeader(name: string, value: string): void; write(value: string): void; end(): void }
export interface HttpServer {
  get(path: string, handler: (req: HttpRequest, res: HttpResponse) => void): void
  post(path: string, handler: (req: HttpRequest, res: HttpResponse) => void | Promise<void>): void
  static(path: string, directory: string): void
}
export interface SessionForkAdapter { fork(prompt: string): Promise<{ content: string; onMessage?(listener: (content: string) => void): () => void }> }
export function getHttpServer(ctx: any): HttpServer | undefined {
  const server = ctx.get?.('http')?.server ?? ctx.http?.server
  return server && typeof server.get === 'function' && typeof server.post === 'function' ? server as HttpServer : undefined
}
export function getSessionForkAdapter(ctx: any): SessionForkAdapter | undefined {
  const adapter = ctx.get?.('ctfTeamSessionFork')
  return adapter && typeof adapter.fork === 'function' ? adapter as SessionForkAdapter : undefined
}
