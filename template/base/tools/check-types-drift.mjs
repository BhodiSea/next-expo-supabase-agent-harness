#!/usr/bin/env node
// Gate: types-drift — the committed Supabase type mirror matches the LIVE schema.
// Regenerates packages/platform/supabase/src/database.types.ts from the running local
// stack (`supabase gen types`) and diffs it; a mismatch means a migration landed without
// a `pnpm db:types` regen, so the checked-in types describe a schema no database runs.
//
// The stack deliberately does NOT thread this generic into the compile graph
// (packages/platform/supabase/src/types.ts explains why: rows enter the DAL as `unknown`
// and are re-parsed against zod at the exit, so a stale .d.ts can never license skipping
// that parse). The generated file earns its keep HERE instead — as a CI drift assertion.
//
// A LIVE-STACK gate: it SKIPS LOUDLY (exit 0) when no supabase CLI or running stack is
// present — in the main chain and on a laptop alike — because its fail-closed enforcement
// is the CI lane that brings the stack up (never a general run with no database). Once a
// stack IS up, a `gen types` failure or a real drift is a hard red. The committed mirror
// is opt-in (`pnpm db:types` writes it); until it exists there is nothing to diff.
// SOURCE: docs/harness/README.md (types-drift gate: the generated types are the schema
// mirror, so drift means a stale schema view); https://supabase.com/docs/guides/api/rest/generating-types
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { fail, ok, runCmd } from './lib/gate.mjs'

const GATE = 'types-drift'
const COMMITTED = 'packages/platform/supabase/src/database.types.ts'
const GEN = 'supabase gen types typescript --local --schema public'

function skip(reason) {
  console.log(
    `${GATE}: SKIPPED — ${reason} (enforced in the CI supabase lane; a skip is not a pass)`,
  )
  process.exit(0)
}

function available(cmd) {
  try {
    execSync(cmd, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// Skip only when there is genuinely no stack to compare against. Once a stack IS up a
// `gen types` failure is a REAL failure (below), never swallowed as a skip.
if (!available('supabase --version') || !available('supabase status')) {
  skip('no running supabase stack (`pnpm db:up`)')
}

if (!existsSync(COMMITTED)) {
  skip(
    `${COMMITTED} not generated yet — run \`pnpm db:types\` to commit the mirror and enable drift detection`,
  )
}

let generated
try {
  generated = runCmd(GEN)
} catch {
  fail(
    GATE,
    `\`${GEN}\` failed while the stack is up — a migration likely broke type generation. Fix the migration, then \`pnpm db:types\`.`,
  )
}

const norm = (s) => s.replace(/\r\n/g, '\n').trimEnd()
if (norm(generated) !== norm(readFileSync(COMMITTED, 'utf8'))) {
  fail(GATE, `${COMMITTED} is stale vs the live schema. Run \`pnpm db:types\` and commit the diff.`)
}

ok(GATE, `${COMMITTED} matches the live schema`)
