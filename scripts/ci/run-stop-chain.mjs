#!/usr/bin/env node
// THE DERIVED CANARY BASELINE: run the Stop chain's union on a clean scaffold, minus a
// reviewed, printed, staleness-checked exclusion set.
//
// WHAT THIS REPLACES. The selftest canary job opened with sixteen hand-typed gate
// invocations ("Baseline — every canaried gate PASSES on the clean scaffold"). A
// hand-typed list can drift from the chain it claims to prove — a step added to the union
// never joins the baseline, a renamed one rots in it — which is the exact shape that let
// duplication redden on a fresh scaffold in 0.6.0. So the list is DERIVED: this runner
// asks the scaffold's own `node tools/validate.mjs --stop-chain --list` for the
// floor∪config union (computed by the SAME lib the Stop hook imports — one
// implementation, no second opinion) and executes every member.
//
// EXCLUSIONS ARE REVIEWED DATA, NEVER A SILENT DROP. scripts/ci/stop-chain-exclusions.json
// lists the members THIS job cannot run, each with a written reason and a `provenBy`
// string that must still appear in .github/workflows/selftest.yml — the job that DOES run
// the excluded step for real. A stale entry (a step no longer in the union, or a provenBy
// whose step title was renamed away) reds the whole run before anything executes, and
// every exclusion is PRINTED as `SKIP (declared)` so the log always says what did NOT run.
//
// THE CHILD ENV IS THE CONTRACT the Stop hook establishes for its steps: CI=true
// (fail-closed, never skip-green), GITHUB_BASE_REF scrubbed (the scaffold is a DIFFERENT
// git repo — leaking the harness PR's base ref makes diff-based gates fail closed on a
// correct tree), HARNESS_ALLOW_SELF_EDIT scrubbed (gate-integrity consults it; the
// baseline must check what CI checks), and a synthetic HARNESS_SESSION_ID/
// HARNESS_PROMPT_ID so reviewer-verdicts EXECUTES with owed=[] on the clean scaffold — a
// real code path, not a skip.
//   usage: node scripts/ci/run-stop-chain.mjs <scaffoldDir> [--exclusions <json>] [--selftest <yml>]
// SOURCE: .github/workflows/selftest.yml (canary job) · tests/gates/run-stop-chain.test.mjs
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Parse `validate --stop-chain --list` output (`<name>  <cmd>`, two spaces — the format
 * validate.mjs prints) into step tuples. Throws on a line that does not parse and on an
 * EMPTY list: a baseline derived from nothing is decoration, not a baseline.
 * @param {string} text
 * @returns {[string, string][]}
 */
export function parseStepList(text) {
  /** @type {[string, string][]} */
  const steps = []
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim() === '') continue
    const at = line.indexOf('  ')
    if (at <= 0) {
      throw new Error(
        `run-stop-chain: unparseable \`validate --stop-chain --list\` line: ${JSON.stringify(line)}`,
      )
    }
    steps.push([line.slice(0, at), line.slice(at + 2)])
  }
  if (steps.length === 0) {
    throw new Error(
      'run-stop-chain: `validate --stop-chain --list` printed no steps — refusing a vacuous baseline',
    )
  }
  return steps
}

/**
 * Subtract the reviewed exclusions from the union, validating every entry:
 *   - `step` must name a CURRENT union member (a stale exclusion is a problem — a skip
 *     may not outlive its subject), exactly once;
 *   - `reason` must be written down (a skip without a reason is a silent drop);
 *   - `provenBy` must be a string still present in the selftest workflow text — the same
 *     staleness technique the canary registry's selftest-kind proofs use.
 * Pure over its inputs so the red-proof drives it without a scaffold.
 * @param {string[][]} union
 * @param {{ step?: string, reason?: string, provenBy?: string }[]} exclusions
 * @param {string} selftestText
 * @returns {{ run: string[][], skipped: object[], problems: string[] }}
 */
export function subtractExclusions(union, exclusions, selftestText) {
  const problems = []
  const skipped = []
  const names = new Set(union.map(([n]) => n))
  const seen = new Set()
  for (const [i, e] of (exclusions ?? []).entries()) {
    if (typeof e?.step !== 'string' || e.step.trim() === '') {
      problems.push(`exclusion #${String(i + 1)}: no \`step\` name — an anonymous skip cannot be reviewed`)
      continue
    }
    if (seen.has(e.step)) {
      problems.push(`${e.step}: excluded twice — one reviewed entry per step`)
      continue
    }
    seen.add(e.step)
    if (!names.has(e.step)) {
      problems.push(
        `${e.step}: STALE exclusion — no such step in the floor∪config union any more; delete the entry (a skip may not outlive its subject)`,
      )
    }
    if (typeof e.reason !== 'string' || e.reason.trim() === '') {
      problems.push(`${e.step}: no written reason — a skip without one is a silent drop`)
    }
    if (typeof e.provenBy !== 'string' || e.provenBy.trim() === '') {
      problems.push(
        `${e.step}: no provenBy — every exclusion must name the selftest step that DOES run this member for real`,
      )
    } else if (!selftestText.includes(e.provenBy)) {
      problems.push(
        `${e.step}: provenBy ${JSON.stringify(e.provenBy)} not found in the selftest workflow — the step that supposedly runs this member has moved or was renamed (stale cross-reference)`,
      )
    }
    if (names.has(e.step)) skipped.push(e)
  }
  return { run: union.filter(([n]) => !seen.has(n)), skipped, problems }
}

/** The Stop-step env contract (see the header). */
function childEnv() {
  /** @type {Record<string, string | undefined>} */
  const env = {
    ...process.env,
    CI: 'true',
    HARNESS_SESSION_ID: 'selftest-stop-chain',
    HARNESS_PROMPT_ID: 'selftest-stop-chain-baseline',
  }
  delete env.GITHUB_BASE_REF
  delete env.HARNESS_ALLOW_SELF_EDIT
  return env
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  let scaffold
  let exclusionsPath = fileURLToPath(new URL('./stop-chain-exclusions.json', import.meta.url))
  let selftestPath = fileURLToPath(new URL('../../.github/workflows/selftest.yml', import.meta.url))
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--exclusions') exclusionsPath = args[(i += 1)]
    else if (args[i] === '--selftest') selftestPath = args[(i += 1)]
    else scaffold = args[i]
  }
  if (scaffold === undefined) {
    console.error('usage: run-stop-chain.mjs <scaffoldDir> [--exclusions <json>] [--selftest <yml>]')
    process.exit(2)
  }

  const env = childEnv()
  const list = spawnSync(process.execPath, ['tools/validate.mjs', '--stop-chain', '--list'], {
    cwd: scaffold,
    encoding: 'utf8',
    env,
  })
  if (list.status !== 0) {
    console.error(
      `run-stop-chain: \`validate --stop-chain --list\` failed in ${scaffold} — it fails closed on a missing/corrupt floor, and so does this baseline:\n${list.stdout ?? ''}${list.stderr ?? ''}`,
    )
    process.exit(1)
  }
  const union = parseStepList(list.stdout)
  const exclusions = JSON.parse(readFileSync(exclusionsPath, 'utf8')).exclusions
  const { run, skipped, problems } = subtractExclusions(
    union,
    exclusions,
    readFileSync(selftestPath, 'utf8'),
  )
  if (problems.length > 0) {
    console.error(`run-stop-chain: ${String(problems.length)} exclusion problem(s) — nothing was run:`)
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
  for (const e of skipped) {
    console.log(`SKIP (declared): ${e.step} — ${e.reason} [proven by: ${JSON.stringify(e.provenBy)}]`)
  }
  for (const [name, cmd] of run) {
    console.log(`\n=== ${name}: ${cmd}`)
    const r = spawnSync(cmd, { cwd: scaffold, env, shell: true, stdio: 'inherit' })
    if (r.status !== 0) {
      console.error(
        `run-stop-chain: step '${name}' FAILED (${cmd}) — the derived baseline is red on a clean scaffold`,
      )
      process.exit(1)
    }
  }
  console.log(
    `\nrun-stop-chain: ${String(run.length)} step(s) green (${run.map(([n]) => n).join(', ')}); ${String(skipped.length)} skipped with declared reasons`,
  )
}
