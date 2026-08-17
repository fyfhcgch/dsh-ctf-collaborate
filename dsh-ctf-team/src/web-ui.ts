import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const assetRoot = join(dirname(fileURLToPath(import.meta.url)), 'web')
const assets = {
  js: readFileSync(join(assetRoot, 'app.js'), 'utf8'),
  css: readFileSync(join(assetRoot, 'app.css'), 'utf8'),
}

/** Render the Vue 3 + Element Plus application shell. Assets are bundled into dist/web. */
export function renderWebUi(mountPath = '/ctf-team'): string {
  const base = mountPath.replace(/\/$/, '') || '/ctf-team'
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="ctf-team-base" content="${escapeAttribute(base)}">
<title>CTF Team</title>
<style>${assets.css}</style>
</head>
<body>
<div id="app"><div style="padding:2rem;font:14px system-ui">正在加载 CTF Team…</div></div>
<script>${assets.js}</script>
</body>
</html>`
}

export function webAsset(name: 'app.js' | 'app.css'): { content: string; contentType: string } {
  return { content: assets[name === 'app.js' ? 'js' : 'css'], contentType: name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' }
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)
}
