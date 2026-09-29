// THE DEVICE LANE, CHECKED WHERE A PULL REQUEST CAN SEE IT (1.0.4, #10).
//
// Issue #10: `maestro/journeys/mutation.yaml` timed out on an element selector in every
// scheduled emulator run from the Supabase Auth port until 1.0.0. The journey tapped an
// EMPTY sign-in form (the stub authority that used to mint a user was gone), so the
// home screen never came. 1.0.0 fixed the journey, and the emulator lane has passed it in
// every scheduled run since. What stayed true is why it went unseen for weeks: a device
// lane's claims are checked only on a device, on a schedule no pull request waits for.
//
// This file checks the half of those claims that the files decide:
//   1. every selector a shipped journey or flow waits on is a testID the shipped app has;
//   2. the mutation journey signs in as the identity the lane mints: typed into the real
//      fields, no hideKeyboard, the router-live guard before the deep link;
//   3. every lane script that runs it mints that identity first and hands the journey
//      each flow variable it reads;
//   4. every job that boots the web host as the API publishes the env the host parses
//      before it boots, probes a procedure the router has, and gives the live proof the
//      env it requires;
//   5. a step that prints a log on failure prints one the job writes;
//   6. an upload of a Maestro output directory keeps Maestro's hidden debug directory;
//   7. a lane that starts Metro prewarms the bundle URL the selftest proved, and says so
//      when that fails.
// Each check is a function here with a red case beside the green one, so none can pass by
// finding nothing. What no file can prove, a real emulator running a real flow, stays the
// selftest `maestro-smoke` job's.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  budgetsFromInteractionFile,
  buildPerfHarnessYaml,
  buildSweepYaml,
} from '../../template/base/tools/lib/maestro-flows.mjs'
import { parseRoutes } from '../../template/base/tools/lib/mobile-app-meta.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const posix = (p) => p.split('\\').join('/')

const MUTATION = 'template/base/maestro/journeys/mutation.yaml'
const MOBILE_DIRS = ['template/stack/apps/mobile/app', 'template/stack/apps/mobile/src']
const LIVE_PROOF_SUITE = 'template/stack/apps/mobile/__tests__/live-api-proof.test.ts'
const WEB_ENV_SCHEMA = 'template/stack/packages/platform/env/src/client.ts'
const SERVER_ENV_SCHEMA = 'template/stack/packages/platform/env/src/index.ts'
const INVENTORY = 'template/base/tools/generated/action-inventory.json'

/** Files under a repo-relative directory, repo-relative and forward-slashed. */
function filesUnder(dir, pattern) {
  if (!existsSync(join(ROOT, dir))) return []
  return readdirSync(join(ROOT, dir), { recursive: true })
    .map((rel) => `${dir}/${posix(String(rel))}`)
    .filter((rel) => pattern.test(rel))
    .sort()
}

/** The module directories, each checked like base. */
const MODULES = readdirSync(join(ROOT, 'template/modules')).sort()

// ---------------------------------------------------------------------------
// 1. Selectors resolve to testIDs the app has.
// ---------------------------------------------------------------------------

/** Every `id:` selector a Maestro YAML names (tapOn, assertVisible, extendedWaitUntil). */
function selectorIds(yaml) {
  return [...yaml.matchAll(/^[ \t]*(?:-[ \t]+)?id:[ \t]*["']?([A-Za-z0-9_.-]+)["']?[ \t]*$/gm)].map(
    (m) => m[1],
  )
}

/** Every string literal in the shipped mobile source, tests excluded. */
function appLiterals() {
  const literals = new Set()
  for (const dir of MOBILE_DIRS) {
    for (const rel of filesUnder(dir, /\.tsx?$/)) {
      if (/(?:^|\/)__tests__\/|\.test\.tsx?$/.test(rel)) continue
      for (const m of read(rel).matchAll(/['"`]([A-Za-z0-9_.-]+)['"`]/g)) literals.add(m[1])
    }
  }
  return literals
}

/** The shipped flows and journeys, plus the two the runner generates from committed data. */
function shippedYamls() {
  const files = filesUnder('template/base/maestro', /\.ya?ml$/).map((rel) => ({
    name: rel,
    yaml: read(rel),
  }))
  const routes = parseRoutes(join(ROOT, 'template/stack/apps/mobile/src/routes.ts'))
  const identity = { appId: 'com.example.lane', scheme: 'laneapp' }
  const budgets = budgetsFromInteractionFile(
    JSON.parse(read('template/base/tools/interaction-budget.json')),
  )
  files.push({ name: '(generated) route-sweep.yaml', yaml: buildSweepYaml(routes, identity) })
  files.push({
    name: '(generated) perf-harness.yaml',
    yaml: buildPerfHarnessYaml(identity, budgets),
  })
  return files
}

/** `<file>: '<id>'` for each selector no literal in the app spells. */
function unresolvedSelectors(files, literals) {
  return files.flatMap(({ name, yaml }) =>
    selectorIds(yaml)
      .filter((id) => !literals.has(id))
      .map((id) => `${name}: '${id}'`),
  )
}

test('every selector a shipped journey or flow waits on is a testID the shipped app has', () => {
  const files = shippedYamls()
  const literals = appLiterals()
  const mutationIds = selectorIds(read(MUTATION))
  // Anti-vacuity: the mutation journey alone waits on eight surfaces; a parser that
  // stopped reading them would pass everything.
  assert.ok(mutationIds.length >= 8, `mutation.yaml selectors parsed: ${mutationIds.join(', ')}`)
  assert.ok(files.length >= 8, `shipped + generated YAMLs: ${String(files.length)}`)
  assert.deepEqual(unresolvedSelectors(files, literals), [])
  // RED: one renamed testID is exactly the "element selector timeout" of issue #10, found
  // here instead of on the emulator.
  const typo = [{ name: MUTATION, yaml: read(MUTATION).replace('sign-in-email', 'sign-in-emial') }]
  assert.deepEqual(unresolvedSelectors(typo, literals), [`${MUTATION}: 'sign-in-emial'`])
})

// ---------------------------------------------------------------------------
// 2. The mutation journey signs in as the minted identity.
// ---------------------------------------------------------------------------

/** Top-level steps of a Maestro flow (the part after `---`), comments dropped. */
function flowSteps(yaml) {
  const body = yaml.slice(yaml.indexOf('\n---') + 4)
  const lines = body.split('\n').filter((line) => !/^\s*#/.test(line))
  return lines
    .join('\n')
    .split(/^(?=- )/m)
    .map((step) => step.trim())
    .filter((step) => step.startsWith('- '))
}

const stepIndex = (steps, re) => steps.findIndex((step) => re.test(step))

/** `${NAME}` flow variables the journey reads. */
function flowVariables(yaml) {
  return [...new Set([...yaml.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)].map((m) => m[1]))]
}

/** What is wrong with a journey's sign-in, as sentences; [] when it signs in for real. */
function signInProblems(yaml) {
  const steps = flowSteps(yaml)
  const problems = []
  const guard = stepIndex(steps, /^- extendedWaitUntil:[\s\S]*id: "open-actions"/)
  const link = stepIndex(steps, /^- openLink: .*:\/\/sign-in"?$/)
  if (link === -1 || guard === -1 || guard > link) {
    problems.push('the router-live guard (open-actions) must precede the sign-in deep link')
  }
  const submit = stepIndex(steps, /^- tapOn:\s+id: "sign-in-submit"/)
  for (const [field, variable] of [
    ['sign-in-email', 'DEVICE_EMAIL'],
    ['sign-in-password', 'DEVICE_PASSWORD'],
  ]) {
    const tap = stepIndex(steps, new RegExp(`^- tapOn:\\s+id: "${field}"`))
    const typed = steps[tap + 1] === `- inputText: \${${variable}}`
    if (tap === -1 || !typed || submit < tap) {
      problems.push(`${field} must be tapped and typed \${${variable}} before sign-in-submit`)
    }
  }
  if (steps.some((step) => /^- hideKeyboard\b/.test(step))) {
    problems.push('hideKeyboard is BACK on Android and pops sign-in when no IME is up')
  }
  return problems
}

// The journey 1.0.0 replaced, cut to its sign-in (git show 289bc7c^:template/base/maestro/journeys/mutation.yaml).
const PRE_1_0_0_SIGN_IN = `appId: {{APP_IDENTIFIER}}
---
- launchApp:
    clearState: true
- extendedWaitUntil:
    visible:
        id: "open-actions"
    timeout: 90000
- openLink: "{{APP_SCHEME}}://sign-in"
- extendedWaitUntil:
    visible:
        id: "sign-in-submit"
    timeout: 60000
# Blank subject: the stub authority mints a fresh dev user for this run.
- tapOn:
    id: "sign-in-submit"
- extendedWaitUntil:
    visible:
        id: "home-screen"
    timeout: 30000
`

test('the mutation journey signs in as the identity the lane mints', () => {
  const yaml = read(MUTATION)
  assert.deepEqual(signInProblems(yaml), [])
  assert.deepEqual(flowVariables(yaml), ['DEVICE_EMAIL', 'DEVICE_PASSWORD'])
  // RED: the journey issue #10 names, which tapped an empty form.
  assert.deepEqual(signInProblems(PRE_1_0_0_SIGN_IN), [
    'sign-in-email must be tapped and typed ${DEVICE_EMAIL} before sign-in-submit',
    'sign-in-password must be tapped and typed ${DEVICE_PASSWORD} before sign-in-submit',
  ])
  // RED: the second 1.0.0 dispatch's defect, hideKeyboard after typing.
  const back = yaml.replace('- pressKey: Enter', '- hideKeyboard')
  assert.deepEqual(signInProblems(back), [
    'hideKeyboard is BACK on Android and pops sign-in when no IME is up',
  ])
})

// ---------------------------------------------------------------------------
// 3. Every lane that runs the journey mints first and hands it its variables.
// ---------------------------------------------------------------------------

/** Every lane script: the factory's, the consumer's, and each module's. */
function laneScripts() {
  return [
    ...filesUnder('scripts/ci', /\.sh$/),
    ...filesUnder('template/base/tools/ci', /\.sh$/),
    ...MODULES.flatMap((m) => filesUnder(`template/modules/${m}/tools/ci`, /\.sh$/)),
  ]
}

/** Shell text with backslash continuations joined, one command per line. */
const commands = (sh) => sh.replace(/\\\n\s*/g, ' ').split('\n')

/** What is wrong with how a lane script runs the mutation journey. */
function journeyLaneProblems(sh, variables) {
  const lines = commands(sh)
  const run = lines.findIndex((line) => line.includes('--file maestro/journeys/mutation.yaml'))
  if (run === -1) return []
  const problems = []
  const mint = lines.findIndex((line) => /node tools\/ci\/mint-device-user\.mjs /.test(line))
  if (mint === -1 || mint > run) problems.push('mint-device-user.mjs must run before the journey')
  for (const name of variables) {
    if (!lines[run].includes(`--env "${name}=`)) problems.push(`the journey needs --env "${name}=…"`)
  }
  return problems
}

test('every lane that runs the mutation journey mints the identity first and passes each variable', () => {
  const variables = flowVariables(read(MUTATION))
  const lanes = laneScripts().filter((rel) => read(rel).includes('maestro/journeys/mutation.yaml'))
  assert.deepEqual(lanes, ['scripts/ci/device-smoke.sh', 'template/base/tools/ci/device-lane.sh'])
  for (const rel of lanes) assert.deepEqual(journeyLaneProblems(read(rel), variables), [], rel)
  // RED: a lane that drops the password variable.
  const dropped = read(lanes[1]).replace(' --env "DEVICE_PASSWORD=$DEVICE_PASSWORD"', '')
  assert.deepEqual(journeyLaneProblems(dropped, variables), [
    'the journey needs --env "DEVICE_PASSWORD=…"',
  ])
})

// ---------------------------------------------------------------------------
// Workflows, sliced the way tests/gates/workflow-lanes.test.mjs slices them.
// ---------------------------------------------------------------------------

/** Every workflow a job of which could boot the web host or upload device evidence. */
function workflowFiles() {
  return [
    ...filesUnder('.github/workflows', /\.ya?ml$/),
    ...filesUnder('template/base/github/workflows', /\.ya?ml$/),
    ...MODULES.flatMap((m) => filesUnder(`template/modules/${m}/github/workflows`, /\.ya?ml$/)),
  ]
}

/** @returns {Array<{ id: string, head: string, steps: string[] }>} */
function jobsOf(text) {
  const at = text.indexOf('\njobs:')
  if (at === -1) return []
  const region = text.slice(at)
  const heads = [...region.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)]
  return heads.map((m, i) => {
    const body = region.slice(m.index, heads[i + 1]?.index ?? region.length)
    const stepsAt = body.search(/^ {4}steps:$/m)
    const head = stepsAt === -1 ? body : body.slice(0, stepsAt)
    const steps = stepsAt === -1 ? [] : body.slice(stepsAt).split(/^(?= {6}- )/m).slice(1)
    return { id: m[1], head, steps }
  })
}

const allJobs = () =>
  workflowFiles().flatMap((file) => jobsOf(read(file)).map((job) => ({ file, ...job })))

// ---------------------------------------------------------------------------
// 4. A job that boots the web host gives it, and the live proof, what they read.
// ---------------------------------------------------------------------------

/** Names a job makes available BEFORE step `index`: job env, earlier GITHUB_ENV writes, the step's own env and exports. */
function namesBefore(job, index) {
  const names = new Set([...job.head.matchAll(/^ {6}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]))
  for (const step of job.steps.slice(0, index)) {
    if (!step.includes('GITHUB_ENV')) continue
    for (const m of step.matchAll(/echo "([A-Z][A-Z0-9_]*)=/g)) names.add(m[1])
  }
  const own = job.steps[index] ?? ''
  for (const m of own.matchAll(/^ {10}([A-Z][A-Z0-9_]*):/gm)) names.add(m[1])
  for (const m of own.matchAll(/\bexport ([A-Z][A-Z0-9_]*)=/g)) names.add(m[1])
  return names
}

/** The top-level keys of one `<name> = z.object({ ... })` schema, in source order. */
function schemaKeys(rel, name) {
  const src = read(rel)
  const at = src.indexOf(`${name} = z.object({`)
  if (at === -1) return []
  const body = src.slice(at, src.indexOf('\n})', at))
  return [...body.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1])
}

/**
 * The names the web host parses when a request first loads @app/env: the server-only
 * class (index.ts), then the web-public class (client.ts). A missing one of either is a
 * 500 on every route, health included.
 */
function webHostEnv() {
  return [
    ...schemaKeys(SERVER_ENV_SCHEMA, 'ServerEnvSchema'),
    ...schemaKeys(WEB_ENV_SCHEMA, 'WebPublicEnvSchema'),
  ]
}

/** Each requireEnv(...) group of the live proof: at least one name per group must be set. */
function liveProofEnvGroups() {
  const groups = [...read(LIVE_PROOF_SUITE).matchAll(/requireEnv\(([^)]*)\)/g)]
    .map((m) => [...m[1].matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((n) => n[1]))
    .filter((names) => names.length > 0)
  // The suite is describe.skip unless LIVE_PROOF=1: a job that runs it without that runs nothing.
  return [['LIVE_PROOF'], ...groups]
}

const procedures = () => new Set(JSON.parse(read(INVENTORY)).map((row) => row.action))

/** What is wrong with one job's web-host boot and live proof, as sentences. */
function webHostProblems(job, { required, groups, known }) {
  const problems = []
  const boot = job.steps.findIndex((step) => /pnpm --filter web run (?:dev|start)\b/.test(step))
  if (boot !== -1) {
    const have = namesBefore(job, boot)
    const missing = required.filter((name) => !have.has(name))
    if (missing.length > 0) problems.push(`boots the web host before ${missing.join(', ')} is set`)
    const probe = job.steps[boot].match(/127\.0\.0\.1:3000\/api\/trpc\/([A-Za-z0-9_.]+)/)?.[1]
    if (probe === undefined || !known.has(probe)) {
      problems.push(`probes /api/trpc/${String(probe)}, which is no procedure the router has`)
    }
  }
  job.steps.forEach((step, index) => {
    if (!step.includes('live-api-proof.test.ts')) return
    const have = namesBefore(job, index)
    for (const group of groups.filter((g) => !g.some((name) => have.has(name)))) {
      problems.push(`runs the live proof without any of ${group.join(' / ')}`)
    }
  })
  return problems.map((p) => `${job.file}#${job.id}: ${p}`)
}

test('every job that boots the web host publishes its env first and probes a real procedure', () => {
  const context = { required: webHostEnv(), groups: liveProofEnvGroups(), known: procedures() }
  assert.deepEqual(context.required, [
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_DB_URL',
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE',
    'NEXT_PUBLIC_WEB_ORIGIN',
  ])
  assert.ok(context.known.has('system.health'), [...context.known].join(', '))
  assert.ok(context.groups.length >= 4, JSON.stringify(context.groups))
  const jobs = allJobs()
  const booting = jobs.filter((job) => job.steps.some((s) => /pnpm --filter web run dev\b/.test(s)))
  // Anti-vacuity: the selftest's integration and maestro-smoke jobs, and the consumer's
  // integration-lane and mobile-e2e jobs, each boot the host.
  assert.deepEqual(booting.map((job) => `${job.file}#${job.id}`).sort(), [
    '.github/workflows/selftest.yml#integration',
    '.github/workflows/selftest.yml#maestro-smoke',
    'template/base/github/workflows/quality-gate.yml#integration-lane',
    'template/base/github/workflows/quality-gate.yml#mobile-e2e',
  ])
  assert.deepEqual(
    jobs.flatMap((job) => webHostProblems(job, context)),
    [],
  )
  // RED: integration-lane as 1.0.3 shipped it: the host booted with no env published and
  // probed at /api/trpc/health, and the live proof run with LIVE_PROOF and the DB URL only.
  const [old] = jobsOf(`on: workflow_dispatch
jobs:
  lane:
    env:
      LIVE_PROOF: '1'
      EXPO_PUBLIC_WEB_ORIGIN: 'http://127.0.0.1:3000'
    steps:
      - name: Boot the web app
        run: |
          pnpm --filter web run dev > /tmp/web.log 2>&1 &
          curl -fsS -m 2 "http://127.0.0.1:3000/api/trpc/health"
      - name: Live proof
        run: |
          eval "$(supabase status -o env | sed 's/^/export /')"
          export SUPABASE_DB_URL="$DB_URL"
          pnpm --filter mobile exec jest __tests__/live-api-proof.test.ts
`)
  assert.ok(old !== undefined)
  assert.deepEqual(webHostProblems({ file: 'old.yml', ...old }, context), [
    `old.yml#lane: boots the web host before ${context.required.join(', ')} is set`,
    'old.yml#lane: probes /api/trpc/health, which is no procedure the router has',
    'old.yml#lane: runs the live proof without any of SUPABASE_URL / EXPO_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL',
    'old.yml#lane: runs the live proof without any of SUPABASE_ANON_KEY / EXPO_PUBLIC_SUPABASE_PUBLISHABLE / NEXT_PUBLIC_SUPABASE_PUBLISHABLE',
    'old.yml#lane: runs the live proof without any of SUPABASE_SERVICE_ROLE_KEY',
  ])
  // RED: the publish step moved first, but without the server-only DB URL, which the
  // host parses before any NEXT_PUBLIC_ name.
  const [partial] = jobsOf(`on: workflow_dispatch
jobs:
  lane:
    steps:
      - name: Publish
        run: |
          {
            echo "NEXT_PUBLIC_SUPABASE_URL=\${API_URL%/}"
            echo "NEXT_PUBLIC_SUPABASE_PUBLISHABLE=\${ANON_KEY}"
            echo "NEXT_PUBLIC_WEB_ORIGIN=http://127.0.0.1:3000"
            echo "SUPABASE_SERVICE_ROLE_KEY=\${SERVICE_ROLE_KEY}"
          } >> "$GITHUB_ENV"
      - name: Boot the web app
        run: |
          pnpm --filter web run dev > /tmp/web.log 2>&1 &
          curl -fsS -m 2 "http://127.0.0.1:3000/api/trpc/system.health"
`)
  assert.ok(partial !== undefined)
  assert.deepEqual(webHostProblems({ file: 'partial.yml', ...partial }, context), [
    'partial.yml#lane: boots the web host before SUPABASE_DB_URL is set',
  ])
})

// ---------------------------------------------------------------------------
// 5. A failure step prints logs the job writes.
// ---------------------------------------------------------------------------

/** Lane scripts a job's steps run with `bash <path>`, resolved to the files that ship them. */
function scriptsRunBy(job) {
  const found = []
  for (const step of job.steps) {
    for (const m of step.matchAll(/bash\s+"?(?:\$GITHUB_WORKSPACE\/)?([\w./-]+\.sh)/g)) {
      const candidates = [m[1], `template/base/${m[1]}`, ...MODULES.map((x) => `template/modules/${x}/${m[1]}`)]
      found.push(...candidates.filter((rel) => existsSync(join(ROOT, rel))))
    }
  }
  return found
}

/** `/tmp/<name>` logs a job reads with cat but neither it nor a script it runs writes. */
function unwrittenLogs(job, scripts = scriptsRunBy(job).map(read)) {
  const text = [...job.steps, ...scripts].join('\n')
  const logs = [...new Set([...job.steps.join('\n').matchAll(/\bcat (\/tmp\/[\w.-]+)/g)].map((m) => m[1]))]
  return logs.filter((log) => !new RegExp(`>\\s*${log.replace(/[.]/g, '\\.')}\\b`).test(text))
}

test('a step that prints a log prints one its job writes', () => {
  const jobs = allJobs()
  const readers = jobs.filter((job) => /\bcat \/tmp\//.test(job.steps.join('\n')))
  assert.ok(readers.length >= 4, readers.map((job) => job.id).join(', '))
  const problems = jobs.flatMap((job) =>
    unwrittenLogs(job).map((log) => `${job.file}#${job.id}: cats ${log}, which nothing writes`),
  )
  assert.deepEqual(problems, [])
  // RED: the log a job never writes.
  const smoke = jobs.find((job) => job.id === 'maestro-smoke')
  assert.ok(smoke !== undefined)
  const renamed = { ...smoke, steps: [...smoke.steps, '      - run: cat /tmp/nowhere.log\n'] }
  assert.deepEqual(unwrittenLogs(renamed), ['/tmp/nowhere.log'])
})

// ---------------------------------------------------------------------------
// 6. An upload of a Maestro output directory keeps Maestro's debug directory.
// ---------------------------------------------------------------------------

/** `artifacts/<dir>` roots the device runner writes into, from every --out-dir a lane passes. */
function maestroOutRoots() {
  const texts = [...laneScripts(), ...workflowFiles()].map(read)
  const roots = new Set()
  for (const text of texts) {
    for (const m of text.matchAll(/--out-dir\s+"?(artifacts\/[\w-]+)/g)) roots.add(m[1])
  }
  return [...roots].sort()
}

/** Upload steps whose path holds Maestro output and that would drop its hidden `.maestro/`. */
function hiddenDropped(job, roots) {
  return job.steps
    .filter((step) => /uses: actions\/upload-artifact@/.test(step))
    .filter((step) => roots.some((root) => (step.match(/^ {10}path:[^\n]*(?:\n {12}[^\n]*)*/m)?.[0] ?? '').includes(root)))
    .filter((step) => !/^ {10}include-hidden-files: true$/m.test(step))
    .map((step) => `${job.file}#${job.id}: ${step.match(/name: ([^\n]+)/)?.[1] ?? 'upload'}`)
}

test('every upload of Maestro output keeps the hidden .maestro/ debug directory', () => {
  // Maestro's --debug-output writes its commands, screenshots and maestro.log under
  // <dir>/.maestro/tests/<timestamp>/, and upload-artifact drops hidden files by
  // default: every maestro-smoke run uploaded only the runner's own files (5 on a
  // perf-harness red, 11 on a green run) and none of Maestro's.
  const roots = maestroOutRoots()
  assert.deepEqual(roots, ['artifacts/device-e2e', 'artifacts/maestro'])
  const jobs = allJobs()
  const uploads = jobs.filter((job) =>
    job.steps.some(
      (step) => /upload-artifact@/.test(step) && roots.some((root) => step.includes(`${root}/`)),
    ),
  )
  assert.ok(uploads.length >= 3, uploads.map((job) => job.id).join(', '))
  assert.deepEqual(
    jobs.flatMap((job) => hiddenDropped(job, roots)),
    [],
  )
  // RED: the same step without the input.
  const smoke = jobs.find((job) => job.id === 'maestro-smoke')
  assert.ok(smoke !== undefined)
  const stripped = {
    ...smoke,
    steps: smoke.steps.map((s) => s.replace(/^ {10}include-hidden-files: true\n/m, '')),
  }
  assert.equal(hiddenDropped(stripped, roots).length, 1)
})

// ---------------------------------------------------------------------------
// 7. The dev-half prewarm fetches the bundle a debug build asks Metro for.
// ---------------------------------------------------------------------------

const VIRTUAL_ENTRY = '/.expo/.virtual-metro-entry.bundle?platform=android&dev=true'

/** What is wrong with a lane script's Metro prewarm. */
function prewarmProblems(sh) {
  if (!/expo start --port 8081/.test(sh)) return []
  const problems = []
  if (!sh.includes(VIRTUAL_ENTRY)) problems.push(`prewarms something other than ${VIRTUAL_ENTRY}`)
  if (/\/index\.bundle\?/.test(sh)) problems.push('fetches /index.bundle, which 404s on this SDK')
  if (commands(sh).some((line) => /curl\b.*\.bundle/.test(line) && /\|\|\s*true/.test(line))) {
    problems.push('swallows a failed prewarm with || true')
  }
  return problems
}

test('every lane that starts Metro prewarms the virtual entry bundle, and a failed prewarm reds', () => {
  const metroLanes = laneScripts().filter((rel) => /expo start --port 8081/.test(read(rel)))
  assert.deepEqual(metroLanes, ['scripts/ci/device-smoke.sh', 'template/base/tools/ci/device-lane.sh'])
  for (const rel of metroLanes) assert.deepEqual(prewarmProblems(read(rel)), [], rel)
  // RED: the prewarm the consumer lane shipped through 1.0.3.
  const old = `CI=1 pnpm --filter mobile exec expo start --port 8081 > /tmp/metro.log 2>&1 &
curl -fsS -m 600 "http://127.0.0.1:8081/index.bundle?platform=android&dev=true" -o /dev/null || true
`
  assert.deepEqual(prewarmProblems(old), [
    `prewarms something other than ${VIRTUAL_ENTRY}`,
    'fetches /index.bundle, which 404s on this SDK',
    'swallows a failed prewarm with || true',
  ])
})
