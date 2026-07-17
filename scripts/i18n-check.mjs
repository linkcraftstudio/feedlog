#!/usr/bin/env node
// i18n catalog parity guard (en ⇄ zh key sets); exits non-zero on mismatch.
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SOURCE = 'en'
const localesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'i18n', 'locales')

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out)
    else out[key] = true
  }
  return out
}

const files = readdirSync(localesDir).filter(f => f.endsWith('.json'))
const catalogs = Object.fromEntries(
  files.map(f => [f.replace(/\.json$/, ''), flatten(JSON.parse(readFileSync(join(localesDir, f), 'utf8')))]),
)

const source = catalogs[SOURCE]
if (!source) {
  console.error(`✗ source locale '${SOURCE}.json' not found in ${localesDir}`)
  process.exit(1)
}

const sourceKeys = Object.keys(source)
let failed = false
for (const [code, keys] of Object.entries(catalogs)) {
  if (code === SOURCE) continue
  const missing = sourceKeys.filter(k => !(k in keys))
  const extra = Object.keys(keys).filter(k => !(k in source))
  if (missing.length || extra.length) {
    failed = true
    console.error(`\n✗ ${code}.json out of sync with ${SOURCE}.json:`)
    if (missing.length) console.error(`  missing (${missing.length}): ${missing.join(', ')}`)
    if (extra.length) console.error(`  extra   (${extra.length}): ${extra.join(', ')}`)
  }
}

if (failed) {
  console.error('\ni18n parity check failed.')
  process.exit(1)
}
console.log(`✓ i18n parity OK — ${sourceKeys.length} keys × ${files.length} locales (${Object.keys(catalogs).join(', ')})`)
