#!/usr/bin/env node
// Gate: e2e-device — the consumer CI runner that executes Maestro flows against the
// emulator. CI-ONLY by nature (it needs a booted device and the Maestro CLI); the
// agent-time chain's device answer is the mobile-perf --closure triangle plus the RNTL
// fast lane, stated honestly in the gates catalog. tools/check-e2e.mjs strips nothing
// here because this script is never on the Stop chain at all — the quality-gate
// mobile-e2e job is its only caller.
//
// Phases (one per invocation — the lane sequences them so each phase's device
// precondition, e.g. a pre-seeded kv store or a flipped OS theme, is explicit in the
// workflow, not hidden in here):
//
//   --phase flows         Every committed maestro/flows/<id>.yaml, discovered FROM the
//                         ROUTES manifest (the mobile-perf closure asserts the triangle;
//                         this re-asserts it at run time so a lane pointed at a stale
//                         checkout cannot quietly sweep fewer screens).
//   --phase sweep         The GENERATED route sweep (tools/lib/maestro-flows.mjs) — one
//                         launch, every route deep-linked and container-asserted. The
//                         theme / font-scale phases re-run this after the workflow flips
//                         device state.
//   --phase journey --file <yaml> [--env KEY=VALUE ...]
//                         One hand-authored journey (maestro/journeys/*.yaml): the i18n
//                         pseudo-locale/RTL sweep over a pre-seeded kv store, the
//                         mutation flow (sign in -> create -> relaunch -> persists).
//                         `--env` (repeatable) forwards a Maestro flow variable
//                         (`${KEY}` in the YAML) as `maestro test -e KEY=VALUE` — how the
//                         lane hands the mutation journey the credentials it minted
//                         (1.0.0: the stub authority is gone; the sign-in is real).
//   --phase perf-harness  Generates the perf-harness journey from
//                         tools/interaction-budget.json and runs it — the flow asserts
//                         the screen's self-measured `perf-pass` leaf marker, so the
//                         assertion IS the interaction-budget verdict.
//
// Discipline carried from the source harness's lanes: per-flow hard timeout (a wedged
// emulator must red the lane, never hang it), evidence on failure (Maestro debug
// output, a screenshot, the logcat tail — a red must be debuggable from artifacts
// alone), and anti-vacuity (an invocation that executed ZERO flows exits red; a lane
// that ran nothing must never read as device coverage).
// SOURCE: docs/harness/gates-catalog.md (CI-only lanes — the Maestro device lane) [corpus: harness/doctrine]
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import process from 'node:process'
import { fail, MAX_BUFFER, ok, skipOrFail } from './lib/gate.mjs'
import {
  budgetsFromInteractionFile,
  buildPerfHarnessYaml,
  buildSweepYaml,
  perfHarnessUrl,
} from './lib/maestro-flows.mjs'
import { parseRoutes, readAppIdentity } from './lib/mobile-app-meta.mjs'

const GATE = 'e2e-device'
const ROUTES_FILE = 'apps/mobile/src/routes.ts'
const IDENTITY_LOCK = 'tools/identity.lock.json'
const BUDGET_FILE = 'tools/interaction-budget.json'
const FLOWS_DIR = 'maestro/flows'
const TAIL_LINES = 60
// Generous per-flow wall clock: emulator boots are already behind us, but a cold JS
// bundle load on a shared 2-core runner is minutes, not seconds.
const FLOW_TIMEOUT_MS = Number(process.env.HARNESS_FLOW_TIMEOUT_MS ?? '') || 8 * 60 * 1000

const args = process.argv.slice(2)
const valueOf = (name) => {
  const at = args.indexOf(name)
  return at !== -1 && at + 1 < args.length ? args[at + 1] : null
}
const phase = valueOf('--phase')
const outDir = valueOf('--out-dir') ?? 'artifacts/maestro'
// `--env KEY=VALUE`, repeatable. Values reach Maestro as `-e KEY=VALUE`; a malformed
// pair (no KEY, no `=`) is a usage error, not a silently-empty variable.
const flowEnv = args.flatMap((arg, at) =>
  arg === '--env' && at + 1 < args.length ? [args[at + 1]] : [],
)

// Every external tool runs through a SHELL command string (never bare spawnSync of a
// name): maestro and the test suite's stub tools are .cmd shims on Windows, which only
// a shell resolves — the exact portability lesson check-e2e.mjs carries for pnpm.
const quoted = (s) => JSON.stringify(String(s))
function sh(command, opts = {}) {
  return spawnSync(command, {
    shell: true,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    ...opts,
  })
}

// Maestro is a CI-lane toolchain: absent locally -> loud skip; absent in CI -> the
// lane is broken and must fail, not skip-green (the same asymmetry every gate keeps).
function resolveMaestro() {
  const probe = sh('maestro --version')
  if (probe.error === undefined && probe.status === 0) return 'maestro'
  const home = join(homedir(), '.maestro', 'bin', 'maestro')
  if (existsSync(home)) return quoted(home)
  skipOrFail(GATE, 'maestro CLI not found (PATH or ~/.maestro/bin) — the device lane cannot run')
  return '' // unreachable: skipOrFail exits
}

/** Best-effort failure evidence: screenshot + logcat tail + view hierarchy into the artifact dir. */
function captureEvidence(name) {
  try {
    sh(`adb exec-out screencap -p > ${quoted(join(outDir, `${name}-failure.png`))}`)
    const log = sh('adb logcat -d -t 400')
    if (log.status === 0) {
      writeFileSync(join(outDir, `${name}-logcat.txt`), log.stdout ?? '')
    }
    // The accessibility tree answers "was the element absent, empty-bounds, or
    // mis-labeled" — the one question a black screenshot cannot (learned from
    // the first mutation-journey red, where the screenshot was black but the
    // tree showed the tab bar mounted).
    const tree = sh('maestro hierarchy')
    if (tree.status === 0) {
      writeFileSync(join(outDir, `${name}-hierarchy.txt`), tree.stdout ?? '')
    }
  } catch {
    // Evidence is best-effort; the red below is the verdict either way.
  }
}

function runFlow(maestroBin, flowFile) {
  const name = basename(flowFile).replace(/\.ya?ml$/, '')
  console.log(`${GATE}: running ${flowFile}`)
  const envArgs = flowEnv.map((pair) => `-e ${quoted(pair)}`).join(' ')
  const res = sh(
    `${maestroBin} test ${envArgs}${envArgs === '' ? '' : ' '}--debug-output ${quoted(join(outDir, name))} ${quoted(flowFile)}`,
    { timeout: FLOW_TIMEOUT_MS, killSignal: 'SIGKILL' },
  )
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
  const tail = out.split('\n').slice(-TAIL_LINES).join('\n')
  if (
    res.error !== undefined &&
    /** @type {NodeJS.ErrnoException} */ (res.error).code === 'ETIMEDOUT'
  ) {
    console.error(tail)
    captureEvidence(name)
    fail(
      GATE,
      `${flowFile} KILLED after ${String(Math.round(FLOW_TIMEOUT_MS / 60000))} minutes — a wedged flow must red the lane, never hang it (evidence in ${outDir}/)`,
    )
  }
  if (res.status !== 0) {
    console.error(tail)
    captureEvidence(name)
    fail(
      GATE,
      `${flowFile} FAILED (exit ${String(res.status)}) — last ${String(TAIL_LINES)} lines above; Maestro debug output, screenshot and logcat tail in ${outDir}/`,
    )
  }
}

let routes
let identity
try {
  routes = parseRoutes(ROUTES_FILE)
  identity = readAppIdentity(IDENTITY_LOCK)
} catch (e) {
  fail(GATE, e instanceof Error ? e.message : String(e))
}

for (const pair of flowEnv) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(pair)) {
    fail(GATE, `--env expects KEY=VALUE (KEY an identifier); got '${pair}'`)
  }
}

const maestroBin = resolveMaestro()
mkdirSync(outDir, { recursive: true })
let executed = 0

if (phase === 'flows') {
  for (const route of routes) {
    const flowFile = `${FLOWS_DIR}/${route.id}.yaml`
    if (!existsSync(flowFile)) {
      fail(
        GATE,
        `route '${route.id}' has no ${flowFile} — the closure gate owns this at agent time; at lane time it means this checkout cannot claim device coverage (scaffold one: node tools/gen-maestro-flows.mjs --flow ${route.id})`,
      )
    }
    runFlow(maestroBin, flowFile)
    executed += 1
  }
} else if (phase === 'sweep') {
  const sweepFile = join(outDir, 'route-sweep.yaml')
  writeFileSync(sweepFile, buildSweepYaml(routes, identity))
  runFlow(maestroBin, sweepFile)
  executed = routes.length
} else if (phase === 'journey') {
  const file = valueOf('--file')
  if (file === null || !existsSync(file)) {
    fail(GATE, `--phase journey needs --file <existing maestro yaml>; got ${String(file)}`)
  }
  runFlow(maestroBin, file)
  executed = 1
} else if (phase === 'perf-harness') {
  if (!existsSync(BUDGET_FILE)) {
    fail(
      GATE,
      `${BUDGET_FILE} is missing — the perf-harness journey IS the interaction-budget assertion, so a lane without the budget file is a lane asserting nothing`,
    )
  }
  let budgets
  try {
    budgets = budgetsFromInteractionFile(JSON.parse(readFileSync(BUDGET_FILE, 'utf8')))
  } catch (e) {
    fail(GATE, e instanceof Error ? e.message : String(e))
  }
  const journeyFile = join(outDir, 'perf-harness.yaml')
  writeFileSync(journeyFile, buildPerfHarnessYaml(identity, budgets))
  // COLD-START by construction: force-stop first, so the deep link always takes
  // the initial-URL path into a FRESH process that fetches the current bundle
  // and measures exactly once. A warm delivery re-lands on an already-mounted
  // /perf-harness whose verdict is state from an EARLIER measurement — proven
  // live: after a canary's source revert, the restored run displayed the
  // stalled run's exact perf-fail metrics because nothing had remounted the
  // screen; whether a dev-client reload re-measures depends on HMR push
  // semantics this runner must not depend on.
  const stop = sh(`adb shell am force-stop ${quoted(identity.appId)}`)
  if (stop.status !== 0) {
    fail(
      GATE,
      `force-stop before the perf launch failed (exit ${String(stop.status)}): ${String(stop.stderr ?? '').slice(0, 400)}`,
    )
  }
  // The runner delivers the deep link itself: this is the one link with a query
  // string, and Maestro's openLink passes the URL through the device shell
  // unquoted — it splits at the first '&' and the intent never fires (proven
  // live: openLink reported COMPLETED while the hierarchy showed Home). The
  // inner single quotes survive `adb shell` onto the device shell, so the full
  // data string reaches `am start`.
  const url = perfHarnessUrl(identity, budgets)
  const nav = sh(`adb shell "am start -W -a android.intent.action.VIEW -d '${url}'"`)
  if (nav.status !== 0) {
    fail(
      GATE,
      `deep-link delivery failed (adb am start exit ${String(nav.status)}): ${String(nav.stderr ?? '').slice(0, 400)}`,
    )
  }
  runFlow(maestroBin, journeyFile)
  executed = 1
} else {
  fail(
    GATE,
    `unknown --phase ${String(phase)} — one of: flows | sweep | journey --file <yaml> | perf-harness`,
  )
}

// Anti-vacuity: a phase that executed nothing is a lane reading as device coverage
// this repo does not have (routes cannot be empty — parseRoutes already reds — so
// this trips only if a refactor breaks the counting above; belt and braces).
if (executed === 0) {
  fail(GATE, `phase '${String(phase)}' executed 0 flows — an empty device run is a vacuous pass`)
}
ok(GATE, `phase '${String(phase)}' — ${String(executed)} flow(s) green on the device`)
