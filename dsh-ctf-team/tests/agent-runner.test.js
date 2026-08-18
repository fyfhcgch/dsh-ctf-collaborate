import assert from 'node:assert/strict'
import test from 'node:test'
import { setupAgentRunner } from '../dist/agent-runner.js'


test('agent runner reserves concurrency slots before asynchronous fork and streams thoughts', async () => {
  const tasks = []
  const thoughts = []
  const events = []
  const resolvers = []
  const db = {
    insertTask(task) { tasks.push(task) },
    insertThought(thought) { thoughts.push(thought) },
  }
  const broadcast = { emit(event) { events.push(event) } }
  let disposed = 0
  const adapter = {
    fork(prompt) {
      return new Promise((resolve) => {
        resolvers.push(() => resolve({
          content: `done:${prompt}`,
          onMessage(listener) {
            listener(`thought:${prompt}`)
            return () => { disposed += 1 }
          },
        }))
      })
    },
  }
  const runner = setupAgentRunner(db, broadcast, adapter, 2)
  const first = runner.spawn('challenge', 'alice', 'one')
  const second = runner.spawn('challenge', 'bob', 'two')
  await assert.rejects(() => runner.spawn('challenge', 'carol', 'three'), /concurrency limit \(2\) reached/)
  assert.equal(tasks.filter((task) => !task.done).length, 2)

  resolvers.shift()()
  const firstResult = await first
  assert.match(firstResult.response, /done:one/)
  assert.equal(thoughts.length, 1)
  assert.equal(thoughts[0].content, 'thought:one')
  assert.equal(events.find((event) => event.type === 'thought_add').payload.taskId, firstResult.taskId)
  assert.equal(disposed, 1)

  resolvers.shift()()
  const secondResult = await second
  assert.match(secondResult.response, /done:two/)
  assert.equal(disposed, 2)
  assert.equal(tasks.filter((task) => task.done).length, 2)
})

test('agent runner releases a slot after fork failure', async () => {
  const db = { insertTask() {}, insertThought() {} }
  const broadcast = { emit() {} }
  let calls = 0
  const runner = setupAgentRunner(db, broadcast, {
    async fork() {
      calls += 1
      if (calls === 1) throw new Error('fork failed')
      return { content: 'recovered' }
    },
  }, 1)
  await assert.rejects(() => runner.spawn('challenge', 'owner', 'first'), /fork failed/)
  const result = await runner.spawn('challenge', 'owner', 'second')
  assert.equal(result.response, 'recovered')
})

test('agent runner injects challenge context into expert prompt', async () => {
  let forkedPrompt = ''
  const tasks = []
  const db = {
    getChallenge(id) { return { challengeId: id, title: 'web-unserialize-1-3', category: 'web', description: 'target: http://example.test/', attachmentPaths: ['src.zip'], status: 'pending', createdAt: 1 } },
    getSharedNote() { return { content: '共享线索', challengeId: 'c', updatedBy: 'u', updatedAt: 1 } },
    listNotes() { return [{ authorUserId: 'alice', content: '个人线索', id: 'n', challengeId: 'c', createdAt: 1 }] },
    listEvidence() { return [{ type: 'tool_output', content: 'curl output', id: 'e', challengeId: 'c', createdAt: 1 }] },
    insertTask(task) { tasks.push(task) },
    insertThought() {},
  }
  const runner = setupAgentRunner(db, { emit() {} }, { async fork(prompt) { forkedPrompt = prompt; return { content: 'ok' } } }, 1)
  await runner.spawn('dasctf-10661', 'alice', '解出flag')
  assert.match(forkedPrompt, /web-unserialize-1-3/)
  assert.match(forkedPrompt, /target: http:\/\/example\.test\//)
  assert.match(forkedPrompt, /src\.zip/)
  assert.match(forkedPrompt, /共享线索/)
  assert.match(forkedPrompt, /解出flag/)
  assert.equal(tasks.at(-1).result, 'ok')
})

test('agent runner deduplicates and truncates noisy thought blocks', async () => {
  const thoughts = []
  const long = 'x'.repeat(20_050)
  const db = { insertTask() {}, insertThought(thought) { thoughts.push(thought) } }
  const runner = setupAgentRunner(db, { emit() {} }, {
    async fork() {
      return {
        content: 'done',
        onMessage(listener) {
          listener(' repeated thought ')
          listener('repeated thought')
          listener(long)
          return () => {}
        },
      }
    },
  }, 1)
  await runner.spawn('challenge', 'owner', 'prompt')
  assert.equal(thoughts.length, 2)
  assert.equal(thoughts[0].content, 'repeated thought')
  assert.notEqual(thoughts[1].content, long)
  assert.equal(thoughts[1].content.startsWith('x'.repeat(20_000)), true)
  assert.match(thoughts[1].content, /thought truncated at 20000 chars/)
})

test('agent runner renders DASCTF exercise JSON into concise task details', async () => {
  let forkedPrompt = ''
  const description = JSON.stringify({ exercise: { name: 'web-unserialize-1-3', description: '听说你是pop大师', difficulty: 'VERY_EASY', score: '50.0', isNeedInit: true, canRefreshEndpoint: false, endpointType: 'monopoly', endpoints: [], attachment: [] } })
  const db = {
    getChallenge(id) { return { challengeId: id, title: 'web-unserialize-1-3', category: 'web', description, attachmentPaths: [], status: 'pending', createdAt: 1 } },
    getSharedNote() { return null },
    listNotes() { return [] },
    listEvidence() { return [] },
    insertTask() {},
    insertThought() {},
  }
  const runner = setupAgentRunner(db, { emit() {} }, { async fork(prompt) { forkedPrompt = prompt; return { content: 'ok' } } }, 1)
  await runner.spawn('dasctf-10661', 'alice', '整理题面和平台状态')
  assert.match(forkedPrompt, /题面: 听说你是pop大师/)
  assert.match(forkedPrompt, /需要初始化环境: 是/)
  assert.match(forkedPrompt, /暂无 endpoint/)
  assert.match(forkedPrompt, /平台环境前置规则/)
})

test('agent runner stops solve tasks before fork when DASCTF endpoint is not initialized', async () => {
  let forkCalled = false
  const tasks = []
  const thoughts = []
  const description = JSON.stringify({ exercise: { id: 10664, name: 'UploadKing', description: '你能得到King的认可吗', isNeedInit: true, endpoints: [], attachment: [], endpointType: 'monopoly' } })
  const db = {
    getChallenge(id) { return { challengeId: id, title: 'UploadKing', category: 'web', description, attachmentPaths: [], status: 'pending', createdAt: 1 } },
    insertTask(task) { tasks.push(task) },
    insertThought(thought) { thoughts.push(thought) },
  }
  const runner = setupAgentRunner(db, { emit() {} }, { async fork() { forkCalled = true; return { content: 'unexpected' } } }, 1)
  const result = await runner.spawn('dasctf-10664', 'alice', '解出web题flag')
  assert.equal(forkCalled, false)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].done, true)
  assert.match(result.response, /题目环境尚未就绪/)
  assert.match(result.response, /exerciseId: 10664/)
  assert.match(thoughts[0].content, /同步当前题 endpoint/)
})

test('agent runner blocks solve tasks while endpoint check is still pending even when an endpoint is present', async () => {
  let forkCalled = false
  const tasks = []
  const thoughts = []
  const description = JSON.stringify({ exercise: {
    id: 10664,
    name: 'UploadKing',
    description: '你能得到King的认可吗',
    isNeedInit: true,
    isNeedCheck: true,
    endpoints: [{ exposeIps: ['1.2.3.4'], ports: ['80'] }],
    attachment: [],
    endpointType: 'monopoly',
  } })
  const db = {
    getChallenge() { return { challengeId: 'dasctf-10664', title: 'UploadKing', category: 'web', description, attachmentPaths: [], status: 'pending', createdAt: 1 } },
    insertTask(task) { tasks.push(task) },
    insertThought(thought) { thoughts.push(thought) },
  }
  const runner = setupAgentRunner(db, { emit() {} }, { async fork() { forkCalled = true; return { content: 'unexpected' } } }, 1)
  const result = await runner.spawn('dasctf-10664', 'alice', '解出web题flag')
  assert.equal(forkCalled, false)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].done, true)
  assert.match(result.response, /环境尚未准备完成/)
  assert.match(thoughts[0].content, /同步当前题 endpoint/)

  // A blocked preflight must not consume the only concurrency slot.
  const readyDescription = JSON.stringify({ exercise: {
    id: 10664,
    name: 'UploadKing',
    description: 'ready',
    isNeedInit: true,
    isNeedCheck: false,
    endpoints: [{ exposeIps: ['1.2.3.4'], ports: ['80'] }],
    attachment: [],
    endpointType: 'monopoly',
  } })
  db.getChallenge = () => ({ challengeId: 'dasctf-10664', title: 'UploadKing', category: 'web', description: readyDescription, attachmentPaths: [], status: 'pending', createdAt: 1 })
  const followUp = await runner.spawn('dasctf-10664', 'alice', '只整理当前 endpoint')
  assert.equal(forkCalled, true)
  assert.equal(followUp.response, 'unexpected')
})
