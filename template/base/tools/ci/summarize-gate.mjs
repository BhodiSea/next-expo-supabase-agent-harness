#!/usr/bin/env node
// The ONE check an enterprise can mark required.
//
// quality-gate.yml runs thirteen jobs and several are path-filtered, so a branch
// protection rule has to either list every job by name — a list that silently goes stale
// the day a job is added or renamed — or mark none of them. Neither is a control. This
// script is the fan-in: a `gate-summary` job with `needs:` over every other job and
// `if: always()`, delegating its verdict here so the verdict is TESTABLE rather than a
// YAML expression nobody can run.
//
// Three rules, and the third is the whole point:
//   1. any need that FAILED or was CANCELLED  -> exit 1, naming it;
//   2. an EMPTY needs context                 -> exit 1 (a summary over nothing is not a
//      pass, and an empty context is what a broken `needs:` list produces);
//   3. a SKIPPED path-filtered lane           -> recorded BY NAME, exit 0.
//
// Rule 3 is where this kind of check usually goes wrong. `if: always()` makes a skipped
// need indistinguishable from a passed one in a naive `contains(needs.*.result, ...)`
// expression, which recreates the silent-skip problem INSIDE the check a reviewer trusts
// most. A skip is legitimate here — the native lane genuinely should not run on a
// docs-only PR — but it must be VISIBLE, so every skipped lane is printed and written to
// the step summary. The reviewer reading a green gate-summary can see exactly which lanes
// did not run.
//
// Input: the needs context as JSON, from $NEEDS_JSON or argv[2].
//   { "<job-id>": { "result": "success" | "failure" | "cancelled" | "skipped", ... }, … }
// SOURCE: docs/harness/README.md (a skip is never a pass) [corpus: harness/doctrine]
import process from 'node:process'

const RAW = process.env.NEEDS_JSON ?? process.argv[2] ?? ''

/** @param {string} line */
const say = (line) => {
  console.log(line)
}

let needs
try {
  needs = JSON.parse(RAW)
} catch (e) {
  console.error(
    `gate-summary: FAIL — the needs context is not valid JSON (${e.message}). Pass it as NEEDS_JSON=\${{ toJSON(needs) }}. A summary that cannot read its inputs must never report success.`,
  )
  process.exit(1)
}

if (needs === null || typeof needs !== 'object' || Array.isArray(needs)) {
  console.error(
    `gate-summary: FAIL — the needs context is ${Array.isArray(needs) ? 'an array' : String(needs)}, not an object of job results. A summary that cannot read its inputs must never report success.`,
  )
  process.exit(1)
}

const entries = Object.entries(needs)
if (entries.length === 0) {
  console.error(
    'gate-summary: FAIL — the needs context is EMPTY. This job exists to fan in every other job in the workflow, so an empty context means the `needs:` list is broken or was emptied — and a summary over nothing is not a pass. Restore `needs:` to name every job.',
  )
  process.exit(1)
}

const by = (want) => entries.filter(([, v]) => v?.result === want).map(([id]) => id)
const failed = by('failure')
const cancelled = by('cancelled')
const skipped = by('skipped')
const succeeded = by('success')
// Anything the runner reports that is none of the four above (a future result string, a
// malformed entry) is treated as NOT a pass — the same fail-closed rule the gates use.
const unknown = entries
  .filter(([, v]) => !['success', 'failure', 'cancelled', 'skipped'].includes(v?.result))
  .map(([id, v]) => `${id} (result: ${JSON.stringify(v?.result)})`)

say(
  `gate-summary: ${String(entries.length)} lane(s) — ${String(succeeded.length)} succeeded, ${String(failed.length)} failed, ${String(cancelled.length)} cancelled, ${String(skipped.length)} skipped`,
)

// A skip is never a pass: name every lane that did not run, on the green path too.
if (skipped.length > 0) {
  say('')
  say('SKIPPED (did NOT run — path filter or an upstream condition):')
  for (const id of skipped.sort()) say(`  - ${id}`)
}

const problems = []
for (const id of failed.sort()) problems.push(`${id}: FAILED`)
for (const id of cancelled.sort())
  problems.push(`${id}: CANCELLED (a cancelled lane proved nothing)`)
for (const u of unknown.sort()) problems.push(`${u}: unrecognized result — treated as not-a-pass`)

if (problems.length > 0) {
  console.error('')
  console.error(`gate-summary: FAIL (${String(problems.length)})`)
  for (const p of problems) console.error(`  - ${p}`)
  console.error('')
  console.error(
    'This is the fan-in job: it is red because a lane it covers is red. Open that lane, not this one.',
  )
  process.exit(1)
}

say('')
say(
  'gate-summary: OK — every lane that ran passed, and every lane that did not run is named above.',
)
