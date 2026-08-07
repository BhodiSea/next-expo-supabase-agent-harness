#!/usr/bin/env node
// Gate runner (`pnpm validate`). Executes VALIDATE_STEPS from tools/harness.config.mjs
// sequentially, prints a per-step summary, and exits non-zero on the first failure — the
// Stop hook and CI both call this, so "done" means the same thing everywhere.
// --min-floor (CI): use the FROZEN snapshot in tools/validate.floor.json as the canonical
//   step list so the canonical steps always run with their canonical commands even if the
//   config file was edited; config-only extra steps run after the floor. The snapshot is a
//   verbatim copy of VALIDATE_STEPS (harness repo: `node scripts/generate-floor.mjs
//   --write`; a selftest asserts equality) — CI trusts THIS file, never the local config,
//   and FAILS CLOSED if it is missing or corrupt (a validate that cannot read its floor
//   must not silently fall back to a weakened config).
// --report-all (Stop hook): run EVERY step instead of stopping at the first failure, so
//   an agent sees all reds at once — with ~31 gates and a per-turn block budget, serial
//   one-red-per-turn discovery would exhaust the budget before the chain is green.
// --list: print the resolved steps without running them.
// SOURCE: docs/harness/README.md (the Stop gate defines done; CI floor) [corpus: harness/doctrine]
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import process from 'node:process'
import { VALIDATE_STEPS } from './harness.config.mjs'

// --report-all ONLY (the Stop-hook path): read-only gates that touch nothing another
// gate writes and so may share a CPU. Anything NOT in this set — including any
// consumer-added custom step — runs EXCLUSIVE (serial, streamed) exactly as today, so
// an unknown step is never assumed safe. perf-budget is deliberately excluded: it
// measures wall-clock render time, and CPU contention from a pool would flake it red.
// SOURCE: docs/harness/gates-catalog.md (validate — report-all pool) [corpus: harness/doctrine]
const PARALLEL_SAFE = new Set([
  'provenance',
  'expo-policy',
  'native-deps',
  'version-sync',
  'prompts',
  'licenses',
  'schema-rls',
  'tenancy',
  'migrations',
  'contracts',
  'styleguide',
  'route-manifest',
  'docs-sync',
])

// Steps sharing a resource key never overlap inside a batch: provenance and migrations
// both shell out to git, which serializes on .git/index.lock — running them at once
// would race that lock. A step with no key has no mutex (pool size is its only limit).
const STEP_RESOURCES = new Map([
  ['provenance', 'git'],
  ['migrations', 'git'],
])

const flags = new Set(process.argv.slice(2))

// The non-negotiable floor lives OUTSIDE this runner, in the sibling snapshot
// tools/validate.floor.json — resolved relative to THIS script (validate.mjs runs from the
// scaffold root, but the snapshot travels with the runner). ALL default steps are floored;
// shape-awareness (e.g. "no schema surface yet") lives INSIDE each gate script as a loud
// SKIP that fails closed in CI when the surface exists — never in floor membership.
const FLOOR_URL = new URL('./validate.floor.json', import.meta.url)
const FLOOR_HINT =
  'regenerate with `node scripts/generate-floor.mjs --write` (harness repo) or restore it from git'

// Read the frozen floor, FAILING CLOSED on any absence/corruption: a missing or malformed
// snapshot must abort the run, never degrade to the (possibly weakened) local config.
function loadFloor() {
  let raw
  try {
    raw = readFileSync(FLOOR_URL, 'utf8')
  } catch (err) {
    console.error(
      `validate --min-floor: cannot read tools/validate.floor.json (${err.message}) — FAILING CLOSED; ${FLOOR_HINT}`,
    )
    process.exit(1)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.error(
      `validate --min-floor: tools/validate.floor.json is not valid JSON (${err.message}) — FAILING CLOSED; ${FLOOR_HINT}`,
    )
    process.exit(1)
  }
  const steps = parsed?.steps
  const wellFormed =
    Array.isArray(steps) &&
    steps.length > 0 &&
    steps.every(
      (s) =>
        Array.isArray(s) && s.length === 2 && typeof s[0] === 'string' && typeof s[1] === 'string',
    )
  if (!wellFormed) {
    console.error(
      `validate --min-floor: tools/validate.floor.json has no well-formed \`steps\` array — FAILING CLOSED; ${FLOOR_HINT}`,
    )
    process.exit(1)
  }
  return steps
}

function resolveSteps() {
  if (!flags.has('--min-floor')) return VALIDATE_STEPS
  const floor = loadFloor()
  const floorNames = new Set(floor.map(([name]) => name))
  const extras = VALIDATE_STEPS.filter(([name]) => !floorNames.has(name))
  return [...floor, ...extras]
}

const steps = resolveSteps()

if (flags.has('--list')) {
  for (const [name, cmd] of steps) console.log(`${name}  ${cmd}`)
  process.exit(0)
}

const reportAll = flags.has('--report-all')
const results = []
const t0All = performance.now()

// Serial + streamed (stdio inherit), exactly like the default chain: header, run,
// record [name, ok, ms]. Used for the default mode, every exclusive step, and any
// lone PARALLEL_SAFE step (a batch of one has nothing to overlap).
function runSerial([name, cmd]) {
  console.log(`\n=== ${name}: ${cmd}`)
  const t0 = performance.now()
  const ok = spawnSync(cmd, { shell: true, stdio: 'inherit' }).status === 0
  results.push([name, ok, Math.round(performance.now() - t0)])
}

// One child under the report-all pool: stdout+stderr captured (so the canonical-order
// flush owns the terminal) and elapsed ms measured around it.
function runChild(cmd) {
  const t0 = performance.now()
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true })
    let text = ''
    child.stdout.on('data', (d) => {
      text += d
    })
    child.stderr.on('data', (d) => {
      text += d
    })
    child.on('error', (err) => {
      text += `${err.message}\n`
      resolve({ ok: false, ms: Math.round(performance.now() - t0), text })
    })
    child.on('close', (code) => {
      resolve({ ok: code === 0, ms: Math.round(performance.now() - t0), text })
    })
  })
}

// Run a batch of consecutive PARALLEL_SAFE steps concurrently, honoring the pool size
// and the resource mutex; returns captured results keyed by global step index. Output
// is buffered, never streamed — the caller flushes it in canonical order.
function runBatch(batch, poolSize) {
  const busy = new Set() // resource keys of currently-running steps
  const out = new Map() // globalIndex -> { name, ok, ms, text }
  let active = 0
  const blocked = (s) => STEP_RESOURCES.has(s.name) && busy.has(STEP_RESOURCES.get(s.name))
  return new Promise((resolveAll) => {
    const pump = () => {
      while (active < poolSize) {
        // First not-yet-started step whose resource (if any) is free. Scanning in
        // order keeps a resource-blocked step from starving a later launchable one.
        const step = batch.find((s) => !s.started && !blocked(s))
        if (step === undefined) break
        step.started = true
        const res = STEP_RESOURCES.get(step.name)
        if (res !== undefined) busy.add(res)
        active += 1
        runChild(step.cmd).then(({ ok, ms, text }) => {
          out.set(step.i, { name: step.name, ok, ms, text })
          if (res !== undefined) busy.delete(res)
          active -= 1
          pump()
        })
      }
      // A blocked step is only blocked by a running step, so active === 0 with all
      // started means the batch is done (no deadlock possible).
      if (active === 0 && batch.every((s) => s.started)) resolveAll(out)
    }
    pump()
  })
}

// Flush a pooled batch's captured output + results in canonical order.
function printBatchResults(batch, captured) {
  for (const step of batch) {
    const { name, ok, ms, text } = captured.get(step.i)
    console.log(`\n=== ${name}: ${step.cmd}`)
    if (text.length) process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
    results.push([name, ok, ms])
  }
}

// Walk the steps in canonical order; fold maximal runs of consecutive PARALLEL_SAFE
// steps into a pooled batch, run every other step exclusively. Output and results[]
// stay in canonical order regardless of finish order.
async function runReportAll() {
  const poolSize = Math.max(1, Math.min(4, availableParallelism() - 1))
  let i = 0
  while (i < steps.length) {
    if (!PARALLEL_SAFE.has(steps[i][0])) {
      runSerial(steps[i])
      i += 1
      continue
    }
    const batch = []
    while (i < steps.length && PARALLEL_SAFE.has(steps[i][0])) {
      batch.push({ i, name: steps[i][0], cmd: steps[i][1] })
      i += 1
    }
    if (batch.length === 1) {
      runSerial([batch[0].name, batch[0].cmd])
      continue
    }
    const captured = await runBatch(batch, poolSize)
    printBatchResults(batch, captured)
  }
}

if (reportAll) {
  await runReportAll()
} else {
  for (const [name, cmd] of steps) {
    console.log(`\n=== ${name}: ${cmd}`)
    const t0 = performance.now()
    const ok = spawnSync(cmd, { shell: true, stdio: 'inherit' }).status === 0
    results.push([name, ok, Math.round(performance.now() - t0)])
    if (!ok) break
  }
}

console.log('\nvalidate summary:')
for (const [name, ok, ms] of results) console.log(`  ${ok ? '✓' : '✗'} ${name} (${String(ms)}ms)`)
const notRun = steps.length - results.length
if (notRun > 0) console.log(`  (${String(notRun)} later step(s) not run)`)
const totalMs = Math.round(performance.now() - t0All)
console.log(`  total ${String(totalMs)}ms`)

// ONE machine-readable line, emitted last so a consumer parsing it never has to reason
// about interleaved step output. The human summary above is unchanged and stays the
// thing an agent reads; this exists so scripts/check-chain-budget.mjs (factory-side, in
// the selftest) can attribute a wall-time regression to a STEP instead of reporting that
// "the chain got slower". A wall-only budget cannot say which step moved, which is the
// whole reason the inline `-gt 120` literal it replaces was never actionable.
//
// Deliberately NOT a file write: validate.mjs runs in a consumer's tree on every turn,
// and a gate that leaves timing artifacts behind is a gate that shows up in `git status`.
// SOURCE: docs/harness/README.md (unmeasured numbers do not ship)
console.log(
  `VALIDATE_TIMINGS ${JSON.stringify({
    totalMs,
    notRun,
    steps: Object.fromEntries(results.map(([name, , ms]) => [name, ms])),
  })}`,
)
process.exit(results.every(([, ok]) => ok) ? 0 : 1)
