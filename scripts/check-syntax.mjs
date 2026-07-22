#!/usr/bin/env node
// Syntax-check every shipped JS module (installer + scripts + template),
// including .tmpl-suffixed files (checked via a temp copy), and validate all
// shipped JSON. With a directory argument it scans THAT whole tree instead —
// the module render lane points it at a fully-rendered scaffold.
//   usage: node scripts/check-syntax.mjs [rendered-dir]
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { walkFiles } from '../installer/lib/fs-walk.mjs'

// fileURLToPath, not URL.pathname (which yields /D:/… on Windows)
const ARG_DIR = process.argv[2] ? resolve(process.argv[2]) : null
const ROOT = ARG_DIR ?? fileURLToPath(new URL('..', import.meta.url))
const failures = []
const tmp = mkdtempSync(join(tmpdir(), 'nsah-syntax-'))
let jsCount = 0
let jsonCount = 0

function walk(dir) {
  for (const rel of walkFiles(dir, { excludeDirs: ['node_modules', '.git'] })) {
    const entry = rel.split('/').at(-1)
    const p = join(dir, rel)
    if (/\.(mjs|js)(\.tmpl)?$/.test(entry)) {
      let target = p
      if (entry.endsWith('.tmpl')) {
        target = join(tmp, `${jsCount}-${entry.replace(/\.tmpl$/, '')}`)
        copyFileSync(p, target)
      }
      try {
        execFileSync('node', ['--check', target], { stdio: 'pipe' })
        jsCount += 1
      } catch (err) {
        failures.push(`${p}: ${String(err.stderr ?? err.message).split('\n')[0]}`)
      }
    } else if (/\.json(\.tmpl)?$/.test(entry) && !/^tsconfig.*\.json$/.test(entry)) {
      // tsconfig*.json is JSONC by convention (TypeScript strips comments/commas)
      try {
        JSON.parse(readFileSync(p, 'utf8'))
        jsonCount += 1
      } catch (err) {
        failures.push(`${p}: invalid JSON — ${err.message}`)
      }
    }
  }
}

if (ARG_DIR) {
  // A gate that scans nothing is a false green — a missing scan target must
  // fail loudly (walkFiles yields [] for an unreadable root).
  if (!existsSync(ROOT)) {
    console.error(`SYNTAX: FAIL — directory not found: ${ROOT}`)
    process.exit(1)
  }
  walk(ROOT)
} else {
  for (const dir of ['installer', 'scripts', 'template', 'tests']) {
    if (existsSync(join(ROOT, dir))) walk(join(ROOT, dir))
  }
}

if (failures.length) {
  console.error(`SYNTAX: FAIL (${failures.length})`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`SYNTAX: CLEAN (${jsCount} js modules, ${jsonCount} json files)`)
