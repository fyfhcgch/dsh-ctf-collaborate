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

test('subagent adapter executes DSML shell fallback and continues the child', async () => {
  const followups = []
  const agent = {
    session: { seq: 10, events: [] },
    followup(message) {
      followups.push(message.content[0].text)
      this.session.seq = 20
      this.session.events.push({
        type: 'assistant/message',
        seq: 20,
        data: { message: { content: [{ type: 'text', text: 'continued after tool output' }] } },
      })
    },
    async whenIdle() {},
  }
  let eventHandler
  const ctx = {
    get(name) {
      if (name === 'subagents') return {
        listProviders: () => ['fork'],
        async start() {
          return {
            id: 'child-1',
            localAgent: agent,
            result: Promise.resolve({
              stopReason: 'completed',
              output: [{ type: 'text', text: '< | | DSML | | tool_calls>\n< | | DSML | | invoke name="shell">\n< | | DSML | | parameter name="command" string="true">printf dsml-ok</ | | DSML | | parameter>\n< | | DSML | | parameter name="description" string="true">probe</ | | DSML | | parameter>\n</ | | DSML | | invoke>\n</ | | DSML | | tool_calls>' }],
            }),
            async dispose() {},
          }
        },
      }
      if (name === 'agents') return { currentInitiator: () => ({ session: { id: 'parent' }, ctx: {} }) }
      return undefined
    },
    on(_event, handler) { eventHandler = handler; return () => {} },
  }
  const adapter = getSessionForkAdapter(ctx)
  const child = await adapter.fork('solve')
  const evidence = []
  const thoughtMessages = []
  child.onMessage?.((content) => thoughtMessages.push(content))
  child.onEvidence?.((content) => evidence.push(content))
  eventHandler?.({ id: 'child-1' }, { data: { chunk: { type: 'block-end', block: { type: 'text', text: `note\n< | | DSML | | tool_calls>< | | DSML | | invoke name=\"shell\">< | | DSML | | parameter name=\"command\">printf hidden</ | | DSML | | parameter></ | | DSML | | invoke></ | | DSML | | tool_calls>` } } } })
  const output = await child.content
  assert.match(output, /printf dsml-ok/)
  assert.match(output, /dsml-ok/)
  assert.match(output, /continued after tool output/)
  assert.equal(thoughtMessages.filter((message) => message === 'note').length, 1)
  assert.equal(thoughtMessages.some((message) => message.includes('hidden')), false)
  assert.equal(followups.length, 1)
  assert.match(followups[0], /dsml-ok/)
  assert.equal(evidence.length, 1)
  assert.match(evidence[0], /printf dsml-ok/)
  assert.match(evidence[0], /dsml-ok/)
})
