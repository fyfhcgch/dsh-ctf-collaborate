import assert from 'node:assert/strict'
import test from 'node:test'
import { LocalTeamStore } from '../dist/client/local-store.js'

test('local P2P store works without a Host HTTP service', async () => {
  const alice = new LocalTeamStore('local-p2p-test')
  const bob = new LocalTeamStore('local-p2p-test-bob')
  const challenge = await alice.create({ title: 'Offline web', category: 'web', description: 'no server' })
  const note = await alice.addNote({ challengeId: challenge.challengeId, authorUserId: 'alice', content: 'inspect headers' })
  const batch = await alice.changes()
  const result = await bob.applyOperations({ operations: batch.operations })

  assert.equal(result.pending.length, 0)
  assert.equal((await bob.list())[0].title, challenge.title)
  assert.equal((await bob.detail(challenge.challengeId)).notes[0].id, note.id)
  assert.equal((await bob.applyOperations({ operations: batch.operations })).accepted.length, 0)
})

test('a fresh local peer can adopt the team id from an invite', async () => {
  const peer = new LocalTeamStore('temporary-team')
  peer.adoptTeam('invited-team')
  assert.equal((await peer.identity()).teamId, 'invited-team')
})
