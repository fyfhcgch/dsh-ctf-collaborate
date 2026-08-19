/**
 * dsh-ctf-console — CTF 解题控制台（Host 半）。
 *
 * 通过 webServer 注册前缀路由 /api/ctf-console/*，用全局 fetch 调用 CTF
 * 平台 API（X-Agent-AccessKey 认证）。凭据仅保存在本进程内存，不落盘。
 *
 * 端点（POST /api/ctf-console/<action>，body 为 JSON 对象）：
 *   configure {serverHost, accessKey}  保存凭据
 *   status                             返回当前配置状态
 *   overview / notices / list / detail {exerciseId}
 *   build {exerciseId} / recover {exerciseId}
 *   submit {exerciseId, flag}
 *
 * 所有 action 返回统一信封 {ok, code?, message?, data?, error?}。
 *
 * @module @dsh-external/dsh-ctf-console
 */
export const name = 'ctf-console'
export const inject = ['webServer']

const MAX_BODY_BYTES = 65536

/** 收集请求体（大小受限）。 */
function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('request body too large'), { code: 'ETOOBIG' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 写 JSON 响应。 */
function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

export function apply(ctx) {
  const state = { serverHost: '', accessKey: '' }

  /** 调用 CTF 平台 API，返回统一信封。 */
  async function platform(method, path, payload) {
    const base = state.serverHost.replace(/\/+$/, '')
    if (!base) return { ok: false, error: '请先配置 serverHost' }
    const headers = { 'X-Agent-AccessKey': state.accessKey }
    if (payload !== undefined) headers['Content-Type'] = 'application/json'
    let res
    try {
      res = await fetch(base + path, {
        method,
        headers,
        body: payload !== undefined ? JSON.stringify(payload) : undefined,
      })
    } catch (error) {
      return { ok: false, error: '网络请求失败: ' + String(error?.message ?? error) }
    }
    const text = await res.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      return { ok: false, httpStatus: res.status, error: '非 JSON 响应: ' + text.slice(0, 200) }
    }
    return {
      ok: true,
      httpStatus: res.status,
      code: json.code,
      message: json.message || '',
      data: json.data,
    }
  }

  /** 将平台题目详情整理为 planner.start 输入并启动专家工作流。 */
  async function startSolving(args) {
    const planner = ctx.get('planner')
    if (!planner || typeof planner.start !== 'function') {
      return { ok: false, error: 'planner 服务不可用：请确认 @dsh-external/dsh-planner 已在 profile bundles 中启用' }
    }
    const detail = args?.detail && typeof args.detail === 'object' ? args.detail : {}
    const exerciseId = String(args?.exerciseId ?? detail.id ?? '').trim()
    const title = String(detail.name ?? args?.title ?? (exerciseId ? `CTF 题目 ${exerciseId}` : 'CTF 题目'))
    const files = detail.attachment && Array.isArray(detail.attachment.files) ? detail.attachment.files : []
    const attachments = files.map((file, index) => ({
      name: String(file?.name ?? `attachment-${index + 1}`),
      url: String(file?.url ?? ''),
      note: '平台附件',
    }))
    const endpoints = Array.isArray(detail.endpoints) ? detail.endpoints : []
    const endpointText = endpoints.length
      ? endpoints.map((ep, index) => {
          const ips = Array.isArray(ep?.exposeIps) ? ep.exposeIps.join(', ') : ''
          const ports = Array.isArray(ep?.ports) ? ep.ports.join(', ') : ''
          const users = Array.isArray(ep?.users) ? ep.users.map((u) => `${u?.username ?? ''}/${u?.password ?? ''}`).join(', ') : ''
          const maps = Array.isArray(ep?.portMappings) ? ep.portMappings.map((m) => `${m?.port ?? ''}->${m?.proxy ?? ''}`).join(', ') : ''
          return `靶机 ${index + 1}: IP=${ips || '-'}; ports=${ports || '-'}; users=${users || '-'}; mappings=${maps || '-'}`
        }).join('\n')
      : ''
    const description = [
      exerciseId ? `题目 ID: ${exerciseId}` : '',
      `题目名称: ${title}`,
      detail.category ? `分类: ${detail.category}` : '',
      detail.difficulty ? `难度: ${detail.difficulty}` : '',
      detail.score !== undefined ? `分值: ${detail.score}` : '',
      detail.hasSolved ? '状态: 已解决' : '状态: 未解决',
      detail.description ? `题目描述:\n${detail.description}` : '',
      endpointText ? `靶机信息:\n${endpointText}` : '',
      attachments.length ? `附件:\n${attachments.map((a) => `- ${a.name}: ${a.url}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n')
    const planId = `dasctf-${exerciseId || 'challenge'}-${Date.now()}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80)
    const result = await planner.start({
      planId,
      title,
      description,
      attachments,
      meta: {
        source: 'ctf-console',
        exerciseId: exerciseId || undefined,
        platformHost: state.serverHost || undefined,
        difficulty: detail.difficulty,
        score: detail.score,
      },
      exerciseId: exerciseId || undefined,
      endpoints,
      url: endpoints[0]?.exposeIps?.[0] || undefined,
    })
    return {
      ok: true,
      code: '00000',
      message: '解题计划已启动',
      data: { planId: result.planId, category: result.plan?.category, status: result.plan?.status || 'running' },
    }
  }

  /** 分发 action。 */
  async function handle(action, args) {
    switch (action) {
      case 'configure': {
        state.serverHost = String(args?.serverHost ?? '').trim()
        state.accessKey = String(args?.accessKey ?? '').trim()
        return { ok: true, serverHost: state.serverHost, hasKey: Boolean(state.accessKey) }
      }
      case 'status':
        return { serverHost: state.serverHost, hasKey: Boolean(state.accessKey), transport: 'fetch' }
      case 'overview':
        return platform('GET', '/slab-match/api/v1/agent/answer-panel/overview')
      case 'notices':
        return platform('GET', '/slab-match/api/v1/agent/match/notice/match-info')
      case 'list':
        return platform('GET', '/slab-match/api/v1/agent/ctf/exercise-list')
      case 'detail':
        return platform(
          'GET',
          '/slab-match/api/v1/agent/ctf/exercise?exerciseId=' + encodeURIComponent(String(args?.exerciseId ?? ''))
        )
      case 'build':
        return platform('POST', '/slab-match/api/v1/agent/ctf/build-exercise-env', {
          exerciseId: Number(args?.exerciseId),
        })
      case 'recover':
        return platform('POST', '/slab-match/api/v1/agent/ctf/recover-exercise-env', {
          exerciseId: Number(args?.exerciseId),
        })
      case 'submit':
        return platform('POST', '/slab-match/api/v1/agent/answer-panel/answer', {
          exerciseId: Number(args?.exerciseId),
          flag: String(args?.flag ?? ''),
        })
      case 'solve':
        return startSolving(args)
      default:
        return { ok: false, error: '未知操作: ' + action }
    }
  }

  const dispose = ctx.webServer.register({
    kind: 'prefix',
    path: '/api/ctf-console',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const action = url.pathname.replace(/^\/api\/ctf-console\/?/, '')
        let args = {}
        if (req.method === 'POST' || req.method === 'PUT') {
          const raw = await readBody(req)
          if (raw) {
            try {
              args = JSON.parse(raw)
            } catch {
              /* 忽略非法 body，继续用 query 参数 */
            }
          }
        }
        url.searchParams.forEach((value, key) => {
          if (!(key in args)) args[key] = value
        })
        const result = await handle(action, args)
        sendJson(res, 200, result)
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })
  ctx.effect(() => dispose, 'ctf-console http route')
  ctx.logger?.info?.('ctf-console: /api/ctf-console/* ready')
}
