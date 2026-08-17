export interface HttpRequest {
    body?: unknown;
    params: Record<string, string>;
    on?(event: string, cb: (...args: any[]) => void): void;
}
export interface HttpResponse {
    json(value: unknown): void;
    status(code: number): HttpResponse;
    setHeader(name: string, value: string): void;
    write(value: string): void;
    end(): void;
}
export interface HttpServer {
    get(path: string, handler: (req: HttpRequest, res: HttpResponse) => void | Promise<void>): void;
    post(path: string, handler: (req: HttpRequest, res: HttpResponse) => void | Promise<void>): void;
    static(path: string, directory: string): void;
    dispose?(): void;
}
export interface SessionForkExecution {
    content: string | Promise<string>;
    onMessage?(listener: (content: string) => void): () => void;
    dispose?(): Promise<void> | void;
}
export interface SessionForkAdapter {
    fork(prompt: string): Promise<SessionForkExecution>;
}
/**
 * Resolve the current Harness webServer route registry, while retaining the
 * older ctx.http.server adapter used by standalone hosts and unit fixtures.
 */
export declare function getHttpServer(ctx: any): HttpServer | undefined;
/** Resolve the best available Harness Agent execution seam. */
export declare function getSessionForkAdapter(ctx: any): SessionForkAdapter | undefined;
