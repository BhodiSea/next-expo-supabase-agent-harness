#!/usr/bin/env node
// Gate: prompts — every LLM prompt is a versioned, hash-locked artifact.
// tools/prompts.lock.json maps prompt path → sha256. A changed prompt without a
// lock update (and a version bump in its filename) silently changes model behavior
// with no eval trail; an unlocked prompt file is an unversioned production input.
// The lock file itself is write-guard-protected: updating it is a deliberate act.
// SOURCE: docs/harness/README.md (prompt versioning) [corpus: llamacpp/json-schema]
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { walkFiles } from './lib/fs-walk.mjs'
import { fail, failures, ok } from './lib/gate.mjs'

const GATE = 'prompts'
const LOCK = 'tools/prompts.lock.json'

let lock = {}
if (existsSync(LOCK)) {
  try {
    lock = JSON.parse(readFileSync(LOCK, 'utf8'))
  } catch (e) {
    fail(GATE, `${LOCK} is not valid JSON: ${e.message}`)
  }
}

// Discover prompt files: packages/*/prompts/** and apps/*/prompts/**. Lock keys
// are POSIX paths by contract — the shared walker's output already is.
const promptFiles = []
for (const scope of ['packages', 'apps']) {
  if (!existsSync(scope)) continue
  for (const pkg of readdirSync(scope)) {
    const root = `${scope}/${pkg}/prompts`
    promptFiles.push(...walkFiles(root).map((rel) => `${root}/${rel}`))
  }
}

const errs = []
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

for (const f of promptFiles) {
  if (!(f in lock)) {
    errs.push(`${f} is not in ${LOCK} — every prompt must be hash-locked (add it deliberately)`)
    continue
  }
  const actual = sha256(f)
  if (actual !== lock[f]) {
    errs.push(
      `${f} hash mismatch — the prompt changed without a lock update. Version the change (new .vN file), re-run the eval, then update the lock.`,
    )
  }
  if (!/\.v\d+\.[a-z]+$/.test(f)) {
    errs.push(`${f} must carry an explicit version in its filename (e.g. extract.v1.md)`)
  }
}
for (const locked of Object.keys(lock)) {
  if (!existsSync(locked)) errs.push(`${LOCK} references missing file ${locked}`)
}

failures(GATE, errs)
ok(GATE, `${promptFiles.length} prompt(s) hash-locked and versioned`)
