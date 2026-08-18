import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DASCTFPlatform, normalizeDASCTFFlag, redactSecrets, validateAccessKey, validateGatewayEndpoint, validateServerHost } from '../dist/dasctf-platform.js'
import { createDb } from '../dist/db.js'
import { createBroadcast } from '../dist/sse-broadcast.js'
import { TeamService } from '../dist/team-service.js'

const config = (overrides = {}) => ({
  competitionId: '1625', stageId: '3071', platformHost: 'https://pro.dasctf.com', accessKeyEnv: 'DASCTF_TEST_ACCESS_KEY',
  gatewayEndpoint: 'https://api.deepseek.com/v1/chat/completions', teamId: 'test-team',
  eventStartAt: '2020-01-01T00:00:00Z', eventEndAt: '2999-01-01T00:00:00Z', maxSubmissions: 50, leaseTtlMs: 120000, ...overrides,
})

function fixture(fetchImpl) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-ctf-team-platform-'))
  const db = createDb(join(directory, 'team.db'))
  const service = new TeamService(db, createBroadcast())
  const old = process.env.DASCTF_TEST_ACCESS_KEY
  process.env.DASCTF_TEST_ACCESS_KEY = 'ak_test_1234567890'
  return { directory, db, service, platform: new DASCTFPlatform(db, config(), fetchImpl), restore() { if (old === undefined) delete process.env.DASCTF_TEST_ACCESS_KEY; else process.env.DASCTF_TEST_ACCESS_KEY = old } }
}

function response(data, code = '00000') { return { ok: true, status: 200, async json() { return { code, message: '', data } } } }

test('manual full URL allowlist and flag normalization are strict', () => {
  assert.equal(validateGatewayEndpoint('https://api.deepseek.com/v1/chat/completions'), 'https://api.deepseek.com/v1/chat/completions')
  assert.throws(() => validateGatewayEndpoint('https://api.deepseek.com/v1'), /full URL allowlist/)
  assert.throws(() => validateGatewayEndpoint('https://api.deepseek.com/v1/chat/completions?x=1'), /full URL allowlist/)
  assert.equal(normalizeDASCTFFlag('DASCTF{hello-1}'), 'hello-1')
  assert.equal(normalizeDASCTFFlag('flag{hello-1}'), 'hello-1')
  assert.throws(() => normalizeDASCTFFlag('hello-1'), /DASCTF/)
  assert.deepEqual(redactSecrets({ accessKey: 'secret', endpoint: 'ak_live_123', nested: { password: 'pw' } }), { accessKey: '[REDACTED]', endpoint: '[REDACTED]', nested: { password: '[REDACTED]' } })
})



test('runtime platform configuration validates host, AccessKey, and keeps credentials in memory only', async () => {
  assert.equal(validateServerHost('https://pro.dasctf.com'), 'https://pro.dasctf.com')
  assert.throws(() => validateServerHost('http://pro.dasctf.com'), /HTTPS origin/)
  assert.throws(() => validateServerHost('https://user:pass@pro.dasctf.com'), /HTTPS origin/)
  assert.throws(() => validateServerHost('https://pro.dasctf.com/path'), /HTTPS origin/)
  assert.equal(validateAccessKey('ak_live_1234567890'), 'ak_live_1234567890')
  assert.throws(() => validateAccessKey('bad-key'), /AccessKey/)

  const calls = []
  const f = fixture(async (url) => {
    calls.push(String(url))
    const path = new URL(url).pathname
    if (path.endsWith('/exercise-list')) return response([])
    if (path.endsWith('/overview')) return response({ stagePoint: 1, stageRank: 2 })
    if (path.endsWith('/match-info')) return response({})
    if (path.endsWith('/now-list')) return response([])
    return response({})
  })
  try {
    const status = f.platform.configure({ serverHost: 'https://platform.example', accessKey: 'ak_live_runtime_1234567890', gatewayEndpoint: 'https://api.deepseek.com/v1/chat/completions' })
    assert.equal(status.accessKeyConfigured, true)
    assert.equal(status.platformHost, 'https://platform.example')
    assert.equal(status.gatewayEndpointAllowed, true)
    assert.equal(f.db.listPlatformAudit(100).some((item) => JSON.stringify(item.detail).includes('ak_live_runtime_1234567890')), false)
    const sync = await f.platform.sync(f.service)
    assert.equal(sync.syncedChallenges, 0)
    assert.equal(calls.every((url) => url.startsWith('https://platform.example/')), true)
    const cleared = f.platform.clearRuntimeAccessKey()
    assert.equal(cleared.accessKeyConfigured, false)
  } finally { f.db.close(); f.restore(); rmSync(f.directory, { recursive: true, force: true }) }
})

test('read-only sync imports safe challenge metadata and never stores secrets', async () => {
  const calls = []
  const f = fixture(async (url, init) => {
    calls.push({ url: String(url), init })
    const path = new URL(url).pathname
    if (path.endsWith('/match-info')) return response({ note: 'rules', rule: 'audit' })
    if (path.endsWith('/now-list')) return response([{ id: 1, title: 'notice' }])
    if (path.endsWith('/exercise-list')) return response([{ name: 'Web', corpus: [{ id: 1001, name: 'UploadKing', isOpen: true, hasSolved: false }] }])
    if (path.endsWith('/overview')) return response({ stagePoint: 0, stageRank: 522 })
    return response({ id: 1001, name: 'UploadKing', description: 'safe', hasSolved: false, attachment: { files: [{ url: 'https://files.example/a.zip' }] }, endpoints: [{ users: [{ username: 'root', password: 'secret' }] }] })
  })
  try {
    const result = await f.platform.sync(f.service)
    assert.equal(result.syncedChallenges, 1)
    const challenge = f.service.listChallenges()[0]
    assert.equal(challenge.challengeId, 'dasctf-1001')
    assert.match(challenge.description, /REDACTED/)
    assert.doesNotMatch(challenge.description, /secret/)
    assert.equal(calls.every(({ init }) => !String(init.headers['X-Agent-AccessKey']).includes('REDACTED')), true)
    assert.equal(f.db.listPlatformAudit(100).some((item) => JSON.stringify(item.detail).includes('ak_test_1234567890')), false)
  } finally { f.db.close(); f.restore(); rmSync(f.directory, { recursive: true, force: true }) }
})

test('submission requires confirmation, strips wrapper, and enforces local attempt limit', async () => {
  const bodies = []
  const f = fixture(async (url, init) => { bodies.push(JSON.parse(init.body)); return response({ isCorrect: true }) })
  try {
    await assert.rejects(() => f.platform.submit(1001, 'DASCTF{one}', true, 'NO'), /human confirmation/)
    const result = await f.platform.submit(1001, 'flag{one}', true, 'SUBMIT')
    assert.deepEqual(result, { accepted: true, exerciseId: 1001, attemptsUsed: 1 })
    assert.deepEqual(bodies, [{ exerciseId: 1001, flag: 'one' }])
    const limited = new DASCTFPlatform(f.db, config({ maxSubmissions: 1 }), async () => response({ isCorrect: false }))
    await assert.rejects(() => limited.submit(1001, 'flag{two}', true, 'SUBMIT'), /submission limit reached/)
  } finally { f.db.close(); f.restore(); rmSync(f.directory, { recursive: true, force: true }) }
})

test('environment lifecycle is explicit and restricted to documented API paths', async () => {
  const calls = []
  const f = fixture(async (url, init) => { calls.push({ path: new URL(url).pathname, body: JSON.parse(init.body) }); return response({ accepted: true }) })
  try {
    await assert.rejects(() => f.platform.buildExerciseEnv(1001, true, 'NO'), /human confirmation/)
    await f.platform.buildExerciseEnv(1001, true, 'CONFIRM')
    await f.platform.recoverExerciseEnv(1001, true, 'CONFIRM')
    assert.deepEqual(calls.map((item) => item.path), ['/slab-match/api/v1/agent/ctf/build-exercise-env', '/slab-match/api/v1/agent/ctf/recover-exercise-env'])
    assert.deepEqual(calls.map((item) => item.body), [{ exerciseId: 1001 }, { exerciseId: 1001 }])
  } finally { f.db.close(); f.restore(); rmSync(f.directory, { recursive: true, force: true }) }
})


test('platform capability APIs work with AccessKey only while flag submission keeps gateway audit gate', async () => {
  const f = fixture(async (url, init) => {
    const path = new URL(url).pathname
    if (path.endsWith('/match-info')) return response({})
    if (path.endsWith('/now-list')) return response([])
    if (path.endsWith('/exercise-list')) return response([])
    if (path.endsWith('/overview')) return response({ stagePoint: 0, stageRank: 0 })
    return response({ ok: true })
  })
  try {
    const platform = new DASCTFPlatform(f.db, config({ gatewayEndpoint: '' }), f.platform.fetchImpl)
    const sync = await platform.sync(f.service)
    assert.equal(sync.exercises, 0)
    await platform.buildExerciseEnv(1001, true, 'CONFIRM')
    await platform.recoverExerciseEnv(1001, true, 'CONFIRM')
    await assert.rejects(() => platform.submit(1001, 'DASCTF{one}', true, 'SUBMIT'), /gatewayEndpoint/)
  } finally { f.db.close(); f.restore(); rmSync(f.directory, { recursive: true, force: true }) }
})


test('single exercise sync refreshes endpoint readiness after async environment start', async () => {
  const f = fixture(async (url) => {
    const path = new URL(url).pathname
    if (path.endsWith('/ctf/exercise')) return response({ id: 1001, name: 'UploadKing', description: 'safe', hasSolved: false, isNeedInit: true, isNeedCheck: false, endpointType: 'monopoly', attachment: [], endpoints: [{ exposeIps: ['10.0.0.10'], ports: ['80'], users: [{ username: 'root', password: 'secret' }] }] })
    return response({ ok: true })
  })
  try {
    f.service.createChallenge({ challengeId: 'dasctf-1001', title: 'UploadKing', category: 'web', description: JSON.stringify({ noticeInfo: { note: 'rules' }, exercise: { id: 1001, name: 'UploadKing', isNeedInit: true, isNeedCheck: true, endpoints: [] } }), attachmentPaths: [], status: 'pending' })
    const result = await f.platform.syncExercise(f.service, 1001)
    assert.deepEqual(result, { exerciseId: 1001, challengeId: 'dasctf-1001', endpoints: 1, isNeedCheck: false, synced: true })
    const challenge = f.service.listChallenges().find((item) => item.challengeId === 'dasctf-1001')
    assert.match(challenge.description, /monopoly/)
    assert.match(challenge.description, /REDACTED/)
    assert.doesNotMatch(challenge.description, /secret/)
  } finally { f.db.close(); f.restore(); rmSync(f.directory, { recursive: true, force: true }) }
})

test('stale local pid leases are cleared on harness restart', async () => {
  const f = fixture(async (url) => {
    const path = new URL(url).pathname
    if (path.endsWith('/match-info')) return response({})
    if (path.endsWith('/now-list')) return response([])
    if (path.endsWith('/exercise-list')) return response([])
    if (path.endsWith('/overview')) return response({ stagePoint: 0, stageRank: 0 })
    return response({})
  })
  try {
    f.db.acquireAgentLease({ scope: 'dasctf', ownerId: 'test-team:999999999', acquiredAt: Date.now(), expiresAt: Date.now() + 120000 })
    const sync = await f.platform.sync(f.service)
    assert.equal(sync.syncedChallenges, 0)
    assert.equal(f.db.getAgentLease('dasctf').ownerId.includes(String(process.pid)), true)
  } finally { f.db.close(); f.restore(); rmSync(f.directory, { recursive: true, force: true }) }
})
