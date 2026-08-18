import { createHash, randomUUID } from 'node:crypto'
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
        child = await adapter.fork(buildExpertPrompt(type, buildTaskPrompt(db, challengeId, prompt)))
        const seenThoughts = new Set<string>()
        dispose = child.onMessage?.((content) => {
          const normalized = normalizeThoughtContent(content)
          if (!normalized) return
          const key = thoughtKey(normalized)
          if (seenThoughts.has(key)) return
          seenThoughts.add(key)
          const thought = { id: randomUUID(), challengeId, source: `agent-${taskId}`, content: normalized, createdAt: Date.now() }
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


function buildTaskPrompt(db: TeamDb, challengeId: string, userPrompt: string): string {
  const partial = db as Partial<TeamDb>
  const challenge = typeof partial.getChallenge === 'function' ? partial.getChallenge(challengeId) : null
  if (!challenge) return userPrompt
  const sharedNote = typeof partial.getSharedNote === 'function' ? partial.getSharedNote(challengeId) : null
  const notes = typeof partial.listNotes === 'function' ? partial.listNotes(challengeId).slice(-8) : []
  const evidence = typeof partial.listEvidence === 'function' ? partial.listEvidence(challengeId).slice(-8) : []
  const challengeDetail = formatChallengeDetail(challenge.description)
  const attachments = challenge.attachmentPaths.length ? challenge.attachmentPaths.map((item) => `- ${item}`).join('\n') : '- （无附件记录）'
  const noteText = sharedNote?.content?.trim() ? sharedNote.content.trim() : '（暂无共享笔记）'
  const recentNotes = notes.length ? notes.map((item) => `- ${item.authorUserId}: ${item.content}`).join('\n') : '（暂无个人笔记）'
  const recentEvidence = evidence.length ? evidence.map((item) => `- [${item.type}] ${item.content}`).join('\n') : '（暂无证据记录）'
  return `你正在 DeepSeek Harness 的 CTF 协作面板中执行一个 Agent 任务。请直接围绕当前题目推进，优先利用题面、附件、已有笔记和证据；需要命令行时输出下面这种 DSML shell 调用，宿主会执行后把结果发回给你继续。\n\n` +
    `DSML shell 调用格式示例：\n<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="shell">\n<｜｜DSML｜｜parameter name="command" string="true">pwd</｜｜DSML｜｜parameter>\n<｜｜DSML｜｜parameter name="description" string="true">查看当前目录</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>\n\n` +
    `## 当前题目\n` +
    `- ID: ${challenge.challengeId}\n` +
    `- 标题: ${challenge.title}\n` +
    `- 分类: ${challenge.category}\n` +
    `- 状态: ${challenge.status}\n\n` +
    `## 题目详情\n${challengeDetail}\n\n` +
    `## 附件 / URL\n${attachments}\n\n` +
    `## 共享笔记\n${noteText}\n\n` +
    `## 最近个人笔记\n${recentNotes}\n\n` +
    `## 最近证据\n${recentEvidence}\n\n` +
    `## 用户任务\n${userPrompt}\n\n` +
    `请输出可复现过程、关键发现和候选 flag；如继续需要工具，请一次给出少量明确命令。`
}



function formatChallengeDetail(description: string): string {
  const raw = description?.trim()
  if (!raw) return '（空）'
  try {
    const parsed = JSON.parse(raw) as any
    const exercise = parsed?.exercise
    if (exercise && typeof exercise === 'object') {
      const lines = [
        `- 平台题名: ${exercise.name ?? '（未知）'}`,
        `- 题面: ${exercise.description ?? '（空）'}`,
        `- 难度: ${exercise.difficulty ?? '（未知）'}`,
        `- 分值: ${exercise.score ?? '（未知）'}`,
        `- 需要初始化环境: ${exercise.isNeedInit ? '是' : '否'}`,
        `- 可刷新环境: ${exercise.canRefreshEndpoint ? '是' : '否'}`,
        `- endpointType: ${exercise.endpointType ?? '（未知）'}`,
      ]
      const endpoints = Array.isArray(exercise.endpoints) && exercise.endpoints.length ? exercise.endpoints.map((item: unknown) => `  - ${typeof item === 'string' ? item : JSON.stringify(item)}`) : ['  - （暂无 endpoint；若需要环境，请先在平台区启动/恢复题目环境）']
      const attachments = Array.isArray(exercise.attachment) && exercise.attachment.length ? exercise.attachment.map((item: unknown) => `  - ${typeof item === 'string' ? item : JSON.stringify(item)}`) : ['  - （暂无平台附件）']
      return `${lines.join('\n')}\n- 平台 endpoints:\n${endpoints.join('\n')}\n- 平台附件:\n${attachments.join('\n')}`
    }
  } catch { /* plain text description */ }
  return raw
}

const THOUGHT_CONTENT_LIMIT = 20_000

function normalizeThoughtContent(content: string): string {
  const trimmed = String(content ?? '').trim()
  if (!trimmed) return ''
  if (trimmed.length <= THOUGHT_CONTENT_LIMIT) return trimmed
  return `${trimmed.slice(0, THOUGHT_CONTENT_LIMIT)}
[thought truncated at ${THOUGHT_CONTENT_LIMIT} chars; full final answer is kept in the task result when applicable]`
}

function thoughtKey(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

async function childDispose(child: SessionForkExecution | undefined): Promise<void> { await child?.dispose?.() }

export type AgentRunner = ReturnType<typeof setupAgentRunner>
