import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setupApi } from '../dist/api.js'
import { createDb } from '../dist/db.js'
import { createBroadcast } from '../dist/sse-broadcast.js'
import { TeamService } from '../dist/team-service.js'

class FakeResponse {
  statusCode = 200
  value = undefined
  status(code) { this.statusCode = code; return this }
  json(value) { this.value = value }
  setHeader() {}
  write() {}
  end() {}
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-ctf-team-api-'))
  const db = createDb(join(directory, 'team.db'))
  const broadcast = createBroadcast()
  const service = new TeamService(db, broadcast, { available: false, async spawn() { throw new Error('not expected') } })
  const gets = new Map()
  const posts = new Map()
  const server = {
    get(path, handler) { gets.set(path, handler) },
    post(path, handler) { posts.set(path, handler) },
    static() {},
  }
  const ctx = { get(name) { return name === 'http' ? { server } : undefined }, logger: { warn() {} } }
  assert.equal(setupApi(ctx, '/ctf-team/', broadcast, service), true)
  return { directory, db, gets, posts }
}

async function invoke(handler, { body, params = {} } = {}) {
  const response = new FakeResponse()
  await handler({ body, params }, response)
  return response
}

test('HTTP bridge routes share service validation and status mapping', async () => {
  const f = fixture()
  try {
    assert.ok(f.gets.has('/ctf-team/api/challenges'))
    assert.ok(f.posts.has('/ctf-team/api/challenges/:cid/update'))
    assert.ok(f.posts.has('/ctf-team/api/challenges/:cid/delete'))

    const invalid = await invoke(f.posts.get('/ctf-team/api/challenges'), { body: { title: '' } })
    assert.equal(invalid.statusCode, 400)

    const created = await invoke(f.posts.get('/ctf-team/api/challenges'), { body: { title: 'API challenge', category: 'pwn' } })
    assert.equal(created.statusCode, 200)
    const challengeId = created.value.challenge.challengeId

    const updated = await invoke(f.posts.get('/ctf-team/api/challenges/:cid/update'), { params: { cid: challengeId }, body: { status: 'solving' } })
    assert.equal(updated.value.challenge.status, 'solving')

    const missingNote = await invoke(f.posts.get('/ctf-team/api/notes'), { body: { challengeId: 'missing', content: 'x' } })
    assert.equal(missingNote.statusCode, 404)

    const unsupportedAgent = await invoke(f.posts.get('/ctf-team/api/agent/spawn'), { body: { challengeId, prompt: 'inspect' } })
    assert.equal(unsupportedAgent.statusCode, 501)

    const deleted = await invoke(f.posts.get('/ctf-team/api/challenges/:cid/delete'), { params: { cid: challengeId } })
    assert.deepEqual(deleted.value, { ok: true })
    const missing = await invoke(f.gets.get('/ctf-team/api/challenges/:cid'), { params: { cid: challengeId } })
    assert.equal(missing.statusCode, 404)
  } finally {
    f.db.close(); rmSync(f.directory, { recursive: true, force: true })
  }
})
