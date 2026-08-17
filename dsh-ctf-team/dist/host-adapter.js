import { randomUUID } from 'node:crypto';
import process from 'node:process';
/**
 * Resolve the current Harness webServer route registry, while retaining the
 * older ctx.http.server adapter used by standalone hosts and unit fixtures.
 */
export function getHttpServer(ctx) {
    let webServer;
    try {
        webServer = ctx.get?.('webServer');
    }
    catch { /* optional service lookup */ }
    if (!webServer && ctx && Object.prototype.hasOwnProperty.call(ctx, 'webServer'))
        webServer = ctx.webServer;
    if (webServer && typeof webServer.register === 'function')
        return createWebServerAdapter(webServer);
    let http;
    try {
        http = ctx.get?.('http');
    }
    catch { /* optional service lookup */ }
    // Keep plain-object host fixtures compatible without touching undeclared
    // Cordis proxy properties, which throw when the service is not injected.
    if (!http && ctx && Object.prototype.hasOwnProperty.call(ctx, 'http'))
        http = ctx.http;
    const server = http?.server;
    return server && typeof server.get === 'function' && typeof server.post === 'function' ? server : undefined;
}
/** Adapt the Harness node:http route registry to the small request/response API
 * consumed by the plugin. The webServer registry has exact/prefix routes but
 * no method or parameter layer, so this adapter supplies both. */
function createWebServerAdapter(webServer) {
    const routes = new Map();
    const disposers = new Map();
    const add = (method, path, handler) => {
        const dynamic = path.includes(':');
        const routeKey = dynamic ? path.slice(0, path.indexOf(':')) : (path.replace(/\/$/, '') || '/');
        const mount = dynamic ? routeKey : path;
        const entry = compileRoute(method, path, handler);
        const list = routes.get(routeKey) ?? [];
        list.push(entry);
        routes.set(routeKey, list);
        const disposerKey = `${dynamic ? 'prefix' : 'exact'}:${mount}`;
        if (disposers.has(disposerKey))
            return;
        const disposer = webServer.register({
            kind: dynamic ? 'prefix' : 'exact',
            path: dynamic ? (mount.replace(/\/$/, '') || '/') : mount,
            handler: async (req, res) => {
                const pathname = new URL(req.url ?? '/', 'http://dsh-ctf-team').pathname;
                const candidates = routes.get(routeKey) ?? [];
                const route = candidates.find((item) => item.method === String(req.method ?? 'GET').toUpperCase() && item.pattern.test(pathname));
                if (!route) {
                    if (!res.headersSent) {
                        res.writeHead?.(404);
                        res.end?.();
                    }
                    return;
                }
                const params = matchParams(route, pathname);
                const request = {
                    params,
                    body: String(req.method ?? 'GET').toUpperCase() === 'POST' ? await readBody(req) : undefined,
                    on(event, callback) { req.on?.(event, callback); },
                };
                const response = createResponse(res);
                await route.handler(request, response);
            },
        });
        disposers.set(disposerKey, disposer);
    };
    return {
        get(path, handler) { add('GET', path, handler); },
        post(path, handler) { add('POST', path, handler); },
        static() { throw new Error('dsh-ctf-team: static mounts are not supported by webServer; use an explicit route'); },
        dispose() {
            for (const disposer of disposers.values())
                disposer();
            disposers.clear();
            routes.clear();
        },
    };
}
function compileRoute(method, path, handler) {
    const params = [];
    const parts = path.split('/').map((part) => {
        if (part.startsWith(':')) {
            params.push(part.slice(1));
            return '([^/]+)';
        }
        return escapeRegExp(part);
    });
    return { method, path, pattern: new RegExp(`^${parts.join('/')}\\/?$`), params, handler };
}
function matchParams(route, pathname) {
    const match = route.pattern.exec(pathname);
    const params = {};
    route.params.forEach((name, index) => { params[name] = decodeURIComponent(match?.[index + 1] ?? ''); });
    return params;
}
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
async function readBody(req) {
    const chunks = [];
    for await (const chunk of req)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (!text)
        return {};
    const type = String(req.headers?.['content-type'] ?? '');
    if (type.includes('application/json'))
        return JSON.parse(text);
    return text;
}
function createResponse(res) {
    const response = {
        json(value) {
            if (!res.headersSent)
                res.setHeader?.('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(value));
        },
        status(code) { res.statusCode = code; return response; },
        setHeader(name, value) { res.setHeader(name, value); },
        write(value) { res.write(value); },
        end() { res.end(); },
    };
    return response;
}
/** Resolve the best available Harness Agent execution seam. */
export function getSessionForkAdapter(ctx) {
    const explicit = lookup(ctx, 'ctfTeamSessionFork');
    if (explicit && typeof explicit.fork === 'function')
        return explicit;
    const subagents = lookup(ctx, 'subagents');
    if (subagents && typeof subagents.start === 'function') {
        const agents = lookup(ctx, 'agents');
        return createSubagentAdapter(ctx, subagents, agents);
    }
    let session = lookup(ctx, 'session');
    if (!session && ctx && Object.prototype.hasOwnProperty.call(ctx, 'session'))
        session = ctx.session;
    if (!session || typeof session.fork !== 'function')
        return undefined;
    return createSessionForkAdapter(session);
}
function lookup(ctx, name) {
    try {
        const value = ctx?.get?.(name);
        if (value)
            return value;
    }
    catch { /* optional service lookup */ }
    if (ctx && Object.prototype.hasOwnProperty.call(ctx, name))
        return ctx[name];
    return undefined;
}
/** Adapter for Harness's named subagent providers (`fork`/`spawn`). */
function createSubagentAdapter(ctx, subagents, agents) {
    let parentPromise;
    return {
        async fork(prompt) {
            const providerName = resolveProvider(subagents);
            const parent = await ensureParentAgent(ctx, agents, () => { parentPromise = undefined; });
            if (!parent)
                throw new Error('No live Harness Agent is available as the parent session for this task');
            const controller = new AbortController();
            const run = await subagents.start(providerName, { prompt: [{ type: 'text', text: prompt }], parent, label: 'CTF Team task', signal: controller.signal });
            const listeners = new Set();
            const buffered = [];
            const childId = String(run?.id ?? run?.localAgent?.session?.id ?? '');
            const emit = (content) => {
                if (!content)
                    return;
                if (!listeners.size)
                    buffered.push(content);
                else
                    for (const listener of listeners)
                        listener(content);
            };
            const detach = attachHarnessSessionEvents(ctx, childId, emit);
            return {
                content: Promise.resolve(run.result).then((result) => {
                    const output = extractContent(result?.output ?? result);
                    if (result?.stopReason && result.stopReason !== 'completed')
                        return `${output}\n[stopReason: ${result.stopReason}]`.trim();
                    return output;
                }),
                onMessage(listener) {
                    listeners.add(listener);
                    for (const content of buffered.splice(0))
                        listener(content);
                    return () => listeners.delete(listener);
                },
                async dispose() {
                    detach?.();
                    controller.abort();
                    await run.dispose?.();
                },
            };
        },
    };
}
function resolveProvider(subagents) {
    const names = typeof subagents.listProviders === 'function' ? subagents.listProviders() : [];
    for (const candidate of ['fork', 'spawn'])
        if (!names.length || names.includes(candidate))
            return candidate;
    throw new Error(`No Harness subagent provider is registered (available: ${names.join(', ') || 'none'})`);
}
async function ensureParentAgent(ctx, agents, reset) {
    try {
        const current = agents?.currentInitiator?.();
        if (current)
            return current;
    }
    catch { /* use a live root below */ }
    try {
        const current = ctx?.agent;
        if (current)
            return current;
    }
    catch { /* optional context carrier */ }
    try {
        const list = agents?.list?.();
        if (Array.isArray(list) && list.length)
            return list[0];
    }
    catch { /* optional registry */ }
    if (!agents?.create)
        throw new Error('No live Harness Agent is available as the parent session for this task');
    const holder = ctx.__ctfTeamAgentParent;
    if (holder?.agent)
        return holder.agent;
    const existing = ctx.__ctfTeamAgentParentPromise;
    if (existing)
        return existing;
    const creation = (async () => {
        const defaultModel = lookup(ctx, 'agentDefaultModel');
        const selection = defaultModel?.currentSelection?.();
        const handle = await agents.create({
            sessionId: `ctf-team-${randomUUID()}`,
            meta: { cwd: process.cwd() },
            ...(selection?.provider && selection?.model ? { agentOptions: { provider: selection.provider, model: selection.model } } : {}),
        });
        ctx.__ctfTeamAgentParent = { agent: handle.agent, dispose: handle.dispose };
        return handle.agent;
    })();
    ctx.__ctfTeamAgentParentPromise = creation;
    try {
        return await creation;
    }
    finally {
        ;
        ctx.__ctfTeamAgentParentPromise = undefined;
        reset();
    }
}
function attachHarnessSessionEvents(ctx, childId, emit) {
    if (!childId || typeof ctx?.on !== 'function')
        return undefined;
    const handler = (_session, event) => {
        if (String(_session?.id ?? '') !== childId)
            return;
        const text = extractEventText(event);
        if (text)
            emit(text);
    };
    const disposer = ctx.on('session/event', handler);
    return typeof disposer === 'function' ? disposer : undefined;
}
function extractEventText(event) {
    const data = event?.data ?? event;
    if (typeof data?.chunk?.text === 'string')
        return data.chunk.text;
    if (typeof data?.text === 'string')
        return data.text;
    if (typeof data?.message?.content === 'string')
        return data.message.content;
    if (Array.isArray(data?.message?.content))
        return data.message.content.map((item) => typeof item?.text === 'string' ? item.text : '').join('');
    return '';
}
function createSessionForkAdapter(session) {
    return {
        async fork(prompt) {
            const child = await (session.fork.length > 0 ? session.fork(prompt) : session.fork());
            if (hasContent(child))
                return normalizeExecution(child);
            const listeners = new Set();
            const buffered = [];
            const detach = attachMessages(child, (content) => {
                if (!listeners.size)
                    buffered.push(content);
                else
                    for (const listener of listeners)
                        listener(content);
            });
            const launch = child?.run ?? child?.send ?? child?.prompt ?? child?.execute;
            if (typeof launch !== 'function') {
                detach?.();
                throw new Error('ctx.session.fork() returned a child without content or a runnable method');
            }
            const result = launch.call(child, prompt);
            return {
                content: Promise.resolve(result).then((value) => extractContent(value)),
                onMessage(listener) {
                    listeners.add(listener);
                    for (const content of buffered.splice(0))
                        listener(content);
                    return () => listeners.delete(listener);
                },
                dispose: async () => { detach?.(); await child?.dispose?.(); },
            };
        },
    };
}
function hasContent(value) {
    return value && (typeof value.content === 'string' || value.content instanceof Promise || typeof value.result === 'string' || value.response !== undefined);
}
function normalizeExecution(value) {
    return {
        content: extractContent(value),
        onMessage: typeof value?.onMessage === 'function' ? value.onMessage.bind(value) : undefined,
        dispose: typeof value?.dispose === 'function' ? value.dispose.bind(value) : undefined,
    };
}
function extractContent(value) {
    if (typeof value === 'string')
        return value;
    if (Array.isArray(value))
        return value.map((item) => extractContent(item)).join('');
    if (value && typeof value.text === 'string')
        return value.text;
    if (value && typeof value.content === 'string')
        return value.content;
    if (value?.content && typeof value.content.then === 'function')
        return Promise.resolve(value.content).then((item) => extractContent(item));
    if (value && typeof value.result === 'string')
        return value.result;
    if (value?.result && typeof value.result.then === 'function')
        return Promise.resolve(value.result).then((item) => extractContent(item));
    if (value && typeof value.response === 'string')
        return value.response;
    if (value?.response && typeof value.response.then === 'function')
        return Promise.resolve(value.response).then((item) => extractContent(item));
    return String(value ?? '');
}
function attachMessages(child, listener) {
    if (typeof child?.onMessage === 'function')
        return child.onMessage(listener);
    if (typeof child?.subscribe === 'function')
        return child.subscribe(listener);
    if (typeof child?.on === 'function') {
        const handler = (event) => listener(typeof event === 'string' ? event : extractContent(event));
        child.on('message', handler);
        return () => child.off?.('message', handler);
    }
    return undefined;
}
