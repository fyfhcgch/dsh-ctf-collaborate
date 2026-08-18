import assert from 'node:assert/strict'
import test from 'node:test'
import { setupSandboxTool } from '../dist/sandbox-tool.js'

test('sandbox_run registers parameters as a complete object JSON Schema', async () => {
  let definition
  const calls = []
  const ctx = {
    tools: {
      register(value) {
        definition = value
        return () => {}
      },
    },
    dockerSandbox: {
      async run(options) {
        calls.push(options)
        return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }
      },
    },
    on() {},
    effect() {},
  }

  setupSandboxTool(ctx, { sandboxImage: 'fixture/image' })

  assert.equal(definition.name, 'sandbox_run')
  assert.deepEqual(definition.parameters, {
    type: 'object',
    properties: {
      command: { type: 'string' },
      args: { type: 'array', items: { type: 'string' } },
      image: { type: 'string' },
      timeoutMs: { type: 'number' },
      network: { type: 'string', enum: ['none', 'host', 'bridge'] },
      workdir: { type: 'string' },
      env: { type: 'object', additionalProperties: true },
      mounts: { type: 'array', items: { type: 'object', additionalProperties: true } },
    },
    required: ['command'],
  })

  const result = await definition.execute({ command: 'printf', args: ['ok'], network: 'none' })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, [{
    image: 'fixture/image',
    cmd: ['printf', 'ok'],
    timeoutMs: undefined,
    networkDisabled: true,
    workdir: undefined,
    env: undefined,
    mounts: [],
  }])
})
