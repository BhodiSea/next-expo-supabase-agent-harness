#!/usr/bin/env node
// Shared placeholder-residue scanner: fail LOUD on any unrendered
// {{PLACEHOLDER}} left in a rendered scaffold. One implementation for every
// consumer — the installer lifecycle tests, the selftest bootstrap lane, and
// the module render lane — so the residue definition can never fork.
//   usage: node scripts/check-residue.mjs <scaffold-dir>
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { walkFiles } from '../installer/lib/fs-walk.mjs'

const root = process.argv[2]
if (!root) {
  console.error('usage: check-residue.mjs <scaffold-dir>')
  process.exit(1)
}
const dir = resolve(root)
// A gate that scans nothing is a false green — a missing scaffold must fail
// loudly (walkFiles yields [] for an unreadable root).
if (!existsSync(dir)) {
  console.error(`RESIDUE: FAIL — directory not found: ${dir}`)
  process.exit(1)
}

const BINARY = /\.(png|jpe?g|gif|webp|ico|icns|bmp|woff2?|ttf|otf|eot|pdf|zip|gz|tar|exe|dll|so|dylib|gguf|node|lock)$/i
const PLACEHOLDER = /\{\{[A-Z0-9_]+\}\}/g

const hits = []
for (const rel of walkFiles(dir, { excludeDirs: ['node_modules', '.git', 'target', 'dist'] })) {
  if (BINARY.test(rel)) continue
  // The manifest records raw template metadata (answers include the
  // placeholder names by design).
  if (rel.endsWith('.harness/manifest.json')) continue
  const text = readFileSync(join(dir, rel), 'utf8')
  for (const m of text.matchAll(PLACEHOLDER)) {
    hits.push(`${rel}: ${m[0]}`)
  }
}

if (hits.length > 0) {
  console.error(`RESIDUE: ${hits.length} unrendered placeholder(s):`)
  for (const h of hits) console.error(`  ${h}`)
  process.exit(1)
}
console.log('RESIDUE: CLEAN')
