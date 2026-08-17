/** Browser face for the CTF Team plugin.
 *
 * The Host owns the SQLite store and operation log. This face mounts the
 * Typert contribution, then starts the WebRTC synchronizer only inside a
 * child fiber that explicitly injects the generated `remote.ctfTeam` service.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import type { RemoteResult, TypertDisposer } from '@deepseek-ai/dsh-typert-protocol'
import TYPERT_REMOTE from '../remote.js'
import { TeamP2PController } from './p2p.js'
import type { TeamP2PRemote, TeamOperation } from './p2p.js'
import { TeamBoard } from './board.js'
import type { TeamBoardRemote } from './board.js'

export const inject = ['remote', 'slots']

type TeamIdentity = Awaited<ReturnType<TeamP2PRemote['identity']>>
type TeamChanges = Awaited<ReturnType<TeamP2PRemote['changes']>>
type TeamApplyResult = Awaited<ReturnType<TeamP2PRemote['applyOperations']>>
type TeamSyncStatus = Awaited<ReturnType<TeamP2PRemote['syncStatus']>>
type Challenge = Awaited<ReturnType<TeamBoardRemote['create']>>
type ChallengeDetail = Awaited<ReturnType<TeamBoardRemote['detail']>>
type DeletedChallenge = Awaited<ReturnType<TeamBoardRemote['delete']>>
type TeamNote = Awaited<ReturnType<TeamBoardRemote['addNote']>>
type EvidenceItem = Awaited<ReturnType<TeamBoardRemote['addEvidence']>>
type AgentThought = Awaited<ReturnType<TeamBoardRemote['addThought']>>
type SpawnAgentResult = Awaited<ReturnType<TeamBoardRemote['spawnAgent']>>

interface TeamRemoteWire {
  list(): Promise<RemoteResult<Challenge[]>>
  detail(challengeId: string): Promise<RemoteResult<ChallengeDetail>>
  create(input: Parameters<TeamBoardRemote['create']>[0]): Promise<RemoteResult<Challenge>>
  update(challengeId: string, input: Parameters<TeamBoardRemote['update']>[1]): Promise<RemoteResult<Challenge>>
  delete(challengeId: string): Promise<RemoteResult<DeletedChallenge>>
  addNote(input: Parameters<TeamBoardRemote['addNote']>[0]): Promise<RemoteResult<TeamNote>>
  addEvidence(input: Parameters<TeamBoardRemote['addEvidence']>[0]): Promise<RemoteResult<EvidenceItem>>
  addThought(input: Parameters<TeamBoardRemote['addThought']>[0]): Promise<RemoteResult<AgentThought>>
  spawnAgent(input: Parameters<TeamBoardRemote['spawnAgent']>[0]): Promise<RemoteResult<SpawnAgentResult>>
  identity(): Promise<RemoteResult<TeamIdentity>>
  changes(input?: { afterSequence?: number; limit?: number }): Promise<RemoteResult<TeamChanges>>
  applyOperations(input: { operations: TeamOperation[] }): Promise<RemoteResult<TeamApplyResult>>
  syncStatus(): Promise<RemoteResult<TeamSyncStatus>>
}

function unwrap<T>(operation: string, result: RemoteResult<T>): T {
  if (result.ok) return result.value
  throw new Error(`ctfTeam.${operation} failed: ${result.error.code}: ${result.error.message}`)
}

function adaptRemote(remote: TeamRemoteWire): TeamP2PRemote {
  return {
    async identity() { return unwrap('identity', await remote.identity()) },
    async changes(input) { return unwrap('changes', await remote.changes(input)) },
    async applyOperations(input) { return unwrap('applyOperations', await remote.applyOperations(input)) },
    async syncStatus() { return unwrap('syncStatus', await remote.syncStatus()) },
  }
}

function adaptBoardRemote(remote: TeamRemoteWire): TeamBoardRemote {
  return {
    async list() { return unwrap('list', await remote.list()) },
    async detail(challengeId) { return unwrap('detail', await remote.detail(challengeId)) },
    async create(input) { return unwrap('create', await remote.create(input)) },
    async update(challengeId, input) { return unwrap('update', await remote.update(challengeId, input)) },
    async delete(challengeId) { return unwrap('delete', await remote.delete(challengeId)) },
    async addNote(input) { return unwrap('addNote', await remote.addNote(input)) },
    async addEvidence(input) { return unwrap('addEvidence', await remote.addEvidence(input)) },
    async addThought(input) { return unwrap('addThought', await remote.addThought(input)) },
    async spawnAgent(input) { return unwrap('spawnAgent', await remote.spawnAgent(input)) },
    async identity() { return unwrap('identity', await remote.identity()) },
    async syncStatus() { return unwrap('syncStatus', await remote.syncStatus()) },
  }
}

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const remote = ctx.get('remote') as { $mount(contribution: typeof TYPERT_REMOTE): Promise<TypertDisposer> }
  const disposeRemote = await remote.$mount(TYPERT_REMOTE)

  // The namespace is created by the mount above. Access it only through a
  // nested injection fiber so Cordis can trace and unwind the dependency.
  ctx.inject(['remote.ctfTeam'], (teamCtx) => {
    const wire = (teamCtx as unknown as { remote: { ctfTeam: TeamRemoteWire } }).remote.ctfTeam
    const log = (message: string) => { teamCtx.logger?.warn?.(`dsh-ctf-team: ${message}`) }
    const controller = new TeamP2PController(adaptRemote(wire), log)
    const board = new TeamBoard(adaptBoardRemote(wire), controller, log)
    teamCtx.effect(async () => {
      await controller.ready()
      board.mount()
      const slots = teamCtx as unknown as { slots: { inject: (key: 'sidebar.footer.action', callback: () => () => void) => () => void; register: (options: { name: 'sidebar.footer.action'; id: string; order?: number }, component: (props: { wide: boolean }) => unknown) => () => void } }
      const disposeSidebarAction = slots.slots.inject('sidebar.footer.action', () => {
        const SidebarBoardAction = ({ wide }: { wide: boolean }) => {
          board.setSidebarWide(wide)
          return createElement(
            'button',
            {
              type: 'button',
              className: 'dsh-ctf-team-sidebar-action',
              title: 'Open CTF Team workspace',
              'aria-label': 'Open CTF Team workspace',
              'data-dsh-ctf-team-workspace-button': 'true',
              onClick: () => { board.toggleOpen() },
            },
            wide ? 'CTF Board' : '🏁',
          )
        }
        return slots.slots.register({
          name: 'sidebar.footer.action',
          id: 'dsh-ctf-team-board',
          order: 100,
        }, SidebarBoardAction)
      })
      const target = globalThis as { __DSH_CTF_TEAM_P2P__?: TeamP2PController; __DSH_CTF_TEAM_BOARD__?: TeamBoard }
      target.__DSH_CTF_TEAM_P2P__ = controller
      target.__DSH_CTF_TEAM_BOARD__ = board
      return () => {
        disposeSidebarAction()
        board.dispose()
        controller.dispose()
        if (target.__DSH_CTF_TEAM_P2P__ === controller) delete target.__DSH_CTF_TEAM_P2P__
        if (target.__DSH_CTF_TEAM_BOARD__ === board) delete target.__DSH_CTF_TEAM_BOARD__
      }
    }, 'dsh-ctf-team client board and P2P controller')
  })

  return async () => { await disposeRemote() }
}

export { TYPERT_REMOTE, TeamBoard, TeamP2PController }
