import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { TYPERT_REMOTE } from '../dist/remote.js'

const challenge = {
  challengeId: 'web-1',
  title: 'Header puzzle',
  category: 'web',
  description: 'Inspect the response.',
  attachmentPaths: [],
  status: 'pending',
  createdAt: 1,
}

test('Remote contribution exposes the complete validated endpoint surface', () => {
  assert.equal(TYPERT_REMOTE.package, 'dsh-ctf-team')
  assert.deepEqual(
    TYPERT_REMOTE.descriptors.map((descriptor) => descriptor.method),
    ['list', 'detail', 'create', 'update', 'delete', 'addNote', 'addEvidence', 'addThought', 'spawnAgent', 'identity', 'changes', 'applyOperations', 'syncStatus'],
  )
  assert.ok(TYPERT_REMOTE.descriptors.every((descriptor) => descriptor.id.startsWith('dsh-ctf-team#ctfTeam/')))

  const list = TYPERT_REMOTE.descriptors.find((descriptor) => descriptor.method === 'list')
  assert.deepEqual(list.result.schema.parse([challenge]), [challenge])
  assert.throws(() => list.result.schema.parse([{ ...challenge, status: 'broken' }]))

  const create = TYPERT_REMOTE.descriptors.find((descriptor) => descriptor.method === 'create')
  assert.deepEqual(create.parameters[0].codec.schema.parse({ title: 'x', category: 'misc' }), { title: 'x', category: 'misc' })
  assert.throws(() => create.parameters[0].codec.schema.parse({ title: 1 }))
})

test('built Client face registers a module-loader handoff', () => {
  const bundle = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')
  assert.match(bundle, /data-dsh-ctf-team-workspace-button/)
  assert.doesNotMatch(bundle, /ctf-launcher/)
  const handoffs = []
  const window = { __ModuleLoader__: { load(handoff) { handoffs.push(handoff) } } }
  vm.runInNewContext(bundle, { window })
  assert.equal(handoffs.length, 1)
  assert.equal(handoffs[0].id, 'dsh-ctf-team')
  const exports = handoffs[0].factory(() => { throw new Error('unexpected external require') })
  assert.deepEqual(Object.keys(exports).sort(), ['TYPERT_REMOTE', 'TeamBoard', 'TeamP2PController', 'apply', 'inject'])
  assert.deepEqual([...exports.inject], ['remote', 'slots'])
})

test('Host Typert artifact publishes the Remote descriptors for gateway discovery', async () => {
  const { TYPERT } = await import('../dist/typert.host.js')
  assert.equal(TYPERT.package, 'dsh-ctf-team')
  assert.equal(TYPERT.face, 'host')
  assert.deepEqual(TYPERT.schemas, [])
  assert.equal(TYPERT.invocations.length, TYPERT_REMOTE.descriptors.length)
  assert.deepEqual(
    TYPERT.invocations.map((descriptor) => descriptor.id),
    TYPERT_REMOTE.descriptors.map((descriptor) => descriptor.id),
  )
  assert.deepEqual(TYPERT.model.services.map((service) => service.key), ['ctfTeam'])
})
