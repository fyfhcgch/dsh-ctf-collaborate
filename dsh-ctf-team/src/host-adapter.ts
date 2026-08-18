import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import process from 'node:process'
/* Host APIs differ between Cordis deployments. This is the only compatibility boundary. */
export interface HttpRequest { body?: unknown; params: Record<string, string>; on?(event: string, cb: (...args: any[]) => void): void }
export interface HttpResponse { json(value: unknown): void; status(code: number): HttpResponse; setHeader(name: string, value: string): void; write(value: string): void; end(): void }
export interface HttpServer {
  get(path: string, handler: (req: HttpRequest, res: HttpResponse) => void | Promise<void>): void
  post(path: string, handler: (req: HttpRequest, res: HttpResponse) => void | Promise<void>): void
  static(path: string, directory: string): void
  dispose?(): void
}
export interface SessionForkExecution {
  content: string | Promise<string>
  onMessage?(listener: (content: string) => void): () => void
  dispose?(): Promise<void> | void
}
export interface SessionForkAdapter { fork(prompt: string): Promise<SessionForkExecution> }

/**
 * Resolve the current Harness webServer route registry, while retaining the
 * older ctx.http.server adapter used by standalone hosts and unit fixtures.
 */
export function getHttpServer(ctx: any): HttpServer | undefined {
  let webServer: any
  try { webServer = ctx.get?.('webServer') } catch { /* optional service lookup */ }
  if (!webServer && ctx && Object.prototype.hasOwnProperty.call(ctx, 'webServer')) webServer = ctx.webServer
  if (webServer && typeof webServer.register === 'function') return createWebServerAdapter(webServer)

  let http: any
  try { http = ctx.get?.('http') } catch { /* optional service lookup */ }
  // Keep plain-object host fixtures compatible without touching undeclared
  // Cordis proxy properties, which throw when the service is not injected.
  if (!http && ctx && Object.prototype.hasOwnProperty.call(ctx, 'http')) http = ctx.http
  const server = http?.server
  return server && typeof server.get === 'function' && typeof server.post === 'function' ? server as HttpServer : undefined
}

type RouteHandler = (req: HttpRequest, res: HttpResponse) => void | Promise<void>
type RegisteredRoute = { method: string; path: string; pattern: RegExp; params: string[]; handler: RouteHandler }

/** Adapt the Harness node:http route registry to the small request/response API
 * consumed by the plugin. The webServer registry has exact/prefix routes but
 * no method or parameter layer, so this adapter supplies both. */
function createWebServerAdapter(webServer: any): HttpServer {
  const routes = new Map<string, RegisteredRoute[]>()
  const disposers = new Map<string, () => void>()

  const add = (method: string, path: string, handler: RouteHandler): void => {
    const dynamic = path.includes(':')
    const routeKey = dynamic ? path.slice(0, path.indexOf(':')) : (path.replace(/\/$/, '') || '/')
    const mount = dynamic ? routeKey : path
    const entry = compileRoute(method, path, handler)
    const list = routes.get(routeKey) ?? []
    list.push(entry)
    routes.set(routeKey, list)
    const disposerKey = `${dynamic ? 'prefix' : 'exact'}:${mount}`
    if (disposers.has(disposerKey)) return
    const disposer = webServer.register({
      kind: dynamic ? 'prefix' : 'exact',
      path: dynamic ? (mount.replace(/\/$/, '') || '/') : mount,
      handler: async (req: any, res: any) => {
        const pathname = new URL(req.url ?? '/', 'http://dsh-ctf-team').pathname
        const candidates = routes.get(routeKey) ?? []
        const route = candidates.find((item) => item.method === String(req.method ?? 'GET').toUpperCase() && item.pattern.test(pathname))
        if (!route) {
          if (!res.headersSent) { res.writeHead?.(404); res.end?.() }
          return
        }
        const params = matchParams(route, pathname)
        const request: HttpRequest = {
          params,
          body: String(req.method ?? 'GET').toUpperCase() === 'POST' ? await readBody(req) : undefined,
          on(event, callback) { req.on?.(event, callback) },
        }
        const response = createResponse(res)
        await route.handler(request, response)
      },
    })
    disposers.set(disposerKey, disposer)
  }

  return {
    get(path, handler) { add('GET', path, handler) },
    post(path, handler) { add('POST', path, handler) },
    static() { throw new Error('dsh-ctf-team: static mounts are not supported by webServer; use an explicit route') },
    dispose() {
      for (const disposer of disposers.values()) disposer()
      disposers.clear()
      routes.clear()
    },
  }
}

function compileRoute(method: string, path: string, handler: RouteHandler): RegisteredRoute {
  const params: string[] = []
  const parts = path.split('/').map((part) => {
    if (part.startsWith(':')) {
      params.push(part.slice(1))
      return '([^/]+)'
    }
    return escapeRegExp(part)
  })
  return { method, path, pattern: new RegExp(`^${parts.join('/')}\\/?$`), params, handler }
}

function matchParams(route: RegisteredRoute, pathname: string): Record<string, string> {
  const match = route.pattern.exec(pathname)
  const params: Record<string, string> = {}
  route.params.forEach((name, index) => { params[name] = decodeURIComponent(match?.[index + 1] ?? '') })
  return params
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

async function readBody(req: any): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  const type = String(req.headers?.['content-type'] ?? '')
  if (type.includes('application/json')) return JSON.parse(text)
  return text
}

function createResponse(res: any): HttpResponse {
  const response: HttpResponse = {
    json(value) {
      if (!res.headersSent) res.setHeader?.('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(value))
    },
    status(code) { res.statusCode = code; return response },
    setHeader(name, value) { res.setHeader(name, value) },
    write(value) { res.write(value) },
    end() { res.end() },
  }
  return response
}

/** Resolve the best available Harness Agent execution seam. */
export function getSessionForkAdapter(ctx: any): SessionForkAdapter | undefined {
  const explicit = lookup(ctx, 'ctfTeamSessionFork')
  if (explicit && typeof explicit.fork === 'function') return explicit as SessionForkAdapter

  const subagents = lookup(ctx, 'subagents')
  if (subagents && typeof subagents.start === 'function') {
    const agents = lookup(ctx, 'agents')
    return createSubagentAdapter(ctx, subagents, agents)
  }

  let session: any = lookup(ctx, 'session')
  if (!session && ctx && Object.prototype.hasOwnProperty.call(ctx, 'session')) session = ctx.session
  if (!session || typeof session.fork !== 'function') return undefined
  return createSessionForkAdapter(session)
}

function lookup(ctx: any, name: string): any {
  try {
    const value = ctx?.get?.(name)
    if (value) return value
  } catch { /* optional service lookup */ }
  if (ctx && Object.prototype.hasOwnProperty.call(ctx, name)) return ctx[name]
  return undefined
}

/** Adapter for Harness's named subagent providers (`fork`/`spawn`). */
function createSubagentAdapter(ctx: any, subagents: any, agents: any): SessionForkAdapter {
  let parentPromise: Promise<any> | undefined
  return {
    async fork(prompt: string): Promise<SessionForkExecution> {
      const providerName = resolveProvider(subagents)
      const parent = await ensureParentAgent(ctx, agents, () => { parentPromise = undefined })
      if (!parent) throw new Error('No live Harness Agent is available as the parent session for this task')
      const controller = new AbortController()
      const run = await subagents.start(providerName, { prompt: [{ type: 'text', text: prompt }], parent, label: 'CTF Team task', signal: controller.signal })
      const listeners = new Set<(content: string) => void>()
      const buffered: string[] = []
      const childId = String(run?.id ?? run?.localAgent?.session?.id ?? '')
      const emit = (content: string) => {
        if (!content) return
        if (!listeners.size) buffered.push(content)
        else for (const listener of listeners) listener(content)
      }
      const detach = attachHarnessSessionEvents(ctx, childId, emit)
      return {
        content: Promise.resolve(run.result).then((result: any) => resolveSubagentContentWithDsmlFallback(run, result, emit)),
        onMessage(listener) {
          listeners.add(listener)
          for (const content of buffered.splice(0)) listener(content)
          return () => listeners.delete(listener)
        },
        async dispose() {
          detach?.()
          controller.abort()
          await run.dispose?.()
        },
      }
    },
  }
}

function resolveProvider(subagents: any): string {
  const names = typeof subagents.listProviders === 'function' ? subagents.listProviders() : []
  for (const candidate of ['fork', 'spawn']) if (!names.length || names.includes(candidate)) return candidate
  throw new Error(`No Harness subagent provider is registered (available: ${names.join(', ') || 'none'})`)
}

async function ensureParentAgent(ctx: any, agents: any, reset: () => void): Promise<any> {
  try {
    const current = agents?.currentInitiator?.()
    if (current) return current
  } catch { /* use a live root below */ }
  try {
    const current = ctx?.agent
    if (current) return current
  } catch { /* optional context carrier */ }
  try {
    const list = agents?.list?.()
    if (Array.isArray(list) && list.length) return list[0]
  } catch { /* optional registry */ }
  if (!agents?.create) throw new Error('No live Harness Agent is available as the parent session for this task')
  const holder = (ctx as any).__ctfTeamAgentParent as { agent: any; dispose?: () => Promise<void> } | undefined
  if (holder?.agent) return holder.agent
  const existing = (ctx as any).__ctfTeamAgentParentPromise as Promise<any> | undefined
  if (existing) return existing
  const creation = (async () => {
    const defaultModel = lookup(ctx, 'agentDefaultModel')
    const selection = defaultModel?.currentSelection?.()
    const handle = await agents.create({
      sessionId: `ctf-team-${randomUUID()}`,
      meta: { cwd: process.cwd() },
      ...(selection?.provider && selection?.model ? { agentOptions: { provider: selection.provider, model: selection.model } } : {}),
    })
    ;(ctx as any).__ctfTeamAgentParent = { agent: handle.agent, dispose: handle.dispose }
    return handle.agent
  })()
  ;(ctx as any).__ctfTeamAgentParentPromise = creation
  try { return await creation } finally { ;(ctx as any).__ctfTeamAgentParentPromise = undefined; reset() }
}

function attachHarnessSessionEvents(ctx: any, childId: string, emit: (content: string) => void): (() => void) | undefined {
  if (!childId || typeof ctx?.on !== 'function') return undefined
  const handler = (_session: any, event: any) => {
    if (String(_session?.id ?? '') !== childId) return
    const text = extractEventText(event)
    if (text) emit(text)
  }
  const disposer = ctx.on('session/event', handler)
  return typeof disposer === 'function' ? disposer : undefined
}

function extractEventText(event: any): string {
  const data = event?.data ?? event
  const chunk = data?.chunk
  // Stream deltas arrive token-by-token and made the task log unreadable. Keep
  // only completed assistant blocks plus explicit host messages.
  if (chunk?.type === 'block-end') return extractContent(chunk.block) as string
  if (typeof data?.text === 'string') return data.text
  // Final assistant/message repeats the already-emitted block-end content; skip it
  // for the live thought stream and read it directly in latestAssistantText().
  return ''
}


const DSML_TOOL_ROUND_LIMIT = 8
const DSML_TOOL_COMMAND_LIMIT = 4
const DSML_TOOL_TIMEOUT_MS = 120_000
const DSML_TOOL_OUTPUT_LIMIT = 80_000

interface DsmlToolCall { name: string; parameters: Record<string, string> }
interface ShellRunResult { exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean; stdout: string; stderr: string; truncated: boolean }

async function resolveSubagentContentWithDsmlFallback(run: any, result: any, emit: (content: string) => void): Promise<string> {
  let output = resultToText(result)
  const transcript: string[] = [output]
  let exhausted = false
  for (let round = 1; round <= DSML_TOOL_ROUND_LIMIT; round += 1) {
    const calls = parseDsmlToolCalls(output).filter(isShellLikeCall).slice(0, DSML_TOOL_COMMAND_LIMIT)
    if (!calls.length) break
    if (round === DSML_TOOL_ROUND_LIMIT) exhausted = true
    const agent = run?.localAgent
    if (!agent || typeof agent.followup !== 'function' || typeof agent.whenIdle !== 'function') {
      transcript.push(`\n[DSML fallback] ${calls.length} shell call(s) detected, but this adapter has no live child agent for continuation.`)
      break
    }
    const observations: string[] = []
    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index]!
      const command = call.parameters.command ?? call.parameters.cmd ?? call.parameters.script ?? ''
      if (!command.trim()) {
        observations.push(`### Tool ${index + 1}: ${call.name}\nMissing command parameter.`)
        continue
      }
      const description = call.parameters.description ?? `DSML ${call.name} command`
      emit(`[DSML tool ${round}.${index + 1}] ${description}\n$ ${command}`)
      const executed = await runShellCommand(command)
      const rendered = renderShellResult(executed)
      observations.push(`### Tool ${index + 1}: ${call.name}\nDescription: ${description}\nCommand:\n\`\`\`bash\n${command}\n\`\`\`\nResult:\n${rendered}`)
      emit(`[DSML tool ${round}.${index + 1} result]\n${rendered}`)
    }
    const beforeSeq = Number(agent.session?.seq ?? agent.session?.events?.length ?? 0)
    agent.followup({
      role: 'user',
      id: randomUUID(),
      content: [{ type: 'text', text: formatDsmlToolFollowup(round, observations) }],
      source: { kind: 'plugin', plugin: 'dsh-ctf-team', form: 'dsml-tool-result' },
    })
    await agent.whenIdle()
    output = latestAssistantText(agent, beforeSeq) || output
    transcript.push(`\n\n## DSML tool round ${round}\n${observations.join('\n\n')}\n\n## Agent continuation ${round}\n${output}`)
  }
  if (exhausted && parseDsmlToolCalls(output).filter(isShellLikeCall).length) transcript.push(`\n[DSML fallback] round limit ${DSML_TOOL_ROUND_LIMIT} reached; latest assistant output still contains shell calls.`)
  return transcript.join('\n').trim()
}

function resultToText(result: any): string {
  const output = extractContent(result?.output ?? result) as string
  if (result?.stopReason && result.stopReason !== 'completed') return `${output}\n[stopReason: ${result.stopReason}]`.trim()
  return output
}

function parseDsmlToolCalls(text: string): DsmlToolCall[] {
  if (!text.includes('DSML')) return []
  const calls: DsmlToolCall[] = []
  const invokePattern = /<\s*｜｜DSML｜｜invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/\s*｜｜DSML｜｜invoke\s*>/g
  for (const match of text.matchAll(invokePattern)) {
    const parameters: Record<string, string> = {}
    const body = match[2] ?? ''
    const parameterPattern = /<\s*｜｜DSML｜｜parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/\s*｜｜DSML｜｜parameter\s*>/g
    for (const parameter of body.matchAll(parameterPattern)) parameters[parameter[1] ?? ''] = decodeXmlEntities(parameter[2] ?? '').trim()
    calls.push({ name: (match[1] ?? '').trim(), parameters })
  }
  return calls
}

function isShellLikeCall(call: DsmlToolCall): boolean {
  return ['shell', 'bash', 'sh', 'terminal'].includes(call.name.toLowerCase())
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}

function runShellCommand(command: string): Promise<ShellRunResult> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let truncated = false
    let settled = false
    const append = (which: 'stdout' | 'stderr', chunk: Buffer) => {
      const next = redactRuntimeSecrets(chunk.toString('utf8'))
      if (which === 'stdout') stdout = appendBounded(stdout, next)
      else stderr = appendBounded(stderr, next)
      if ((stdout.length + stderr.length) >= DSML_TOOL_OUTPUT_LIMIT) truncated = true
    }
    const timer = setTimeout(() => {
      if (settled) return
      child.kill('SIGTERM')
      setTimeout(() => { if (!settled) child.kill('SIGKILL') }, 1500).unref()
    }, DSML_TOOL_TIMEOUT_MS)
    timer.unref()
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk))
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk))
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode: null, signal: null, timedOut: false, stdout, stderr: appendBounded(stderr, redactRuntimeSecrets(String(error))), truncated })
    })
    child.on('close', (exitCode, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode, signal, timedOut: signal === 'SIGTERM' || signal === 'SIGKILL', stdout, stderr, truncated })
    })
  })
}

function appendBounded(current: string, next: string): string {
  if (current.length >= DSML_TOOL_OUTPUT_LIMIT) return current
  const remaining = DSML_TOOL_OUTPUT_LIMIT - current.length
  return current + next.slice(0, remaining)
}

function renderShellResult(result: ShellRunResult): string {
  const status = `exitCode=${result.exitCode ?? 'null'} signal=${result.signal ?? 'none'} timedOut=${result.timedOut}`
  const parts = [`Status: ${status}`]
  if (result.stdout) parts.push(`stdout:\n\`\`\`text\n${result.stdout}\n\`\`\``)
  if (result.stderr) parts.push(`stderr:\n\`\`\`text\n${result.stderr}\n\`\`\``)
  if (result.truncated) parts.push(`[output truncated at ${DSML_TOOL_OUTPUT_LIMIT} chars]`)
  return parts.join('\n')
}

function formatDsmlToolFollowup(round: number, observations: string[]): string {
  return `宿主已执行你上一轮输出的 DSML shell 调用（round ${round}）。请基于以下结果继续完成题目；若还需要命令，继续用同样的 DSML shell 调用格式，每轮只放关键命令。\n\n${observations.join('\n\n')}`
}

function latestAssistantText(agent: any, afterSeq: number): string {
  const events = Array.isArray(agent.session?.events) ? agent.session.events : []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    const seq = Number(event.seq ?? index)
    if (seq < afterSeq) continue
    return extractContent(event.data?.message?.content ?? '') as string
  }
  return ''
}

function redactRuntimeSecrets(text: string): string {
  return text
    .replace(/ak_live_[A-Za-z0-9_-]{8,256}/g, '[REDACTED_ACCESS_KEY]')
    .replace(/Authorization=eyJ[A-Za-z0-9._-]+/g, 'Authorization=[REDACTED_JWT]')
    .replace(/Bearer\s+eyJ[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED_JWT]')
    .replace(/(DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|DASCTF_ACCESS_KEY)=\S+/g, '$1=[REDACTED]')
}

function createSessionForkAdapter(session: any): SessionForkAdapter {
  return {
    async fork(prompt: string): Promise<SessionForkExecution> {
      const child = await (session.fork.length > 0 ? session.fork(prompt) : session.fork())
      if (hasContent(child)) return normalizeExecution(child)
      const listeners = new Set<(content: string) => void>()
      const buffered: string[] = []
      const detach = attachMessages(child, (content) => {
        if (!listeners.size) buffered.push(content)
        else for (const listener of listeners) listener(content)
      })
      const launch = child?.run ?? child?.send ?? child?.prompt ?? child?.execute
      if (typeof launch !== 'function') {
        detach?.()
        throw new Error('ctx.session.fork() returned a child without content or a runnable method')
      }
      const result = launch.call(child, prompt)
      return {
        content: Promise.resolve(result).then((value) => extractContent(value)),
        onMessage(listener) {
          listeners.add(listener)
          for (const content of buffered.splice(0)) listener(content)
          return () => listeners.delete(listener)
        },
        dispose: async () => { detach?.(); await child?.dispose?.() },
      }
    },
  }
}

function hasContent(value: any): boolean {
  return value && (typeof value.content === 'string' || value.content instanceof Promise || typeof value.result === 'string' || value.response !== undefined)
}

function normalizeExecution(value: any): SessionForkExecution {
  return {
    content: extractContent(value),
    onMessage: typeof value?.onMessage === 'function' ? value.onMessage.bind(value) : undefined,
    dispose: typeof value?.dispose === 'function' ? value.dispose.bind(value) : undefined,
  }
}

function extractContent(value: any): string | Promise<string> {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((item) => extractContent(item)).join('')
  if (value && typeof value.text === 'string') return value.text
  if (value && typeof value.content === 'string') return value.content
  if (value?.content && typeof value.content.then === 'function') return Promise.resolve(value.content).then((item) => extractContent(item))
  if (value && typeof value.result === 'string') return value.result
  if (value?.result && typeof value.result.then === 'function') return Promise.resolve(value.result).then((item) => extractContent(item))
  if (value && typeof value.response === 'string') return value.response
  if (value?.response && typeof value.response.then === 'function') return Promise.resolve(value.response).then((item) => extractContent(item))
  return String(value ?? '')
}

function attachMessages(child: any, listener: (content: string) => void): (() => void) | undefined {
  if (typeof child?.onMessage === 'function') return child.onMessage(listener)
  if (typeof child?.subscribe === 'function') return child.subscribe(listener)
  if (typeof child?.on === 'function') {
    const handler = (event: any) => listener(typeof event === 'string' ? event : extractContent(event) as string)
    child.on('message', handler)
    return () => child.off?.('message', handler)
  }
  return undefined
}
