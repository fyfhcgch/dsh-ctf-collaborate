import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Resolve the external Harness installation used by boot tests. */
export async function loadHarnessBoot() {
  const scope = process.env.DSH_HARNESS_SCOPE
  if (!scope) {
    throw new Error('Set DSH_HARNESS_SCOPE to the directory containing dsh-app-boot before running Harness boot tests')
  }
  const candidates = [
    join(scope, 'dsh-app-boot', 'lib', 'index.js'),
    join(scope, 'lib', 'index.js'),
    join(scope, 'app-boot', 'lib', 'index.js'),
  ]
  for (const entry of candidates) {
    try {
      await access(entry)
      return import(pathToFileURL(entry).href)
    } catch { /* try the next supported Harness layout */ }
  }
  throw new Error(`Cannot find dsh-app-boot under DSH_HARNESS_SCOPE=${scope}`)
}
