/** Register the optional sandbox_run tool backed by the external Docker plugin. */
export function setupSandboxTool(ctx: any, config: { sandboxImage?: string }): void {
  const defaultImage = config.sandboxImage ?? 'kalilinux/kali-rolling'
  let registeredTools: any
  let registeredSandbox: any
  let unregister: (() => void) | undefined

  const wire = () => {
    const tools = lookup(ctx, 'tools')
    const sandbox = lookup(ctx, 'dockerSandbox') ?? lookup(ctx, 'sandbox')
    if (!tools || !sandbox || typeof tools.register !== 'function' || typeof sandbox.run !== 'function') return
    if (tools === registeredTools && sandbox === registeredSandbox) return
    unregister?.()
    const definition = {
      name: 'sandbox_run',
      description: 'Run a command in a disposable Docker sandbox. Never execute untrusted challenge files on the host.',
      parameters: {
        command: { type: 'string', required: true },
        args: { type: 'array', items: { type: 'string' } },
        image: { type: 'string' },
        timeoutMs: { type: 'number' },
        network: { type: 'string', enum: ['none', 'host', 'bridge'] },
        workdir: { type: 'string' },
        env: { type: 'object', additionalProperties: { type: 'string' } },
        mounts: { type: 'array', items: { type: 'object' } },
      },
      output: {
        schema: { type: 'object' },
        render: (_args: any, value: any) => {
          const parts = [
            ...(typeof value?.exitCode === 'number' ? [`exit ${value.exitCode}`] : []),
            ...(value?.timedOut ? ['timed out'] : []),
            ...(value?.stdout ? [value.stdout] : []),
            ...(value?.stderr ? ['[stderr]', value.stderr] : []),
          ]
          return [{ type: 'text', text: parts.length > 0 ? parts.join('\n') : '(sandbox_run completed with no output)' }]
        },
      },
      async execute(args: any) {
        const result = await sandbox.run({
          image: args.image ?? defaultImage,
          cmd: [args.command, ...(args.args ?? [])],
          timeoutMs: args.timeoutMs,
          networkDisabled: args.network === 'none' || args.network === undefined,
          workdir: args.workdir,
          env: args.env,
          mounts: Array.isArray(args.mounts) ? args.mounts : [],
        })
        return {
          ok: result.exitCode === 0,
          exitCode: result.exitCode ?? -1,
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
          timedOut: Boolean(result.timedOut),
        }
      },
    }
    const disposer = tools.register(definition)
    unregister = typeof disposer === 'function' ? disposer : undefined
    registeredTools = tools
    registeredSandbox = sandbox
  }

  wire()
  ctx.on?.('internal/service', (serviceName: string) => {
    if (serviceName === 'tools' || serviceName === 'dockerSandbox' || serviceName === 'sandbox') wire()
  })
  ctx.on?.('sandbox/ready', wire)
  ctx.on?.('sandbox/ping', wire)
  ctx.effect?.(() => () => unregister?.(), 'dsh-ctf-team sandbox_run cleanup')
}

function lookup(ctx: any, name: string): any {
  try {
    const value = ctx?.get?.(name)
    if (value) return value
  } catch { /* optional service */ }
  return ctx && Object.prototype.hasOwnProperty.call(ctx, name) ? ctx[name] : undefined
}
