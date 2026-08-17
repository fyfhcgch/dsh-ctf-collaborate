import type { TeamBoardRemote, Challenge, ChallengeDetail, TeamNote, AgentThought, EvidenceItem, SubTask, TeamIdentity, SyncStatus } from './board.js'
import type { TeamOperation, TeamOperationKind, TeamP2PRemote } from './p2p.js'

/** A small browser-only store used by the serverless P2P mode.
 *
 * The store is deliberately local-first: every mutation is applied locally,
 * persisted in localStorage, and appended to the same operation log that the
 * WebRTC controller exchanges with other peers. No HTTP/SSE request is made
 * after the user enters this mode.
 */
export class LocalTeamStore implements TeamBoardRemote, TeamP2PRemote {
  private storageKey: string
  private snapshot: LocalSnapshot
  private readonly memoryStorage = new Map<string, string>()

  constructor(teamId = defaultTeamId()) {
    this.storageKey = `dsh-ctf-team:p2p:${encodeURIComponent(teamId)}`
    this.snapshot = this.load(teamId)
  }

  /** Bind a newly-created local store to the Host team before WebRTC starts. */
  setTeamId(teamId: string): void {
    if (!nonEmpty(teamId) || teamId === this.snapshot.identity.teamId) return
    this.storageKey = `dsh-ctf-team:p2p:${encodeURIComponent(teamId)}`
    this.snapshot = this.load(teamId)
  }

  private adoptTeamSafely(teamId: string): void {
    if (this.snapshot.operations.length && teamId !== this.snapshot.identity.teamId) throw new Error('Cannot join another team after local P2P data exists')
    this.setTeamId(teamId)
  }

  async identity(): Promise<TeamIdentity> { return { ...this.snapshot.identity } }
  adoptTeam(teamId: string): void { this.adoptTeamSafely(teamId) }

  async list(): Promise<Challenge[]> {
    return Object.values(this.snapshot.challenges).sort((a, b) => a.createdAt - b.createdAt || a.challengeId.localeCompare(b.challengeId))
  }

  async detail(challengeId: string): Promise<ChallengeDetail> {
    const challenge = this.snapshot.challenges[challengeId]
    if (!challenge) throw new Error('Challenge not found')
    return {
      challenge: clone(challenge),
      notes: this.snapshot.notes.filter((item) => item.challengeId === challengeId).map(clone),
      thoughts: this.snapshot.thoughts.filter((item) => item.challengeId === challengeId).map(clone),
      evidence: this.snapshot.evidence.filter((item) => item.challengeId === challengeId).map(clone),
      tasks: this.snapshot.tasks.filter((item) => item.challengeId === challengeId).map(clone),
      ...(this.snapshot.sharedNotes[challengeId] ? { sharedNote: clone(this.snapshot.sharedNotes[challengeId]) } : {}),
    } as ChallengeDetail
  }

  async create(input: Partial<Challenge>): Promise<Challenge> {
    const challenge: Challenge = {
      challengeId: nonEmpty(input.challengeId) || randomId('challenge'),
      title: required(input.title, 'title'),
      category: validCategory(input.category),
      description: typeof input.description === 'string' ? input.description : '',
      attachmentPaths: Array.isArray(input.attachmentPaths) ? input.attachmentPaths.filter((item): item is string => typeof item === 'string') : [],
      status: validStatus(input.status),
      ...(typeof input.flag === 'string' && input.flag ? { flag: input.flag } : {}),
      createdAt: Date.now(),
    }
    if (this.snapshot.challenges[challenge.challengeId]) throw new Error('challengeId already exists')
    this.appendLocal('challenge_upsert', challenge)
    return clone(challenge)
  }

  async update(challengeId: string, input: Partial<Challenge>): Promise<Challenge> {
    const current = this.snapshot.challenges[challengeId]
    if (!current) throw new Error('Challenge not found')
    const updated: Challenge = {
      ...current,
      ...(input.title === undefined ? {} : { title: required(input.title, 'title') }),
      ...(input.category === undefined ? {} : { category: validCategory(input.category) }),
      ...(input.description === undefined ? {} : { description: String(input.description) }),
      ...(input.attachmentPaths === undefined ? {} : { attachmentPaths: Array.isArray(input.attachmentPaths) ? input.attachmentPaths.filter((item): item is string => typeof item === 'string') : [] }),
      ...(input.status === undefined ? {} : { status: validStatus(input.status) }),
      ...(input.flag === undefined ? {} : { ...(input.flag ? { flag: String(input.flag) } : { flag: undefined }) }),
    }
    this.appendLocal('challenge_upsert', updated)
    return clone(updated)
  }

  async delete(challengeId: string): Promise<{ challengeId: string; deleted: true }> {
    if (!this.snapshot.challenges[challengeId]) throw new Error('Challenge not found')
    this.appendLocal('challenge_delete', { challengeId })
    return { challengeId, deleted: true }
  }

  async addNote(input: { challengeId: string; authorUserId?: string; content: string }): Promise<TeamNote> {
    this.requireChallenge(input.challengeId)
    const note: TeamNote = { id: randomId('note'), challengeId: input.challengeId, authorUserId: nonEmpty(input.authorUserId) || this.snapshot.identity.peerId, content: required(input.content, 'content'), createdAt: Date.now() }
    this.appendLocal('note_add', note)
    return clone(note)
  }

  async addEvidence(input: { challengeId: string; type?: EvidenceItem['type']; content: string }): Promise<EvidenceItem> {
    this.requireChallenge(input.challengeId)
    const evidence: EvidenceItem = { id: randomId('evidence'), challengeId: input.challengeId, type: input.type === 'tool_output' || input.type === 'file_extract' ? input.type : 'log', content: required(input.content, 'content'), createdAt: Date.now() }
    this.appendLocal('evidence_add', evidence)
    return clone(evidence)
  }

  async addThought(input: { challengeId: string; source?: string; content: string }): Promise<AgentThought> {
    this.requireChallenge(input.challengeId)
    const thought: AgentThought = { id: randomId('thought'), challengeId: input.challengeId, source: nonEmpty(input.source) || this.snapshot.identity.peerId, content: required(input.content, 'content'), createdAt: Date.now() }
    this.appendLocal('thought_add', thought)
    return clone(thought)
  }

  async spawnAgent(input: { challengeId: string; ownerUserId?: string; expertType?: 'general' | 'pwn' | 'reverse'; prompt: string }): Promise<{ taskId: string; response: string }> {
    this.requireChallenge(input.challengeId)
    const task: SubTask = { taskId: randomId('task'), challengeId: input.challengeId, ownerUserId: nonEmpty(input.ownerUserId) || this.snapshot.identity.peerId, expertType: input.expertType ?? 'general', prompt: required(input.prompt, 'prompt'), done: true, result: '此任务由无服务器 P2P 模式记录；Agent 执行需要 Harness Host。', createdAt: Date.now() }
    this.appendLocal('task_upsert', task)
    return { taskId: task.taskId, response: task.result }
  }

  async syncStatus(): Promise<SyncStatus> {
    return { teamId: this.snapshot.identity.teamId, peerId: this.snapshot.identity.peerId, operationCursor: this.snapshot.operations.length, operationCount: this.snapshot.operations.length }
  }

  async changes(input: { afterSequence?: number; limit?: number } = {}): Promise<{ nextCursor: number; hasMore: boolean; operations: TeamOperation[] }> {
    const after = Number.isSafeInteger(input.afterSequence) && (input.afterSequence ?? 0) >= 0 ? input.afterSequence ?? 0 : 0
    const limit = Math.max(1, Math.min(1000, Math.floor(input.limit ?? 200)))
    const operations = this.snapshot.operations.filter((item) => (item.sequence ?? 0) > after).slice(0, limit)
    return { nextCursor: operations.length ? operations[operations.length - 1].sequence ?? after : after, hasMore: this.snapshot.operations.some((item) => (item.sequence ?? 0) > (operations.at(-1)?.sequence ?? after)), operations: operations.map(clone) }
  }

  async applyOperations(input: { operations: TeamOperation[] }): Promise<{ accepted: string[]; ignored: string[]; pending: TeamOperation[] }> {
    const accepted: string[] = []
    const ignored: string[] = []
    const pending: TeamOperation[] = []
    const operations = [...(input?.operations ?? [])].sort((a, b) => rootRank(a.kind) - rootRank(b.kind) || a.createdAt - b.createdAt || a.opId.localeCompare(b.opId))
    for (const operation of operations) {
      if (!operation?.opId || this.snapshot.operations.some((item) => item.opId === operation.opId)) { if (operation?.opId) ignored.push(operation.opId); continue }
      if (!this.apply(operation)) { pending.push(operation); continue }
      this.snapshot.operations.push({ ...clone(operation), sequence: this.snapshot.operations.length + 1 })
      accepted.push(operation.opId)
    }
    if (accepted.length) this.persistAndNotify()
    return { accepted, ignored, pending }
  }

  /** Import the current Host state once, then continue without that Host. */
  async importFrom(remote: TeamBoardRemote): Promise<void> {
    if (this.snapshot.operations.length) return
    const identity = await remote.identity()
    if (identity.teamId !== this.snapshot.identity.teamId) this.setTeamId(identity.teamId)
    const challenges = await remote.list()
    for (const challenge of challenges) {
      const detail = await remote.detail(challenge.challengeId)
      this.appendBootstrap('challenge_upsert', challenge, challenge.createdAt)
      for (const note of detail.notes) this.appendBootstrap('note_add', note, note.createdAt)
      for (const thought of detail.thoughts) this.appendBootstrap('thought_add', thought, thought.createdAt)
      for (const evidence of detail.evidence) this.appendBootstrap('evidence_add', evidence, evidence.createdAt)
      for (const task of detail.tasks) this.appendBootstrap('task_upsert', task, task.createdAt)
      const sharedNote = (detail as ChallengeDetail & { sharedNote?: unknown }).sharedNote
      if (sharedNote) this.appendBootstrap('shared_note_upsert', sharedNote, Number((sharedNote as { updatedAt?: unknown }).updatedAt) || Date.now())
    }
    this.persistAndNotify()
  }

  private appendLocal(kind: TeamOperationKind, payload: unknown): void {
    const operation: TeamOperation = { opId: `${this.snapshot.identity.peerId}:${randomId('op')}`, peerId: this.snapshot.identity.peerId, kind, payload: clone(payload), createdAt: Date.now() }
    if (!this.apply(operation)) throw new Error('Cannot apply local operation')
    this.snapshot.operations.push({ ...operation, sequence: this.snapshot.operations.length + 1 })
    this.persistAndNotify()
  }

  private appendBootstrap(kind: TeamOperationKind, payload: unknown, createdAt: number): void {
    const operation: TeamOperation = { opId: `bootstrap:${kind}:${entityId(kind, payload)}`, peerId: this.snapshot.identity.peerId, kind, payload: clone(payload), createdAt: Math.max(1, createdAt) }
    if (this.snapshot.operations.some((item) => item.opId === operation.opId)) return
    this.apply(operation)
    this.snapshot.operations.push({ ...operation, sequence: this.snapshot.operations.length + 1 })
  }

  private apply(operation: TeamOperation): boolean {
    const payload = operation.payload as Record<string, any>
    if (!payload || typeof payload !== 'object') return false
    if (operation.kind === 'challenge_upsert') {
      const id = nonEmpty(payload.challengeId); if (!id) return false
      if (!newer(operation, this.snapshot.versions[id])) return true
      this.snapshot.challenges[id] = clone(payload) as Challenge; this.snapshot.versions[id] = version(operation); return true
    }
    if (operation.kind === 'challenge_delete') {
      const id = nonEmpty(payload.challengeId); if (!id) return false
      if (!newer(operation, this.snapshot.versions[id])) return true
      delete this.snapshot.challenges[id]; this.snapshot.versions[id] = version(operation)
      this.removeChildren(id)
      return true
    }
    const challengeId = nonEmpty(payload.challengeId)
    if (!challengeId || !this.snapshot.challenges[challengeId]) return false
    if (operation.kind === 'shared_note_upsert') {
      const current = this.snapshot.versions[`note:${challengeId}`]
      if (!newer(operation, current)) return true
      this.snapshot.sharedNotes[challengeId] = clone(payload) as any; this.snapshot.versions[`note:${challengeId}`] = version(operation); return true
    }
    if (operation.kind === 'note_add') return this.addOnce(this.snapshot.notes, payload, 'id')
    if (operation.kind === 'thought_add') return this.addOnce(this.snapshot.thoughts, payload, 'id')
    if (operation.kind === 'evidence_add') return this.addOnce(this.snapshot.evidence, payload, 'id')
    if (operation.kind === 'task_upsert') return this.addOnce(this.snapshot.tasks, payload, 'taskId')
    return false
  }

  private addOnce(collection: any[], payload: any, key: string): boolean {
    if (!nonEmpty(payload[key])) return false
    if (!collection.some((item) => item[key] === payload[key])) collection.push(clone(payload))
    return true
  }

  private removeChildren(challengeId: string): void {
    this.snapshot.notes = this.snapshot.notes.filter((item) => item.challengeId !== challengeId)
    this.snapshot.thoughts = this.snapshot.thoughts.filter((item) => item.challengeId !== challengeId)
    this.snapshot.evidence = this.snapshot.evidence.filter((item) => item.challengeId !== challengeId)
    this.snapshot.tasks = this.snapshot.tasks.filter((item) => item.challengeId !== challengeId)
    delete this.snapshot.sharedNotes[challengeId]
  }

  private requireChallenge(challengeId: string): void { if (!this.snapshot.challenges[challengeId]) throw new Error('Challenge not found') }

  private load(teamId: string): LocalSnapshot {
    const saved = this.getStorage()?.getItem(this.storageKey)
    if (saved) { try { const value = JSON.parse(saved) as LocalSnapshot; if (value.identity?.teamId && value.identity.peerId) return normalize(value) } catch { /* reset damaged local state */ } }
    return { identity: { teamId, peerId: randomId('peer'), createdAt: Date.now() }, challenges: {}, sharedNotes: {}, notes: [], thoughts: [], evidence: [], tasks: [], operations: [], versions: {} }
  }

  private persistAndNotify(): void {
    this.getStorage()?.setItem(this.storageKey, JSON.stringify(this.snapshot))
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('dsh-ctf-team:sync', { detail: { source: 'local-p2p' } }))
  }

  private getStorage(): Storage | undefined {
    try { return typeof localStorage === 'undefined' ? undefined : localStorage } catch { return { getItem: (key) => this.memoryStorage.get(key) ?? null, setItem: (key, value) => { this.memoryStorage.set(key, value) }, removeItem: (key) => { this.memoryStorage.delete(key) }, clear: () => this.memoryStorage.clear(), key: () => null, length: this.memoryStorage.size } as Storage }
  }
}

type LocalSnapshot = {
  identity: TeamIdentity
  challenges: Record<string, Challenge>
  sharedNotes: Record<string, any>
  notes: TeamNote[]
  thoughts: AgentThought[]
  evidence: EvidenceItem[]
  tasks: SubTask[]
  operations: Array<TeamOperation & { sequence: number }>
  versions: Record<string, { createdAt: number; opId: string }>
}

function normalize(value: LocalSnapshot): LocalSnapshot {
  return { identity: value.identity, challenges: value.challenges ?? {}, sharedNotes: value.sharedNotes ?? {}, notes: value.notes ?? [], thoughts: value.thoughts ?? [], evidence: value.evidence ?? [], tasks: value.tasks ?? [], operations: value.operations ?? [], versions: value.versions ?? {} }
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
function randomId(prefix: string): string { return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}` }
function defaultTeamId(): string {
  const key = 'dsh-ctf-team:p2p:default-team'
  try {
    const existing = localStorage.getItem(key)
    if (existing) return existing
    const created = randomId('team')
    localStorage.setItem(key, created)
    return created
  } catch { return randomId('team') }
}
function nonEmpty(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined }
function required(value: unknown, field: string): string { const result = nonEmpty(value); if (!result) throw new Error(`${field} is required`); return result }
function validCategory(value: unknown): Challenge['category'] { return value === 'pwn' || value === 'crypto' || value === 'web' || value === 'rev' || value === 'forensic' || value === 'misc' ? value : 'misc' }
function validStatus(value: unknown): Challenge['status'] { return value === 'solving' || value === 'solved' ? value : 'pending' }
function version(operation: TeamOperation): { createdAt: number; opId: string } { return { createdAt: operation.createdAt, opId: operation.opId } }
function newer(operation: TeamOperation, current?: { createdAt: number; opId: string }): boolean { return !current || operation.createdAt > current.createdAt || (operation.createdAt === current.createdAt && operation.opId.localeCompare(current.opId) > 0) }
function rootRank(kind: TeamOperationKind): number { return kind === 'challenge_upsert' || kind === 'challenge_delete' ? 0 : 1 }
function entityId(kind: TeamOperationKind, payload: unknown): string { const value = payload as Record<string, unknown>; return String(value?.challengeId ?? value?.id ?? value?.taskId ?? randomId('entity')) }
