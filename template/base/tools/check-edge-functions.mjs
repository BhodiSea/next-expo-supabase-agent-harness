#!/usr/bin/env node
// CI-only gate: edge-functions — every Supabase Edge Function TYPECHECKS against the exact
// dependency versions it deploys with (1.1.0). NOT a chain step: it runs in quality-gate.yml's
// `edge-functions` job, path-filtered on supabase/functions/** and this script, and nightly.
// `node tools/check-edge-functions.mjs` runs it anywhere `deno` is on PATH.
//
// WHY. supabase/functions/<fn>/index.ts runs on Deno, and nothing Node-side can load it: `tsc
// -b` never reaches supabase/, and vitest, coverage and the mutation lane cannot import a
// file that imports a jsr: specifier and starts a server as it loads. The seeded function
// holds the key that bypasses row security, so through 1.0.x a type error in service-role
// code passed `validate`, the Stop chain and CI alike. Its decisions now live in a handler
// the unit floor and the mutation lane reach; this gate is the type half, over the shell.
//
// For each function (a directory under supabase/functions holding an index.ts, `_`-prefixed
// shared directories excluded), it requires:
//   1. a deno.json beside index.ts whose jsr:/npm: imports name EXACT versions (x.y.z). Supabase
//      deploys each function with its own deno.json, so that file is where a function's
//      dependency versions live, and a range there resolves differently on the next deploy;
//   2. a deno.lock beside it, and `deno check --frozen` against the two: a lockfile that does
//      not match deno.json, or a type error anywhere in index.ts's import graph (its handler
//      and shared code included), is a finding with deno's own output.
// No function at all is OK, with the count: a project may have none.
//
// deno is a PREREQUISITE, not a dependency: CI installs it with denoland/setup-deno at the
// version quality-gate.yml pins (Renovate bumps it), so no install carries its binary. Missing
// locally, the gate skips loudly; in CI it fails closed (skipOrFail).
//
// RAMPED. Every finding, and a missing deno, was a NOTE until 1.2.0 (expired at 2.0.0) on an
// install whose baseVersion predates 1.1.0: `update` delivers this owned gate and its job,
// but not the seeded deno.json, deno.lock and handler split, which reach fresh scaffolds only
// (the 1.1.0 runbook section pulls them with `update --refresh-seeded`).
// SOURCE: docs/harness/gates-catalog.md (CI-only lanes, edge-functions)
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { commandFailureOutput, failures, ok, rampNote, runCmd, skipOrFail } from './lib/gate.mjs'

const GATE = 'edge-functions'
const ROOT = 'supabase/functions'
// Deno's own exit code decides; these only keep its output quiet and non-interactive.
const DENO_ENV = { ...process.env, DENO_NO_UPDATE_CHECK: '1', DENO_NO_PROMPT: '1', NO_COLOR: '1' }
// A jsr:/npm: specifier pinned to one release: name@x.y.z, an optional prerelease/build tag,
// an optional subpath. Anything else in a jsr:/npm: import (no version, ^, ~, a bare major)
// is a range.
const EXACT = /^(?:jsr|npm):(?:@[^/@\s]+\/)?[^/@\s]+@\d+\.\d+\.\d+(?:[-+][^/\s]*)?(?:\/.*)?$/

/** The function directories: each holds an index.ts; `_shared`-style directories never deploy. */
function listFunctions() {
  try {
    return readdirSync(ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
      .map((d) => d.name)
      .filter((name) => existsSync(`${ROOT}/${name}/index.ts`))
      .sort()
  } catch {
    return []
  }
}

/** Problems with one function's deno.json: a parse failure, or each import pinned to a range. */
function configProblems(dir) {
  let config
  try {
    config = JSON.parse(readFileSync(`${dir}/deno.json`, 'utf8'))
  } catch (e) {
    return [
      `${dir}/deno.json: cannot be parsed (${String(e.message)}) — deno check would read a different config than the one you meant`,
    ]
  }
  const imports = config?.imports ?? {}
  return Object.entries(imports)
    .filter(
      ([, target]) =>
        typeof target === 'string' && /^(?:jsr|npm):/.test(target) && !EXACT.test(target),
    )
    .map(
      ([name, target]) =>
        `${dir}/deno.json: imports["${name}"] is ${JSON.stringify(target)}, a range — pin it to one release (name@x.y.z) so every deploy and every check resolves the same code`,
    )
}

/** Whether a deno binary answers on PATH; its version line, or null. */
function denoVersion() {
  try {
    return runCmd('deno --version', { env: DENO_ENV }).split('\n')[0].trim()
  } catch {
    return null
  }
}

/** `deno check --frozen` of one function; a finding with deno's own output, or null. */
function typecheck(dir) {
  try {
    runCmd(
      `deno check --frozen --config "${dir}/deno.json" --lock="${dir}/deno.lock" "${dir}/index.ts"`,
      { env: DENO_ENV, timeout: 300_000 },
    )
    return null
  } catch (e) {
    const out = commandFailureOutput(e)
      .split('\n')
      .filter((l) => !/^Download /.test(l))
    return `${dir}: deno check failed —\n    ${out.slice(-40).join('\n    ')}`
  }
}

const functions = listFunctions()
if (functions.length === 0) {
  ok(GATE, `0 Edge Function(s) under ${ROOT} (no <name>/index.ts) — nothing to typecheck`)
}

/** @type {string[]} */
const configFindings = []
/** @type {string[]} */
const checkable = []
for (const name of functions) {
  const dir = `${ROOT}/${name}`
  const missing = ['deno.json', 'deno.lock'].filter((f) => !existsSync(`${dir}/${f}`))
  for (const f of missing) {
    configFindings.push(
      f === 'deno.json'
        ? `${dir}: no deno.json — a function's imports are pinned to exact versions in its own deno.json, which Supabase deploys it with`
        : `${dir}: no deno.lock — write it with \`deno check --frozen=false --config ${dir}/deno.json ${dir}/index.ts\` and commit it`,
    )
  }
  if (missing.includes('deno.json')) continue
  const problems = configProblems(dir)
  configFindings.push(...problems)
  if (missing.length === 0 && problems.length === 0) checkable.push(dir)
}

const version = denoVersion()
const typeFindings = version === null ? [] : checkable.map(typecheck).filter((f) => f !== null)

if (configFindings.length > 0 || version === null || typeFindings.length > 0) {
  const ramped = rampNote(
    GATE,
    '1.1.0',
    'the Edge Function surface (deno check of supabase/functions/*/index.ts against its own deno.json and frozen deno.lock)',
    { until: '1.2.0' },
  )
  if (ramped) {
    const notes = [
      ...configFindings,
      ...(version === null ? ['deno is not on PATH — the typecheck did not run'] : []),
      ...typeFindings,
    ]
    for (const n of notes) console.log(`${GATE}: NOTE — (ramp) ${n}`)
    ok(
      GATE,
      `NOTE-only on this pre-1.1.0 install — ${String(notes.length)} finding(s) above, with the deadline`,
    )
  }
}

failures(
  GATE,
  configFindings,
  `Each function under ${ROOT} needs a deno.json with exact jsr:/npm: versions and the deno.lock deno writes from it, both committed; the seeded delete-account function has both to copy.`,
)
if (version === null) {
  skipOrFail(
    GATE,
    `deno is not on PATH — ${String(checkable.length)} Edge Function(s) under ${ROOT} were not typechecked. Install the version quality-gate.yml's edge-functions job pins (denoland/setup-deno)`,
  )
}
failures(
  GATE,
  typeFindings,
  'Fix the type error deno names, or, when deno.json changed on purpose, refresh the lock with `deno check --frozen=false --config <fn>/deno.json <fn>/index.ts` and commit both.',
)
ok(
  GATE,
  `${String(checkable.length)} Edge Function(s) typecheck against their deno.json and frozen deno.lock (${version})`,
)
