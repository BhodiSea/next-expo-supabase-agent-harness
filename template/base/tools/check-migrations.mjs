#!/usr/bin/env node
// Gate: migrations — migration files are append-only, DML-free, and destructive
// changes are ADR-coupled. Checks (all static; the schema↔migration drift check via
// drizzle-kit runs in CI's db lane where an install exists):
//   1. append-only: no committed migration is modified or deleted in the working tree
//      or (in CI) relative to the PR base
//   2. no DML: INSERT/UPDATE/DELETE in migrations only with an explicit
//      `-- harness-allow-dml: <reason>` marker (reference data is a deliberate act)
//   3. destructive DDL (DROP TABLE/COLUMN, TRUNCATE) requires `-- adr: docs/adr/<file>`
//      pointing at an existing ADR
// SOURCE: docs/harness/README.md (migration discipline) [corpus: drizzle/migrations-append-only]
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fail, failures, inCI, ok, skipOrFail } from './lib/gate.mjs'

const GATE = 'migrations'
const DIR = 'packages/schema/drizzle'

if (!existsSync(DIR)) skipOrFail(GATE, `${DIR} not found (no migrations surface yet)`)
const errs = []

// 1. append-only — a git failure must never silently VACATE this check: an
// unresolvable base ref in CI (shallow clone) previously returned [] and the
// append-only rule passed without ever diffing. execFileSync (no shell), and
// the failure mode is explicit per environment.
function changedAgainst(ref) {
  let out
  try {
    out = execFileSync('git', ['diff', '--name-status', ref, '--', `${DIR}/*.sql`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    const reason = (e.stderr?.toString() ?? e.message).trim().split('\n')[0]
    if (inCI()) {
      fail(
        GATE,
        `git diff against ${ref} failed (${reason}) — the append-only check cannot run. In CI this usually means a shallow checkout: set fetch-depth: 0.`,
      )
    }
    console.log(
      `${GATE}: NOTE — append-only diff skipped locally (${reason}); content rules still run`,
    )
    return []
  }
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'))
    .filter(([status]) => status.startsWith('M') || status.startsWith('D'))
}
const base = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : 'HEAD'
for (const [status, file] of changedAgainst(base)) {
  errs.push(
    `${file}: ${status === 'D' ? 'deleted' : 'modified'} — migrations are append-only; add a NEW migration that transforms the schema forward`,
  )
}

// 2 + 3. content rules over every migration
for (const f of readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()) {
  const text = readFileSync(join(DIR, f), 'utf8')
  const code = text
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
  if (
    /\b(INSERT\s+INTO|UPDATE\s+[a-z"]|DELETE\s+FROM|MERGE\s+INTO|COPY\s+[a-z"][^;]*\bFROM\b)\b/i.test(
      code,
    ) &&
    !/--\s*harness-allow-dml:/.test(text)
  ) {
    errs.push(
      `${DIR}/${f}: contains DML — schema migrations carry structure, not data. If this is deliberate reference data, add \`-- harness-allow-dml: <reason>\`.`,
    )
  }
  if (/\b(DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE)\b/i.test(code)) {
    const m = text.match(/--\s*adr:\s*(\S+)/)
    if (!m) {
      errs.push(
        `${DIR}/${f}: destructive DDL requires an ADR — add \`-- adr: docs/adr/NNNN-<slug>.md\` referencing the decision record`,
      )
    } else if (!existsSync(m[1])) {
      errs.push(`${DIR}/${f}: referenced ADR ${m[1]} does not exist`)
    }
  }
}

failures(GATE, errs)
ok(GATE, 'migrations append-only, DML-free, destructive changes ADR-coupled')
