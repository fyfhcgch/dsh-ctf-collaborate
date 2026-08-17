import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AddEvidenceInput,
  AddNoteInput,
  AddThoughtInput,
  ChallengeDetail,
  CreateChallengeInput,
  TeamService,
  UpdateChallengeInput,
} from './team-service.js'
import type { Challenge, EvidenceItem, TeamNote, AgentThought } from './types.js'
import type { TeamSyncService } from './sync-service.js'
import type { SyncBatch, TeamIdentity, TeamOperation } from './types.js'

/** Host service exposed through the Harness Typert gateway. */
export class TeamRemoteService extends TypertRemoteService {
  static inject = []

  constructor(ctx: Context, private readonly team: TeamService, private readonly sync: TeamSyncService) {
    super(ctx, 'ctfTeam')
  }

  @Remote('list')
  list(): Challenge[] { return this.team.listChallenges() }

  @Remote('detail')
  detail(challengeId: string): ChallengeDetail { return this.team.getDetail(challengeId) }

  @Remote('create')
  create(input: CreateChallengeInput): Challenge { return this.team.createChallenge(input) }

  @Remote('update')
  update(challengeId: string, input: UpdateChallengeInput): Challenge { return this.team.updateChallenge(challengeId, input) }

  @Remote('delete')
  delete(challengeId: string): { challengeId: string; deleted: true } {
    this.team.deleteChallenge(challengeId)
    return { challengeId, deleted: true }
  }

  @Remote('addNote')
  addNote(input: AddNoteInput): TeamNote { return this.team.addNote(input) }

  @Remote('addEvidence')
  addEvidence(input: AddEvidenceInput): EvidenceItem { return this.team.addEvidence(input) }

  @Remote('addThought')
  addThought(input: AddThoughtInput): AgentThought { return this.team.addThought(input) }

  @Remote('spawnAgent')
  spawnAgent(input: { challengeId: string; ownerUserId?: string; expertType?: 'general' | 'pwn' | 'reverse'; prompt: string }): Promise<{ taskId: string; response: string }> {
    return this.team.spawnAgent(input.challengeId, input.ownerUserId, input.prompt, input.expertType)
  }

  @Remote('identity')
  identity(): TeamIdentity { return this.sync.getIdentity() }

  @Remote('changes')
  changes(input?: { afterSequence?: number; limit?: number }): SyncBatch {
    return this.sync.getChanges(input?.afterSequence ?? 0, input?.limit ?? 200)
  }

  @Remote('applyOperations')
  applyOperations(input: { operations: TeamOperation[] }): ReturnType<TeamSyncService['applyOperations']> {
    return this.sync.applyOperations(input?.operations)
  }

  @Remote('syncStatus')
  syncStatus() { return this.sync.status() }
}

export default TeamRemoteService
