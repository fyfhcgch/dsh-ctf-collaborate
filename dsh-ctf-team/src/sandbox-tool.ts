/** Register the optional sandbox_run tool backed by the external Docker plugin. */
export function setupSandboxTool(ctx: any, config: { sandboxImage?: string }): void {
  const tools = lookup(ctx, 'tools')
  const sandbox = lookup(ctx, 'dockerSandbox') ?? lookup(ctx, 'sandbox')
  if (!tools || !sandbox || typeof tools.register !== 'function' || typeof sandbox.run !== 'function') return

  const defaultImage = config.sandboxImage ?? 'kalilinux/kali-rolling'
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
    output: { schema: { type: 'object' } },
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
  const dispose = tools.register(definition)
  if (typeof dispose === 'function') ctx.effect?.(() => dispose, 'dsh-ctf-team sandbox_run cleanup')
}

function lookup(ctx: any, name: string): any {
  try {
    const value = ctx?.get?.(name)
    if (value) return value
  } catch { /* optional service */ }
  return ctx && Object.prototype.hasOwnProperty.call(ctx, name) ? ctx[name] : undefined
}
