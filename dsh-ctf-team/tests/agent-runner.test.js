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
