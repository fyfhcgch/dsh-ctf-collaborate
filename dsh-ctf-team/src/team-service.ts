import { randomUUID } from 'node:crypto'
import type { Broadcaster } from './sse-broadcast.js'
import type {
  AgentThought,
  Challenge,
  ChallengeCategory,
  ChallengeStatus,
  EvidenceItem,
  SubTask,
  TeamDb,
  TeamNote,
  SharedNote,
  TeamOperation,
  TeamOperationKind,
} from './types.js'
import { TeamInputError, TeamNotFoundError } from './types.js'
import type { AgentRunner } from './agent-runner.js'

const CATEGORIES = new Set<ChallengeCategory>(['pwn', 'crypto', 'web', 'rev', 'misc', 'forensic'])
const STATUSES = new Set<ChallengeStatus>(['pending', 'solving', 'solved'])
const MAX_TITLE = 200
const MAX_DESCRIPTION = 20_000
const MAX_CONTENT = 100_000
const MAX_PROMPT = 50_000
const MAX_ID = 128

export interface CreateChallengeInput {
  challengeId?: unknown
  title?: unknown
  category?: unknown
  description?: unknown
  attachmentPaths?: unknown
  status?: unknown
  flag?: unknown
}

export interface UpdateChallengeInput {
  title?: unknown
  category?: unknown
  description?: unknown
  attachmentPaths?: unknown
  status?: unknown
  flag?: unknown
}

export interface AddNoteInput { challengeId?: unknown; authorUserId?: unknown; content?: unknown }
export interface UpdateSharedNoteInput { challengeId?: unknown; updatedBy?: unknown; content?: unknown; updatedAt?: unknown }
export interface AddEvidenceInput { challengeId?: unknown; type?: unknown; content?: unknown }
export interface AddThoughtInput { challengeId?: unknown; source?: unknown; content?: unknown }

export type OperationSink = (operation: TeamOperation) => void

export interface ChallengeDetail {
  challenge: Challenge
  sharedNote: SharedNote | null
  notes: TeamNote[]
  thoughts: AgentThought[]
  evidence: EvidenceItem[]
  tasks: SubTask[]
}

/** Shared domain operations used by commands, HTTP, and the future Remote client. */
export class TeamService {
  constructor(
    private readonly db: TeamDb,
    private readonly broadcast: Broadcaster,
    private readonly agentRunner?: AgentRunner,
    private readonly operationSink?: OperationSink,
    private readonly localPeerId = 'local',
  ) {}

  listChallenges(): Challenge[] { return this.db.listChallenges() }

  getDetail(challengeId: unknown): ChallengeDetail {
    const id = requireId(challengeId, 'challengeId')
    const challenge = this.db.getChallenge(id)
    if (!challenge) throw new TeamNotFoundError('Challenge not found')
    return {
      challenge,
      sharedNote: this.db.getSharedNote(id),
      notes: this.db.listNotes(id),
      thoughts: this.db.listThoughts(id),
      evidence: this.db.listEvidence(id),
      tasks: this.db.listTasks(id),
    }
  }

  createChallenge(input: CreateChallengeInput): Challenge {
    const flag = optionalText(input.flag, 'flag', MAX_CONTENT)
    const challenge: Challenge = {
      challengeId: optionalId(input.challengeId) ?? randomUUID(),
      title: requiredText(input.title, 'title', MAX_TITLE),
      category: category(input.category),
      description: optionalText(input.description, 'description', MAX_DESCRIPTION) ?? '',
      attachmentPaths: attachmentPaths(input.attachmentPaths),
      status: status(input.status),
      ...(flag === undefined ? {} : { flag }),
      createdAt: Date.now(),
    }
    if (this.db.getChallenge(challenge.challengeId)) throw new TeamInputError('challengeId already exists', 'conflict')
    this.db.insertChallenge(challenge)
    this.record('challenge_upsert', challenge)
    this.broadcast.emit({ type: 'challenge_update', payload: { challengeId: challenge.challengeId } })
    return challenge
  }

  updateChallenge(challengeId: unknown, input: UpdateChallengeInput): Challenge {
    const id = requireId(challengeId, 'challengeId')
    const current = this.db.getChallenge(id)
    if (!current) throw new TeamNotFoundError('Challenge not found')
    const patch: Partial<Challenge> = {
      ...(input.title === undefined ? {} : { title: requiredText(input.title, 'title', MAX_TITLE) }),
      ...(input.category === undefined ? {} : { category: category(input.category, false) }),
      ...(input.description === undefined ? {} : { description: optionalText(input.description, 'description', MAX_DESCRIPTION) ?? '' }),
      ...(input.attachmentPaths === undefined ? {} : { attachmentPaths: attachmentPaths(input.attachmentPaths) }),
      ...(input.status === undefined ? {} : { status: status(input.status, false) }),
      ...(input.flag === undefined ? {} : { flag: optionalText(input.flag, 'flag', MAX_CONTENT) }),
    }
    if (Object.keys(patch).length === 0) throw new TeamInputError('At least one challenge field is required')
    const updated = { ...current, ...patch }
    this.db.updateChallenge(updated)
    this.record('challenge_upsert', updated)
    this.broadcast.emit({ type: 'challenge_update', payload: { challengeId: id } })
    return updated
  }

  deleteChallenge(challengeId: unknown): void {
    const id = requireId(challengeId, 'challengeId')
    if (!this.db.deleteChallenge(id)) throw new TeamNotFoundError('Challenge not found')
    this.record('challenge_delete', { challengeId: id })
    this.broadcast.emit({ type: 'challenge_update', payload: { challengeId: id, deleted: true } })
  }

  updateSharedNote(input: UpdateSharedNoteInput): SharedNote {
    const challengeId = this.requireChallenge(input.challengeId)
    const note: SharedNote = {
      challengeId,
      content: typeof input.content === 'string' ? input.content.trimEnd() : (() => { throw new TeamInputError('content must be a string') })(),
      updatedBy: boundedActor(input.updatedBy, 'updatedBy'),
      updatedAt: Date.now(),
    }
    if (note.content.length > MAX_CONTENT) throw new TeamInputError(`content exceeds ${MAX_CONTENT} characters`)
    this.db.upsertSharedNote(note)
    this.record('shared_note_upsert', note)
    this.broadcast.emit({ type: 'shared_note_update', payload: { challengeId } })
    return note
  }

  addNote(input: AddNoteInput): TeamNote {
    const challengeId = this.requireChallenge(input.challengeId)
    const note: TeamNote = {
      id: randomUUID(), challengeId, authorUserId: boundedActor(input.authorUserId, 'authorUserId'),
      content: requiredText(input.content, 'content', MAX_CONTENT), createdAt: Date.now(),
    }
    this.db.insertNote(note)
    this.record('note_add', note)
    this.broadcast.emit({ type: 'note_add', payload: { challengeId } })
    return note
  }

  addEvidence(input: AddEvidenceInput): EvidenceItem {
    const challengeId = this.requireChallenge(input.challengeId)
    const evidence: EvidenceItem = {
      id: randomUUID(), challengeId, type: evidenceType(input.type),
      content: requiredText(input.content, 'content', MAX_CONTENT), createdAt: Date.now(),
    }
    this.db.insertEvidence(evidence)
    this.record('evidence_add', evidence)
    this.broadcast.emit({ type: 'evidence_add', payload: { challengeId } })
    return evidence
  }

  addThought(input: AddThoughtInput): AgentThought {
    const challengeId = this.requireChallenge(input.challengeId)
    const thought: AgentThought = {
      id: randomUUID(), challengeId, source: boundedActor(input.source, 'source'),
      content: requiredText(input.content, 'content', MAX_CONTENT), createdAt: Date.now(),
    }
    this.db.insertThought(thought)
    this.record('thought_add', thought)
    this.broadcast.emit({ type: 'thought_add', payload: { challengeId } })
    return thought
  }

  async spawnAgent(challengeId: unknown, ownerUserId: unknown, prompt: unknown): Promise<{ taskId: string; response: string }> {
    const id = this.requireChallenge(challengeId)
    const runner = this.agentRunner
    if (!runner || !runner.available) throw new TeamInputError('Agent tasks are not configured', 'unsupported')
    return runner.spawn(id, boundedActor(ownerUserId, 'ownerUserId'), requiredText(prompt, 'prompt', MAX_PROMPT))
  }

  /** Apply one idempotent operation received from another peer. */
  applyRemoteOperation(operation: TeamOperation): 'applied' | 'ignored' | 'pending' {
    const payload = operation.payload as Record<string, unknown>
    switch (operation.kind) {
      case 'challenge_upsert': {
        const challenge = parseRemoteChallenge(payload)
        const currentVersion = this.db.getVersion('challenge', challenge.challengeId)
        if (currentVersion && compareVersion(operation, currentVersion) <= 0) return 'ignored'
        const current = this.db.getChallenge(challenge.challengeId)
        if (current) this.db.updateChallenge(challenge)
        else this.db.insertChallenge(challenge)
        this.db.setVersion('challenge', challenge.challengeId, operation)
        this.broadcast.emit({ type: 'challenge_update', payload: { challengeId: challenge.challengeId } })
        return 'applied'
      }
      case 'challenge_delete': {
        const challengeId = requireId(payload.challengeId, 'challengeId')
        const currentVersion = this.db.getVersion('challenge', challengeId)
        if (currentVersion && compareVersion(operation, currentVersion) <= 0) return 'ignored'
        this.db.deleteChallenge(challengeId)
        this.db.setVersion('challenge', challengeId, operation)
        this.broadcast.emit({ type: 'challenge_update', payload: { challengeId, deleted: true } })
        return 'applied'
      }
      case 'shared_note_upsert': {
        const note = parseRemoteSharedNote(payload)
        if (!this.db.getChallenge(note.challengeId)) return 'pending'
        const currentVersion = this.db.getVersion('shared_note', note.challengeId)
        if (currentVersion && compareVersion(operation, currentVersion) <= 0) return 'ignored'
        this.db.upsertSharedNote(note)
        this.db.setVersion('shared_note', note.challengeId, operation)
        this.broadcast.emit({ type: 'shared_note_update', payload: { challengeId: note.challengeId } })
        return 'applied'
      }
      case 'note_add': {
        const note = parseRemoteNote(payload)
        if (!this.db.getChallenge(note.challengeId)) return 'pending'
        this.db.insertNote(note)
        this.broadcast.emit({ type: 'note_add', payload: { challengeId: note.challengeId } })
        return 'applied'
      }
      case 'thought_add': {
        const thought = parseRemoteThought(payload)
        if (!this.db.getChallenge(thought.challengeId)) return 'pending'
        this.db.insertThought(thought)
        this.broadcast.emit({ type: 'thought_add', payload: { challengeId: thought.challengeId } })
        return 'applied'
      }
      case 'evidence_add': {
        const evidence = parseRemoteEvidence(payload)
        if (!this.db.getChallenge(evidence.challengeId)) return 'pending'
        this.db.insertEvidence(evidence)
        this.broadcast.emit({ type: 'evidence_add', payload: { challengeId: evidence.challengeId } })
        return 'applied'
      }
      case 'task_upsert': {
        const task = parseRemoteTask(payload)
        if (!this.db.getChallenge(task.challengeId)) return 'pending'
        this.db.insertTask(task)
        this.broadcast.emit({ type: 'task_update', payload: { challengeId: task.challengeId, taskId: task.taskId } })
        return 'applied'
      }
    }
  }

  private record(kind: TeamOperationKind, payload: unknown): void {
    this.operationSink?.({ opId: randomUUID(), peerId: this.localPeerId, kind, payload, createdAt: Date.now() })
  }

  private requireChallenge(value: unknown): string {
    const id = requireId(value, 'challengeId')
    if (!this.db.getChallenge(id)) throw new TeamNotFoundError('Challenge not found')
    return id
  }
}

function requireId(value: unknown, field: string): string {
  const id = requiredText(value, field, MAX_ID)
  if (id.includes('/') || id.includes('\\')) throw new TeamInputError(`${field} contains an invalid path separator`)
  return id
}

function optionalId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return requireId(value, 'challengeId')
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new TeamInputError(`${field} must be a string`)
  const text = value.trim()
  if (!text) throw new TeamInputError(`${field} is required`)
  if (text.length > maxLength) throw new TeamInputError(`${field} exceeds ${maxLength} characters`)
  return text
}

function optionalText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new TeamInputError(`${field} must be a string`)
  const text = value.trim()
  if (text.length > maxLength) throw new TeamInputError(`${field} exceeds ${maxLength} characters`)
  return text || undefined
}

function boundedActor(value: unknown, field: string): string {
  if (value === undefined || value === null || value === '') return 'web-user'
  return requiredText(value, field, 128)
}

function category(value: unknown, defaultValue = true): ChallengeCategory {
  if (value === undefined || value === null || value === '') {
    if (defaultValue) return 'misc'
    throw new TeamInputError('category is invalid')
  }
  if (typeof value !== 'string' || !CATEGORIES.has(value as ChallengeCategory)) throw new TeamInputError('category is invalid')
  return value as ChallengeCategory
}

function status(value: unknown, defaultValue = true): ChallengeStatus {
  if (value === undefined || value === null || value === '') {
    if (defaultValue) return 'pending'
    throw new TeamInputError('status is invalid')
  }
  if (typeof value !== 'string' || !STATUSES.has(value as ChallengeStatus)) throw new TeamInputError('status is invalid')
  return value as ChallengeStatus
}

function attachmentPaths(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > 64) throw new TeamInputError('attachmentPaths must contain at most 64 strings')
  return value.map((item, index) => requiredText(item, `attachmentPaths[${index}]`, 4096))
}

function evidenceType(value: unknown): EvidenceItem['type'] {
  if (value === undefined || value === null || value === '') return 'log'
  if (value === 'tool_output' || value === 'file_extract' || value === 'log') return value
  throw new TeamInputError('type is invalid')
}


function compareVersion(operation: TeamOperation, version: { createdAt: number; opId: string }): number {
  return operation.createdAt - version.createdAt || operation.opId.localeCompare(version.opId)
}

function remoteText(value: unknown, field: string, max = MAX_CONTENT): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TeamInputError(`${field} is invalid`)
  return value
}

function parseRemoteChallenge(value: Record<string, unknown>): Challenge {
  const categoryValue = value.category
  const statusValue = value.status
  if (!CATEGORIES.has(categoryValue as ChallengeCategory)) throw new TeamInputError('category is invalid')
  if (!STATUSES.has(statusValue as ChallengeStatus)) throw new TeamInputError('status is invalid')
  const attachments = value.attachmentPaths
  if (!Array.isArray(attachments) || attachments.some((item) => typeof item !== 'string')) throw new TeamInputError('attachmentPaths is invalid')
  return {
    challengeId: requireId(value.challengeId, 'challengeId'),
    title: remoteText(value.title, 'title', MAX_TITLE),
    category: categoryValue as ChallengeCategory,
    description: typeof value.description === 'string' ? value.description : '',
    attachmentPaths: attachments as string[],
    status: statusValue as ChallengeStatus,
    ...(value.flag === undefined || value.flag === null ? {} : { flag: remoteText(value.flag, 'flag') }),
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now(),
  }
}

function parseRemoteSharedNote(value: Record<string, unknown>): SharedNote {
  const updatedAt = typeof value.updatedAt === 'number' ? value.updatedAt : Date.now()
  return { challengeId: requireId(value.challengeId, 'challengeId'), content: typeof value.content === 'string' ? value.content : '', updatedBy: remoteText(value.updatedBy, 'updatedBy', 128), updatedAt }
}
function parseRemoteNote(value: Record<string, unknown>): TeamNote {
  return { id: requireId(value.id, 'id'), challengeId: requireId(value.challengeId, 'challengeId'), authorUserId: remoteText(value.authorUserId, 'authorUserId', 128), content: remoteText(value.content, 'content'), createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now() }
}
function parseRemoteThought(value: Record<string, unknown>): AgentThought {
  return { id: requireId(value.id, 'id'), challengeId: requireId(value.challengeId, 'challengeId'), source: remoteText(value.source, 'source', 128), content: remoteText(value.content, 'content'), createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now() }
}
function parseRemoteEvidence(value: Record<string, unknown>): EvidenceItem {
  const type = value.type
  if (type !== 'tool_output' && type !== 'file_extract' && type !== 'log') throw new TeamInputError('type is invalid')
  return { id: requireId(value.id, 'id'), challengeId: requireId(value.challengeId, 'challengeId'), type, content: remoteText(value.content, 'content'), createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now() }
}
function parseRemoteTask(value: Record<string, unknown>): SubTask {
  return { taskId: requireId(value.taskId, 'taskId'), challengeId: requireId(value.challengeId, 'challengeId'), ownerUserId: remoteText(value.ownerUserId, 'ownerUserId', 128), prompt: remoteText(value.prompt, 'prompt', MAX_PROMPT), done: Boolean(value.done), result: typeof value.result === 'string' ? value.result : '', createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now() }
}
