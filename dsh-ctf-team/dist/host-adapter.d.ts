export interface HttpRequest {
    body?: unknown;
    params: Record<string, string>;
    on?(event: string, cb: () => void): void;
}
export interface HttpResponse {
    json(value: unknown): void;
    status(code: number): HttpResponse;
    setHeader(name: string, value: string): void;
    write(value: string): void;
    end(): void;
}
export interface HttpServer {
    get(path: string, handler: (req: HttpRequest, res: HttpResponse) => void): void;
    post(path: string, handler: (req: HttpRequest, res: HttpResponse) => void | Promise<void>): void;
    static(path: string, directory: string): void;
}
export interface SessionForkAdapter {
    fork(prompt: string): Promise<{
        content: string;
        onMessage?(listener: (content: string) => void): () => void;
    }>;
}
export declare function getHttpServer(ctx: any): HttpServer | undefined;
export declare function getSessionForkAdapter(ctx: any): SessionForkAdapter | undefined;
