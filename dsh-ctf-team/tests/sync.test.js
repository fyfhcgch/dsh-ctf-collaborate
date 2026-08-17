import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createDb } from '../dist/db.js'
import { createBroadcast } from '../dist/sse-broadcast.js'
import { TeamService } from '../dist/team-service.js'
import { TeamSyncService } from '../dist/sync-service.js'

function nodeFixture(directory, name) {
  const db = createDb(join(directory, `${name}.db`))
  const broadcast = createBroadcast()
  let sync
  const service = new TeamService(db, broadcast, undefined, (operation) => sync.recordLocal(operation))
  sync = new TeamSyncService({ logger: { debug() {} } }, db, service, 'team-test', join(directory, `${name}.identity.json`))
  return { db, broadcast, service, sync }
}

test('operation log bootstraps a peer and applies idempotent updates', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-ctf-team-sync-'))
  const a = nodeFixture(directory, 'a')
  const b = nodeFixture(directory, 'b')
  try {
    const challenge = a.service.createChallenge({ challengeId: 'web-1', title: 'Header puzzle', category: 'web' })
    const note = a.service.addNote({ challengeId: 'web-1', authorUserId: 'alice', content: 'Inspect headers' })
    const batch = a.sync.getChanges(0, 100)
    const result = b.sync.applyOperations(batch.operations)
    assert.ok(result.accepted.includes(batch.operations.find((op) => op.kind === 'challenge_upsert').opId))
    assert.equal(result.pending.length, 0)
    assert.equal(b.service.getDetail('web-1').challenge.title, challenge.title)
    assert.equal(b.service.getDetail('web-1').notes[0].content, note.content)

    const duplicate = b.sync.applyOperations(batch.operations)
    assert.equal(duplicate.accepted.length, 0)
    assert.equal(duplicate.pending.length, 0)
    assert.equal(b.sync.getChanges(0, 100).operations.length, batch.operations.length)
  } finally {
    a.broadcast.close(); b.broadcast.close(); a.db.close(); b.db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('legacy rows are backfilled into the operation log on sync service startup', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-ctf-team-sync-'))
  const db = createDb(join(directory, 'legacy.db'))
  const broadcast = createBroadcast()
  db.insertChallenge({ challengeId: 'legacy', title: 'Legacy', category: 'misc', description: '', attachmentPaths: [], status: 'pending', createdAt: 1 })
  const service = new TeamService(db, broadcast)
  const sync = new TeamSyncService({ logger: { debug() {} } }, db, service, 'team-test', join(directory, 'legacy.identity.json'))
  try {
    const operations = sync.getChanges(0, 100).operations
    assert.ok(operations.some((operation) => operation.kind === 'challenge_upsert'))
    assert.equal(operations.find((operation) => operation.kind === 'challenge_upsert').payload.challengeId, 'legacy')
  } finally {
    broadcast.close(); db.close(); rmSync(directory, { recursive: true, force: true })
  }
})
