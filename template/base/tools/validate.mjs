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
//   an agent sees all reds at once — with ~36 gates and a per-turn block budget, serial
//   one-red-per-turn discovery would exhaust the budget before the chain is green.
// --stop-chain (0.7.0): resolve the STOP-HOOK chain instead of VALIDATE_STEPS — the union
//   of the frozen tools/stop.floor.json and the config's STOP_HOOK_STEPS, computed by the
//   SAME lib the Stop hook imports (tools/lib/stop-chain.mjs), so nothing outside a live
//   turn can disagree with the hook about what the chain is. Composes with --list and
//   --report-all. FAILS CLOSED on a missing/corrupt floor: the hook's fail-open-with-NOTE
//   trade belongs to a live turn (a corrupt floor must not brick every turn on a machine);
//   a runner asked to PROVE the chain must never quietly prove a weakened one. This is a
//   resolution MODE — membership of both chains is untouched and neither floor moves.
// --list: print the resolved steps without running them.
// --ci-parity (1.0.4): CI's posture for a local run. Local and CI verdicts split on one
//   predicate, inCI() in tools/lib/gate.mjs: a missing prerequisite skips locally and
//   fails in CI, and a warm stamp is honoured only locally. The flag sets
//   HARNESS_REQUIRE_TOOLCHAINS=1 for every step (it never sets or unsets CI), prints the
//   posture as its FIRST line (a runner that predates the flag ignores it silently, so a
//   missing line means the flag was not applied), and closes after the summary's total
//   with one line per missing prerequisite a gate recorded
//   (lib/gate.mjs#noteMissingPrerequisite), in step order. The records live in a temp
//   directory outside the project, one subdirectory per step, removed on exit; if it
//   cannot be created the posture still applies and the report says it is unavailable.
//   Record-keeping never decides the exit code. With --list it changes nothing. It
//   REFUSES --stop-chain before resolving anything: the Stop chain has no single CI
//   equivalent, and its reviewer-verdicts step needs a live turn's identity, which only
//   the Stop hook sets. `--min-floor --ci-parity` is the local counterpart of CI's static
//   job. Without the flag, nothing here runs: no extra line, no per-step env, no temp dir.
// SOURCE: docs/harness/README.md (the Stop gate defines done; CI floor) [corpus: harness/doctrine]
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { STOP_HOOK_STEPS, VALIDATE_STEPS } from './harness.config.mjs'

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

async function resolveSteps() {
  if (flags.has('--stop-chain')) {
    // Imported lazily: the default chain must not grow a new load-bearing file, and the
    // lib is shared with the Stop hook — one implementation of the union, two postures.
    const { loadStopChain } = await import('./lib/stop-chain.mjs')
    const config = Array.isArray(STOP_HOOK_STEPS) ? STOP_HOOK_STEPS : []
    const { steps: union, floorNote } = loadStopChain(
      config,
      new URL('./stop.floor.json', import.meta.url),
    )
    if (floorNote !== null) {
      console.error(`validate --stop-chain: ${floorNote} — FAILING CLOSED; ${FLOOR_HINT}`)
      process.exit(1)
    }
    return union
  }
  if (!flags.has('--min-floor')) return VALIDATE_STEPS
  const floor = loadFloor()
  const floorNames = new Set(floor.map(([name]) => name))
  const extras = VALIDATE_STEPS.filter(([name]) => !floorNames.has(name))
  return [...floor, ...extras]
}

// ---- --ci-parity ------------------------------------------------------------------
const PARITY = 'validate --ci-parity'

// Refused before anything resolves, with or without --list: under CI's posture the Stop
// chain's reviewer-verdicts step fails whenever no live turn set its identity.
function refuseStopChainParity() {
  console.error(
    `${PARITY}: refused with --stop-chain. The Stop chain has no single CI equivalent: CI runs its other steps in their own jobs, and its reviewer-verdicts step needs a live turn's identity, which only the Stop hook sets, so under CI's posture it can only fail. For CI's static job, run \`node tools/validate.mjs --min-floor --ci-parity\`.`,
  )
  process.exit(1)
}

// Print the posture, set the predicate, and open the report root in the OS temp dir.
// A root that cannot be created leaves the posture in force: { root: null, error }.
function openParity() {
  console.log(
    `${PARITY}: CI posture for this run (HARNESS_REQUIRE_TOOLCHAINS=1): a missing prerequisite fails, no stamp is honoured`,
  )
  process.env.HARNESS_REQUIRE_TOOLCHAINS = '1'
  let root
  try {
    root = mkdtempSync(join(tmpdir(), 'harness-parity-'))
  } catch (err) {
    return { root: null, error: err.message }
  }
  process.on('exit', () => {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // It is in the OS temp dir, never the project tree; the verdict is already decided.
    }
  })
  return { root, error: null }
}

if (flags.has('--ci-parity') && flags.has('--stop-chain')) refuseStopChainParity()

const steps = await resolveSteps()

if (flags.has('--list')) {
  for (const [name, cmd] of steps) console.log(`${name}  ${cmd}`)
  process.exit(0)
}

const parity = flags.has('--ci-parity') ? openParity() : null

// The spawn options a step adds under --ci-parity: its own report directory, named by its
// index in the resolved list, so the closing block stays in step order under the pool.
// Without a report root this is empty, and the step inherits process.env as before.
function stepEnv(index) {
  if (!parity?.root) return {}
  return { env: { ...process.env, HARNESS_PARITY_REPORT_DIR: join(parity.root, String(index)) } }
}

// Every well-formed record one step left; a torn or foreign line is skipped. A step that
// recorded nothing has no directory (ENOENT, no error); any other failure is returned so
// the report never claims "none" over records it could not read.
function readStepRecords(index) {
  const dir = join(parity.root, String(index))
  try {
    const records = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').flatMap(parseRecord))
    return { records, error: null }
  } catch (err) {
    return { records: [], error: err.code === 'ENOENT' ? null : err.message }
  }
}

function parseRecord(line) {
  try {
    const r = JSON.parse(line)
    return typeof r?.gate === 'string' && typeof r?.reason === 'string' ? [r] : []
  } catch {
    return []
  }
}

// The closing block, printed after the summary's total and before VALIDATE_TIMINGS.
function parityReportLines() {
  if (!parity.root) return [`${PARITY}: report unavailable (${parity.error})`]
  const lines = new Set()
  for (const [index, [name]] of steps.entries()) {
    const { records, error } = readStepRecords(index)
    if (error !== null) lines.add(`${PARITY}: ${name}: report unreadable (${error})`)
    for (const { gate, reason } of records) lines.add(`${PARITY}: ${name}: ${gate} — ${reason}`)
  }
  return lines.size > 0 ? [...lines] : [`${PARITY}: no gate reported a missing prerequisite`]
}

const reportAll = flags.has('--report-all')
const results = []
const t0All = performance.now()

// Serial + streamed (stdio inherit), exactly like the default chain: header, run,
// record [name, ok, ms]. Used for the default mode, every exclusive step, and any
// lone PARALLEL_SAFE step (a batch of one has nothing to overlap).
function runSerial([name, cmd], index) {
  console.log(`\n=== ${name}: ${cmd}`)
  const t0 = performance.now()
  const ok = spawnSync(cmd, { shell: true, stdio: 'inherit', ...stepEnv(index) }).status === 0
  results.push([name, ok, Math.round(performance.now() - t0)])
}

// One child under the report-all pool: stdout+stderr captured (so the canonical-order
// flush owns the terminal) and elapsed ms measured around it.
function runChild(cmd, index) {
  const t0 = performance.now()
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, ...stepEnv(index) })
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
        runChild(step.cmd, step.i).then(({ ok, ms, text }) => {
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
      runSerial(steps[i], i)
      i += 1
      continue
    }
    const batch = []
    while (i < steps.length && PARALLEL_SAFE.has(steps[i][0])) {
      batch.push({ i, name: steps[i][0], cmd: steps[i][1] })
      i += 1
    }
    if (batch.length === 1) {
      runSerial([batch[0].name, batch[0].cmd], batch[0].i)
      continue
    }
    const captured = await runBatch(batch, poolSize)
    printBatchResults(batch, captured)
  }
}

if (reportAll) {
  await runReportAll()
} else {
  for (const [i, step] of steps.entries()) {
    runSerial(step, i)
    if (!results.at(-1)[1]) break
  }
}

console.log('\nvalidate summary:')
for (const [name, ok, ms] of results) console.log(`  ${ok ? '✓' : '✗'} ${name} (${String(ms)}ms)`)
const notRun = steps.length - results.length
if (notRun > 0) console.log(`  (${String(notRun)} later step(s) not run)`)
const totalMs = Math.round(performance.now() - t0All)
console.log(`  total ${String(totalMs)}ms`)
if (parity !== null) for (const line of parityReportLines()) console.log(line)

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
