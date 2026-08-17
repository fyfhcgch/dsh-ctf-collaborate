import assert from 'node:assert/strict'
import test from 'node:test'
import { getSessionForkAdapter } from '../dist/host-adapter.js'

test('host adapter falls back to ctx.session.fork and keeps streamed messages', async () => {
  const seen = []
  const ctx = {
    session: {
      fork() {
        return {
          onMessage(listener) { this.listener = listener; return () => {} },
          async run(prompt) { this.listener?.(`thought:${prompt}`); return { content: `result:${prompt}` } },
        }
      },
      get() { return undefined },
    },
  }
  const adapter = getSessionForkAdapter(ctx)
  assert.ok(adapter)
  const child = await adapter.fork('inspect')
  child.onMessage?.((content) => seen.push(content))
  assert.equal(await child.content, 'result:inspect')
  assert.deepEqual(seen, ['thought:inspect'])
})

test('explicit ctfTeamSessionFork takes precedence over ctx.session', async () => {
  const explicit = { async fork() { return { content: 'explicit' } } }
  const ctx = { session: { fork() { throw new Error('wrong adapter') } }, get(name) { return name === 'ctfTeamSessionFork' ? explicit : undefined } }
  const adapter = getSessionForkAdapter(ctx)
  assert.equal(await (await adapter.fork('x')).content, 'explicit')
})
