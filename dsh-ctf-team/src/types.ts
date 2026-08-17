export type ChallengeCategory = 'pwn' | 'crypto' | 'web' | 'rev' | 'misc' | 'forensic'
export type ChallengeStatus = 'pending' | 'solving' | 'solved'

export interface Challenge {
  challengeId: string
  title: string
  category: ChallengeCategory
  description: string
  attachmentPaths: string[]
  status: ChallengeStatus
  flag?: string
  createdAt: number
}
export interface TeamNote { id: string; challengeId: string; authorUserId: string; content: string; createdAt: number }
export interface AgentThought { id: string; challengeId: string; source: string; content: string; createdAt: number }
export interface EvidenceItem { id: string; challengeId: string; type: 'tool_output' | 'file_extract' | 'log'; content: string; createdAt: number }
export interface SubTask { taskId: string; challengeId: string; ownerUserId: string; prompt: string; done: boolean; result: string; createdAt: number }
export type BroadcastEventType = 'challenge_update' | 'note_add' | 'thought_add' | 'evidence_add' | 'task_update'
export interface BroadcastEvent<T> { type: BroadcastEventType; payload: T }

export class TeamInputError extends Error {
  constructor(message: string, readonly kind: 'invalid' | 'conflict' | 'unsupported' = 'invalid') {
    super(message)
    this.name = 'TeamInputError'
  }
}

export class TeamNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TeamNotFoundError'
  }
}

export interface TeamDb {
  close(): void
  readonly schemaVersion?: number
  insertChallenge(item: Challenge): void
  updateChallenge(item: Challenge): void
  deleteChallenge(id: string): boolean
  listChallenges(): Challenge[]
  getChallenge(id: string): Challenge | null
  insertNote(item: TeamNote): void
  listNotes(challengeId: string): TeamNote[]
  insertThought(item: AgentThought): void
  listThoughts(challengeId: string): AgentThought[]
  insertEvidence(item: EvidenceItem): void
  listEvidence(challengeId: string): EvidenceItem[]
  insertTask(item: SubTask): void
  listTasks(challengeId: string): SubTask[]
  appendOperation(operation: TeamOperation): number
  hasOperation(opId: string): boolean
  listOperations(afterSequence: number, limit: number): SyncBatch
  getVersion(scope: string, entityId: string): TeamVersion | null
  setVersion(scope: string, entityId: string, version: TeamVersion): void
}

export type TeamOperationKind =
  | 'challenge_upsert'
  | 'challenge_delete'
  | 'note_add'
  | 'thought_add'
  | 'evidence_add'
  | 'task_upsert'

export interface TeamOperation {
  opId: string
  peerId: string
  kind: TeamOperationKind
  payload: unknown
  createdAt: number
}

export interface StoredTeamOperation extends TeamOperation {
  sequence: number
}

export interface SyncBatch {
  nextCursor: number
  hasMore: boolean
  operations: StoredTeamOperation[]
}

export interface TeamVersion {
  createdAt: number
  opId: string
}

export interface TeamIdentity {
  teamId: string
  peerId: string
  createdAt: number
}
