/**
 * Host Typert artifact for the CTF Team Remote service.
 *
 * The generated Host gateway consumes this manifest to bind the descriptors
 * from `./remote` to the live TeamRemoteService registered by `apply()`.
 * Keeping the wire codecs in one module makes the Host and Client faces use
 * exactly the same boundary contract.
 */
import TYPERT_REMOTE from './remote.js'

const methods = [
  'list',
  'detail',
  'create',
  'update',
  'delete',
  'addNote',
  'addEvidence',
  'addThought',
  'spawnAgent',
  'identity',
  'changes',
  'applyOperations',
  'syncStatus',
] as const

const service = {
  key: 'ctfTeam',
  exportName: 'TeamRemoteService',
  tags: [],
  members: methods.map((name) => ({
    kind: 'method' as const,
    name,
    signature: `\`${name}\`(...args: unknown[]): unknown`,
  })),
  types: [],
}

export const TYPERT = {
  package: 'dsh-ctf-team',
  face: 'host' as const,
  schemas: [],
  invocations: TYPERT_REMOTE.descriptors,
  model: {
    services: [service],
    events: [],
    objects: [],
  },
}

export default TYPERT
