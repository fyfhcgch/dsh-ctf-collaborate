import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Resolve the external Harness installation used by boot tests. */
export async function loadHarnessBoot() {
  const scope = process.env.DSH_HARNESS_SCOPE
  if (!scope) {
    throw new Error('Set DSH_HARNESS_SCOPE to the directory containing dsh-app-boot before running Harness boot tests')
  }
  const entry = join(scope, 'dsh-app-boot', 'lib', 'index.js')
  await access(entry)
  return import(pathToFileURL(entry).href)
}
