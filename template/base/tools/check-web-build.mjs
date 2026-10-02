#!/usr/bin/env node
// Gate: web-compile — the web app must COMPILE. `next build --webpack` over apps/web, on a
// stamp miss, as a chain step directly after `build` (1.1.0).
//
// WHY A CHAIN STEP NOW. Through 1.0.x no chain step compiled the web app: `types` is a
// typecheck (it does not bundle, so a Client Component that pulls a server-only module, an
// RSC boundary violation or an unresolvable import all pass it), `build` is the mobile
// export, and `next build` ran only in the path-filtered `web-build` CI job and inside the
// web-e2e lane's server start. A web app that did not compile passed the whole local chain
// and the `static` job. The cost that kept it out, a full Next build on every validate, is
// what the content-addressed stamp removes: unchanged inputs (lib/stamp-inputs.mjs) cannot
// change the verdict, so a warm run reports STAMPED and builds nothing. CI never honours a
// stamp (lib/gate.mjs stampGate), so `static` builds on every pull request.
//
// IT COMPILES ONLY. The client-bundle purity scan stays in the `web-build` job
// (tools/build-check.mjs --web), which reads a real build's `.next/static`.
//
// THE BINARY, NEVER A SCRIPT NAME. apps/web/package.json is SEEDED, so an agent can redefine
// `build` there as an auto-accepted edit; `exec` runs the `next` binary the lockfile
// resolved, as the `build` step runs `expo`. `--webpack` matches the seeded script: the
// workspace packages' `.js` specifiers need webpack's extensionAlias (apps/web/next.config.ts).
//
// ORDER IN THE CHAIN IS LOAD-BEARING. Next's type check reads each referenced workspace
// package's emitted declarations, which `tsc -b` writes — the `types` step, earlier in the
// chain. Run alone on a fresh clone this step therefore reds with TS6305, and says so.
//
// THE PLACEHOLDER ENV. @app/env parses both halves of the environment when the build
// imports it, and a zero-edit scaffold (and bootstrap-linux) has no Supabase variables set.
// For each key the build needs that the caller did not set and no apps/web env file defines,
// the step supplies the value the `web-build` job builds with, byte for byte (a key or DSN
// spelled any other way is a `secrets` or `hygiene` finding), and prints which keys it
// filled: the stamp hashes files, not the environment. A key an apps/web `.env*` file defines
// is left for Next to load, because the process environment outranks every file and a
// placeholder must never build over a value the project configured.
//
// THE BUILD REWRITES A COMMITTED FILE. `next build` rewrites apps/web/next-env.d.ts with
// imports of its own `.next` output, and the committed copy exists precisely so a cold
// `tsc -b` works before any build (see its header). It sits inside the `apps/web` stamp
// input, so left rewritten it would dirty the tree and miss the stamp on every run. The step
// restores the committed bytes after the build, green or red.
// SOURCE: docs/harness/README.md (stamped gates) [corpus: harness/doctrine]
// SOURCE: docs/harness/README.md (skip-local / fail-closed-CI asymmetry) [corpus: harness/doctrine]
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import {
  commandFailureOutput,
  fail,
  ok,
  rampNote,
  runCmd,
  skipOrFail,
  stampGate,
} from './lib/gate.mjs'
import { STAMP_INPUTS } from './lib/stamp-inputs.mjs'

const GATE = 'web-compile'
const WEB_APP = 'apps/web'
const NEXT_ENV_FILE = `${WEB_APP}/next-env.d.ts`
const BUILD = 'pnpm --filter web exec next build --webpack'
const TYPES_FIRST = 'pnpm exec tsc -b . apps/web apps/mobile'
// How much of a failed build's output the verdict carries: its tail, where Next prints the
// error that stopped it.
const OUTPUT_TAIL = 4000

// The `web-build` job's "Build the web app" env, verbatim (template/base/github/workflows/
// quality-gate.yml). tests/gates/check-web-build.test.mjs reads that step and holds this
// table to it value for value.
const PLACEHOLDER_ENV = [
  ['NODE_ENV', 'production'],
  ['NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321'],
  ['NEXT_PUBLIC_SUPABASE_PUBLISHABLE', 'sb_publishable_build_time_placeholder'],
  ['NEXT_PUBLIC_WEB_ORIGIN', 'http://127.0.0.1:3000'],
  ['SUPABASE_SERVICE_ROLE_KEY', 'sb_secret_build_time_placeholder_do_not_use'],
  ['SUPABASE_DB_URL', 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'],
]

// The files `next build` loads into the environment, from the app directory, in production
// mode. SOURCE: https://nextjs.org/docs/app/guides/environment-variables (environment variable
// load order: process.env, .env.$(NODE_ENV).local, .env.local, .env.$(NODE_ENV), .env)
const NEXT_ENV_FILES = ['.env.production.local', '.env.local', '.env.production', '.env']

/**
 * The keys the app's own env files define. A read error (absence included) defines nothing.
 * @returns {Set<string>}
 */
function keysDefinedInEnvFiles() {
  const keys = new Set()
  for (const name of NEXT_ENV_FILES) {
    let text
    try {
      text = readFileSync(`${WEB_APP}/${name}`, 'utf8')
    } catch {
      continue
    }
    for (const m of text.matchAll(/^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/gm)) {
      keys.add(m[1])
    }
  }
  return keys
}

/**
 * The environment the build runs under: the caller's, plus a placeholder for each key
 * neither the caller nor an apps/web env file supplies.
 * @param {NodeJS.ProcessEnv} callerEnv
 * @returns {{ env: NodeJS.ProcessEnv, filled: string[] }}
 */
function buildEnvironment(callerEnv) {
  const fromFiles = keysDefinedInEnvFiles()
  const env = { ...callerEnv }
  const filled = []
  for (const [key, value] of PLACEHOLDER_ENV) {
    if (env[key] !== undefined || fromFiles.has(key)) continue
    env[key] = value
    filled.push(key)
  }
  return { env, filled }
}

/**
 * What a failed build reports: the tail of its output, plus the remedy for the one failure
 * whose cause is outside apps/web (the referenced declarations `types` writes).
 * @param {string} output
 */
function failureDetail(output) {
  const tail = output.length > OUTPUT_TAIL ? `…${output.slice(-OUTPUT_TAIL)}` : output
  if (!output.includes('TS6305')) return tail
  return `${tail}\nTS6305 means a referenced workspace package's declarations were never emitted: run \`${TYPES_FIRST}\` (the \`types\` step, which runs before this one in the chain) and re-run.`
}

/**
 * Run the build, restoring the committed next-env.d.ts afterwards whatever the outcome.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | null} the failure output, or null on a green build
 */
function compile(env) {
  let committed = null
  try {
    committed = readFileSync(NEXT_ENV_FILE)
  } catch {
    // Not committed here: nothing to restore.
  }
  try {
    runCmd(BUILD, { env })
    return null
  } catch (e) {
    return commandFailureOutput(e)
  } finally {
    if (committed !== null) writeFileSync(NEXT_ENV_FILE, committed)
  }
}

if (!existsSync(`${WEB_APP}/package.json`)) {
  skipOrFail(GATE, `${WEB_APP} not found (no web surface yet)`)
}
if (!existsSync('node_modules')) skipOrFail(GATE, 'node_modules missing — run pnpm install')

// Where this tree's stamp register has no list for this step (an edited
// tools/lib/stamp-inputs.mjs that `update` kept beside a parked newer one), the step builds in
// full on every run and records nothing, as the essential-eight and conformance-map stamps do.
const recordGreen = Array.isArray(STAMP_INPUTS[GATE])
  ? stampGate(GATE, STAMP_INPUTS[GATE])
  : () => {}

const { env, filled } = buildEnvironment(process.env)
if (filled.length > 0) {
  console.log(
    `${GATE}: placeholder env for ${filled.join(', ')} — unset by the caller and by ${WEB_APP}/.env*, so the build uses the web-build job's values (the stamp hashes files, not the environment)`,
  )
}

const failure = compile(env)
if (failure !== null) {
  const detail = failureDetail(failure)
  // THE RAMP (1.1.0, until 1.2.0). `update` injects this step into an existing chain through
  // the 1.1.0 record's configSteps, so a web app that stopped compiling before the install
  // upgraded would red on a check it never had. Below baseVersion 1.1.0 a failed build is a
  // NOTE carrying the output; fresh scaffolds are held to it at once. A ramped failure records
  // NO stamp, so the NOTE repeats on every run, and `graduate` stays refused, until the app
  // compiles. The ramp is consulted only once the build has failed: rampNote prints its NOTE
  // on every armed call, and a NOTE over a green build would refuse graduate for nothing.
  if (
    rampNote(GATE, '1.1.0', 'the web compile step (next build over apps/web)', { until: '1.2.0' })
  ) {
    console.log(`${GATE}: NOTE — \`${BUILD}\` failed; its output follows:`)
    for (const line of detail.split('\n')) console.log(`  ${line}`)
    ok(
      GATE,
      'NOTE-only on this pre-1.1.0 install: the web app does not compile, and no stamp is recorded, so this NOTE repeats until it does',
    )
  }
  fail(GATE, `\`${BUILD}\` failed:\n${detail}`)
}

recordGreen()
ok(GATE, `${WEB_APP} compiles (\`${BUILD}\`)`)
