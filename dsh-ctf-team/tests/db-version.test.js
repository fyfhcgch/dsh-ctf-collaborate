import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createDb, TEAM_SCHEMA_VERSION } from '../dist/db.js'

test('database schema version is initialized and retained across reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-ctf-team-schema-'))
  const path = join(directory, 'team.db')
  try {
    const first = createDb(path)
    assert.equal(first.schemaVersion, TEAM_SCHEMA_VERSION)
    first.close()
    const second = createDb(path)
    assert.equal(second.schemaVersion, TEAM_SCHEMA_VERSION)
    second.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('unknown database schema versions fail loudly', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-ctf-team-schema-'))
  const path = join(directory, 'team.db')
  try {
    const first = createDb(path)
    first.close()
    const editor = new DatabaseSync(path)
    editor.prepare('UPDATE team_schema SET version=?').run(999)
    editor.close()
    assert.throws(() => createDb(path), /Unsupported team database schema version: 999/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
