// Shared gate-script helpers. Doctrine: a gate that cannot run its real check
// SKIPS LOUDLY when the prerequisite is absent locally, and FAILS CLOSED in CI
// (CI=true or HARNESS_REQUIRE_TOOLCHAINS=1) — a skip must never look like a pass.
// Every failure path ends with a deterministic `FIX[gate]:` line (exact reproduce
// command + docs pointer) so an agent reading a red Stop block knows the next
// action without spelunking — the feedback loop is part of the product.
// SOURCE: docs/harness/README.md (skip-local / fail-closed-CI asymmetry) [corpus: harness/doctrine]
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { toPosix, walkFiles } from './fs-walk.mjs'

export const inCI = () =>
  process.env.CI === 'true' || process.env.HARNESS_REQUIRE_TOOLCHAINS === '1'

// The reproduce command is derived from the running script so it can never drift
// from reality; gates invoked through a wrapper fall back to the whole chain.
function fixHint(gate) {
  const script = process.argv[1]
    ?.split('\\')
    .join('/')
    .replace(/^.*?\/(tools\/)/, '$1')
  const argv = process.argv.slice(2).filter((a) => /^[a-z0-9-]+$/i.test(a))
  const cmd = script?.startsWith('tools/')
    ? ['node', script, ...argv].join(' ')
    : 'node tools/validate.mjs'
  return `FIX[${gate}]: reproduce with \`${cmd}\`; docs: docs/harness/gates-catalog.md ("${gate}")`
}

// The three exits below are annotated `@returns {never}` DELIBERATELY, and it is not
// cosmetic. Under `checkJs: true` TypeScript infers `void` for a function whose body ends in
// `process.exit()`, so at every `if (bad) fail(...)` call site the code after the branch is
// still considered reachable with the pre-branch types — which is how a `fail()` that replaced
// a `return process.exit(1)` silently stops narrowing (`never` is assignable to anything;
// `void` is not). `strict: false` means adding the annotation cannot break a caller, and the
// callers that already relied on narrowing get it back.

/** @param {string} gate @param {string} [msg] @returns {never} */
export function ok(gate, msg) {
  console.log(`${gate}: OK${msg ? ` — ${msg}` : ''}`)
  process.exit(0)
}

/** @param {string} gate @param {string} msg @returns {never} */
export function fail(gate, msg) {
  console.error(`${gate}: FAIL — ${msg}`)
  console.error(fixHint(gate))
  process.exit(1)
}

// Prerequisite missing: loud local skip, hard CI failure.
/** @param {string} gate @param {string} reason @returns {never} */
export function skipOrFail(gate, reason) {
  if (inCI()) {
    console.error(
      `${gate}: FAIL — ${reason} (skips are not allowed in CI: set up the prerequisite or remove the surface)`,
    )
    console.error(fixHint(gate))
    process.exit(1)
  }
  console.log(`${gate}: SKIPPED — ${reason} (this gate FAILS CLOSED in CI)`)
  process.exit(0)
}

export function failures(gate, list, hint) {
  if (list.length === 0) return
  console.error(`${gate}: FAIL (${list.length})`)
  for (const f of list) console.error(`  - ${f}`)
  if (hint) console.error(hint)
  console.error(fixHint(gate))
  process.exit(1)
}

// ---- version-ramped checks ------------------------------------------------------
// A NEW check added to an EXISTING gate must not red a consumer whose seeded
// content predates it — projects grow into gates; gates never ambush an update.
// rampNote(gate, minVersion, detail, { until }) is the one shared ramp: it reads
// .harness/manifest.json and compares the install's baseVersion (the release
// vintage of its seeded content; older manifests fall back to harnessVersion)
// against the version the check went live in.
//   returns true  -> the caller must stay NOTE-only this run (a NOTE line naming
//                    the check, the ramp, the DEADLINE, and the graduation
//                    runbook is printed);
//   returns false -> the check is live: no manifest (template dev tree, gate
//                    fixtures, fresh pre-manifest runs), baseVersion >= min, or
//                    the deadline has passed.
// Corrupt manifest JSON FAILS CLOSED via fail(): .harness/ is write-guard-
// protected, so an unparseable manifest is tampering, not a ramp.
//
// `until` IS MANDATORY (0.3.0). Before it, "shipped ramped" meant "shipped
// disabled, indefinitely": rampNote downgraded a check to an advisory NOTE — in
// CI too — and the only thing that ever re-armed it was a human running
// `graduate`, which nothing nagged. A control whose expiry date is optional has
// no expiry date. A call site without one THROWS: that is a harness authoring
// bug, not a consumer problem, so it must not be reportable as a project gate
// failure. tests/gates/ramp-expiry.test.mjs closes it statically over every
// shipped call site, so the throw is the backstop and not the discovery path.
// SOURCE: docs/runbooks/harness-upgrade.md (version-ramp doctrine: NOTE on
// pre-ramp installs, hard-fail on fresh installs, expiry on the deadline)
// [corpus: harness/doctrine]

// Numeric dotted compare (the harness releases plain x.y.z tags); non-numeric
// fields compare as plain strings so a mangled version cannot compare as newest.
export function cmpDotted(a, b) {
  const pa = String(a).split('.')
  const pb = String(b).split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const na = Number.parseInt(pa[i] ?? '0', 10)
    const nb = Number.parseInt(pb[i] ?? '0', 10)
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      if ((pa[i] ?? '') !== (pb[i] ?? '')) return (pa[i] ?? '') < (pb[i] ?? '') ? -1 : 1
      continue
    }
    if (na !== nb) return na < nb ? -1 : 1
  }
  return 0
}

function readManifest(gate) {
  const manifestPath = join('.harness', 'manifest.json')
  if (!existsSync(manifestPath)) return null
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (e) {
    fail(
      gate,
      `${manifestPath} is not valid JSON (${e.message}) — it is write-guard-protected, so a corrupt manifest is tampering; restore it from git history`,
    )
  }
}

// The version of the harness CODE this install currently runs, or null when there is
// no install record (template dev tree, gate fixtures). Deliberately NOT baseVersion:
// baseVersion only moves when a human graduates a ramp, so a deadline measured
// against it is a deadline its own beneficiary controls. harnessVersion advances on
// every `installer update`, which is what makes an expiring escape actually expire.
// SOURCE: installer/lib/manifest.mjs (harnessVersion advances on update; baseVersion
// is a deliberate human graduation) [corpus: harness/doctrine]
export function installedHarnessVersion(gate) {
  const manifest = readManifest(gate)
  if (manifest === null) return null
  const v = manifest.harnessVersion ?? manifest.baseVersion
  return typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v) ? v : null
}

export function rampNote(gate, minVersion, detail, opts) {
  const until = opts?.until
  if (typeof until !== 'string' || !/^\d+\.\d+\.\d+$/.test(until)) {
    // Deliberately a throw, not fail(): fail() prints a FIX line pointing the
    // CONSUMER at a reproduce command, and there is nothing they can do about a
    // ramp the harness shipped without a deadline. An unhandled throw names the
    // file and line of the offending call site, which is who has to fix it.
    throw new TypeError(
      `rampNote('${gate}', '${minVersion}', …) was called without a valid \`until\` deadline (got ${JSON.stringify(until)}). ` +
        'Every ramp expires: pass { until: "<x.y.z>" } naming the release the escape ends in. ' +
        'A ramp with no deadline is a check shipped disabled. SOURCE: docs/runbooks/harness-upgrade.md (ramps expire)',
    )
  }
  if (cmpDotted(until, minVersion) <= 0) {
    throw new TypeError(
      `rampNote('${gate}', '${minVersion}', …) has until=${until}, which is not AFTER the ramp version — the escape would expire before or as it opens.`,
    )
  }
  const manifestPath = join('.harness', 'manifest.json')
  const manifest = readManifest(gate)
  if (manifest === null) return false // no install record -> the check is live
  const base = manifest.baseVersion ?? manifest.harnessVersion
  if (typeof base !== 'string' || !/^\d+\.\d+\.\d+/.test(base)) {
    fail(
      gate,
      `${manifestPath} carries no usable baseVersion/harnessVersion — restore it from git history (the ramp cannot fail open)`,
    )
  }
  if (cmpDotted(base, minVersion) >= 0) return false

  // The deadline is measured against harnessVersion, NOT baseVersion — see
  // installedHarnessVersion() above: baseVersion only moves when the ramp's own
  // beneficiary graduates, so a deadline measured against it never arrives.
  const live = installedHarnessVersion(gate)
  if (live !== null && cmpDotted(live, until) >= 0) {
    console.error(
      `${gate}: RAMP EXPIRED — ${detail} was ramped from baseVersion ${minVersion} with a deadline of ${until}, and this install runs harness ${live}. ` +
        'The escape is over: the finding below is a hard failure now. Sweep it, then `npx next-expo-supabase-agent-harness graduate`; ' +
        'see docs/runbooks/harness-upgrade.md (ramps expire).',
    )
    return false
  }
  console.log(
    `${gate}: NOTE — ${detail} (ramp: live from baseVersion ${minVersion}; this install's baseVersion is ${base}; expires in ${until}). Sweep the findings, then graduate deliberately by bumping baseVersion in .harness/manifest.json — a human edit; see docs/runbooks/harness-upgrade.md`,
  )
  return true
}

// ---- subprocess capture contract ----------------------------------------------
// One ceiling for every captured gate subprocess: node's 1 MB default
// ENOBUFS-crashes on real monorepo output instead of failing with a named
// gate error.
export const MAX_BUFFER = 64 * 1024 * 1024

// runCmd: execSync under the shared capture contract — utf8, MAX_BUFFER, stdin
// ignored, stdout/stderr piped so a failure still surfaces via e.stdout/e.stderr.
export function runCmd(cmd, opts = {}) {
  return execSync(cmd, {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  })
}

// commandFailureOutput: the one idiom for reporting a captured subprocess
// failure. Both streams, stdout first (expo/pnpm/playwright write diagnostics
// there), each coerced (Buffer-safe) and trimmed; e.message only when the
// combined output is empty. The retired per-site idiom
// `e.stderr?.toString() ?? e.message` had two holes this closes: '' is not
// nullish (a tool that wrote nothing to stderr produced an EMPTY failure
// detail), and stdout was dropped entirely. Callers keep their own shaping
// (head/tail slice, first-N-lines) over the return value.
export function commandFailureOutput(e) {
  const parts = [e.stdout, e.stderr].map((s) => (s == null ? '' : String(s).trim())).filter(Boolean)
  if (parts.length > 0) return parts.join('\n')
  return String(e.message ?? e)
}

// ---- content-addressed stamps (generalized from the source harness's toolchain stamp) ----
// hashInputs: one sha256 over the declared input paths (files or directories,
// recursive, name+bytes, sorted walk so the digest is order-stable). A missing
// path contributes its name — appearing/disappearing invalidates the stamp.
// Excluded dirs are the tree's own churn, never review-worthy input: build output
// ('.next'/'.expo'/'.turbo'), the Stop chain's own coverage maps ('coverage' — without
// it the `contracts` stamp's bare apps/packages roots self-invalidate every turn),
// and '.git'.
const STAMP_EXCLUDES = new Set([
  'node_modules',
  'target',
  'dist',
  'gen',
  'test-results',
  '.next',
  '.expo',
  '.turbo',
  'coverage',
  '.git',
])

/** @public exported for the harness repo's gate suite (tests/gates/hash-inputs.test.mjs) */
export function hashInputs(paths) {
  const h = createHash('sha256')
  for (const p of [...paths].sort()) {
    if (!existsSync(p)) {
      h.update(`missing:${p}`)
      continue
    }
    if (statSync(p).isDirectory()) {
      const root = toPosix(p)
      for (const rel of walkFiles(p, { excludeDirs: STAMP_EXCLUDES })) {
        h.update(`${root}/${rel}`)
        h.update(readFileSync(`${p}/${rel}`))
      }
      continue
    }
    h.update(toPosix(p))
    h.update(readFileSync(p))
  }
  return h.digest('hex')
}

// stampGate: if every declared input is byte-identical to the last GREEN run
// (stamp in .harness/<gate>.ok) and we are not in CI, report OK instantly.
// CI always runs the real check — a stamp is a local convenience, never proof.
// Returns recordGreen(); the gate calls it right before its final ok(). Input
// completeness is reviewed data in tools/lib/stamp-inputs.mjs — an undeclared
// input class is a stale-pass bug, so the selftest mutates each class and
// asserts invalidation.
// SOURCE: docs/harness/README.md (stamped gates) [corpus: harness/doctrine]
export function stampGate(gate, inputs) {
  const stampPath = join('.harness', `${gate}.ok`)
  const digest = hashInputs(inputs)
  if (!inCI() && existsSync(stampPath) && readFileSync(stampPath, 'utf8').trim() === digest) {
    ok(gate, `inputs unchanged since last green run (${stampPath}; CI always re-runs)`)
  }
  return function recordGreen() {
    mkdirSync('.harness', { recursive: true })
    writeFileSync(stampPath, digest)
  }
}
