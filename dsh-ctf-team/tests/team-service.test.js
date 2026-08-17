import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createDb } from '../dist/db.js'
import { createBroadcast } from '../dist/sse-broadcast.js'
import { TeamService } from '../dist/team-service.js'
import { TeamInputError, TeamNotFoundError } from '../dist/types.js'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-ctf-team-'))
  const db = createDb(join(directory, 'team.db'))
  const broadcast = createBroadcast()
  const events = []
  broadcast.connectClient({ write: (data) => events.push(data), close() {} })
  const service = new TeamService(db, broadcast, { available: false, async spawn() { throw new Error('not expected') } })
  return { directory, db, service, events }
}

test('challenge lifecycle retains board entries and deletes them atomically', () => {
  const f = fixture()
  try {
    const challenge = f.service.createChallenge({ title: '  First blood  ', category: 'web', description: 'find the route' })
    assert.equal(challenge.title, 'First blood')
    assert.equal(Object.hasOwn(challenge, 'flag'), false)
    f.service.addNote({ challengeId: challenge.challengeId, authorUserId: 'alice', content: 'The route redirects.' })
    f.service.addEvidence({ challengeId: challenge.challengeId, type: 'tool_output', content: 'HTTP 302' })
    f.service.addThought({ challengeId: challenge.challengeId, source: 'agent-1', content: 'Check the origin.' })
    assert.equal(f.service.getDetail(challenge.challengeId).notes.length, 1)
    assert.equal(f.service.getDetail(challenge.challengeId).evidence.length, 1)
    assert.equal(f.service.getDetail(challenge.challengeId).thoughts.length, 1)

    const updated = f.service.updateChallenge(challenge.challengeId, { status: 'solving', description: 'updated' })
    assert.equal(updated.status, 'solving')
    f.service.deleteChallenge(challenge.challengeId)
    assert.equal(f.db.getChallenge(challenge.challengeId), null)
    assert.throws(() => f.service.getDetail(challenge.challengeId), TeamNotFoundError)
    assert.equal(f.events.filter((event) => event.includes('challenge_update')).length, 3)
  } finally {
    f.db.close(); rmSync(f.directory, { recursive: true, force: true })
  }
})

test('input validation rejects blank, oversized, and unknown values', async () => {
  const f = fixture()
  try {
    assert.throws(() => f.service.createChallenge({ title: ' ', category: 'web' }), TeamInputError)
    assert.throws(() => f.service.createChallenge({ title: 'x', category: 'unknown' }), TeamInputError)
    const challenge = f.service.createChallenge({ title: 'valid' })
    assert.throws(() => f.service.addNote({ challengeId: challenge.challengeId, content: '' }), TeamInputError)
    assert.throws(() => f.service.updateChallenge(challenge.challengeId, { status: 'unknown' }), TeamInputError)
    assert.throws(() => f.service.addEvidence({ challengeId: 'missing', content: 'x' }), TeamNotFoundError)
    await assert.rejects(() => f.service.spawnAgent(challenge.challengeId, 'owner', 'prompt'), TeamInputError)
  } finally {
    f.db.close(); rmSync(f.directory, { recursive: true, force: true })
  }
})

test('malformed attachment JSON in an existing database degrades to an empty list', () => {
  const f = fixture()
  try {
    f.db.insertChallenge({ challengeId: 'broken', title: 'Broken row', category: 'misc', description: '', attachmentPaths: [], status: 'pending', createdAt: 1 })
    const editor = new DatabaseSync(join(f.directory, 'team.db'))
    editor.prepare('UPDATE challenges SET attachmentPaths=? WHERE challengeId=?').run('{bad json', 'broken')
    editor.close()
    const raw = f.db.getChallenge('broken')
    assert.deepEqual(raw?.attachmentPaths, [])
  } finally {
    f.db.close(); rmSync(f.directory, { recursive: true, force: true })
  }
})
