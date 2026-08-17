import { randomUUID } from 'node:crypto'
import type { Broadcaster } from './sse-broadcast.js'
import type { TeamDb, TeamOperationKind } from './types.js'
import type { SessionForkAdapter, SessionForkExecution } from './host-adapter.js'
import { buildExpertPrompt, normalizeExpertType, type ExpertType } from './experts/index.js'

export type AgentMutationSink = (kind: TeamOperationKind, payload: unknown) => void

export function setupAgentRunner(db: TeamDb, broadcast: Broadcaster, adapter: SessionForkAdapter | undefined, concurrentLimit: number, mutationSink?: AgentMutationSink) {
  let running = 0
  return {
    available: adapter !== undefined,
    async spawn(challengeId: string, ownerUserId: string, prompt: string, expertType: ExpertType = 'general') {
      if (!adapter) throw new Error('This Harness profile has no ctfTeamSessionFork adapter. Configure a trusted session-fork adapter before enabling agent tasks.')
      if (running >= concurrentLimit) throw new Error(`Agent concurrency limit (${concurrentLimit}) reached`)
      running += 1
      const taskId = randomUUID()
      const type = normalizeExpertType(expertType)
      const task = { taskId, challengeId, ownerUserId, expertType: type, prompt, done: false, result: '', createdAt: Date.now() }
      db.insertTask(task); mutationSink?.('task_upsert', task); broadcast.emit({ type: 'task_update', payload: { challengeId, taskId } })
      let dispose: (() => void) | undefined
      let child: SessionForkExecution | undefined
      try {
        child = await adapter.fork(buildExpertPrompt(type, prompt))
        dispose = child.onMessage?.((content) => {
          const thought = { id: randomUUID(), challengeId, source: `agent-${taskId}`, content, createdAt: Date.now() }
          db.insertThought(thought); mutationSink?.('thought_add', thought)
          broadcast.emit({ type: 'thought_add', payload: { challengeId, taskId } })
        })
        const completed = { ...task, done: true, result: await child.content }
        db.insertTask(completed); mutationSink?.('task_upsert', completed)
        broadcast.emit({ type: 'task_update', payload: { challengeId, taskId } })
        return { taskId, response: completed.result }
      } catch (error) {
        const failed = { ...task, done: true, result: `Failed: ${error instanceof Error ? error.message : String(error)}` }
        db.insertTask(failed); mutationSink?.('task_upsert', failed)
        broadcast.emit({ type: 'task_update', payload: { challengeId, taskId } })
        throw error
      } finally { dispose?.(); await childDispose(child); running -= 1 }
    },
  }
}

async function childDispose(child: SessionForkExecution | undefined): Promise<void> { await child?.dispose?.() }

export type AgentRunner = ReturnType<typeof setupAgentRunner>
