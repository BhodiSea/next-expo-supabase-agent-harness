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

export function ok(gate, msg) {
  console.log(`${gate}: OK${msg ? ` — ${msg}` : ''}`)
  process.exit(0)
}

export function fail(gate, msg) {
  console.error(`${gate}: FAIL — ${msg}`)
  console.error(fixHint(gate))
  process.exit(1)
}

// Prerequisite missing: loud local skip, hard CI failure.
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
// rampNote(gate, minVersion, detail) is the one shared ramp: it reads
// .harness/manifest.json and compares the install's baseVersion (the release
// vintage of its seeded content; older manifests fall back to harnessVersion)
// against the version the check went live in.
//   returns true  -> the caller must stay NOTE-only this run (a NOTE line naming
//                    the check, the ramp, and the graduation runbook is printed);
//   returns false -> the check is live: no manifest (template dev tree, gate
//                    fixtures, fresh pre-manifest runs) or baseVersion >= min.
// Corrupt manifest JSON FAILS CLOSED via fail(): .harness/ is write-guard-
// protected, so an unparseable manifest is tampering, not a ramp.
// SOURCE: docs/runbooks/harness-upgrade.md (version-ramp doctrine: NOTE on
// pre-ramp installs, hard-fail on fresh installs) [corpus: harness/doctrine]

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

export function rampNote(gate, minVersion, detail) {
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
  console.log(
    `${gate}: NOTE — ${detail} (ramp: live from baseVersion ${minVersion}; this install's baseVersion is ${base}). Sweep the findings, then graduate deliberately by bumping baseVersion in .harness/manifest.json — a human edit; see docs/runbooks/harness-upgrade.md`,
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

// ---- content-addressed stamps (generalized from the source harness's toolchain stamp) ----
// hashInputs: one sha256 over the declared input paths (files or directories,
// recursive, name+bytes, sorted walk so the digest is order-stable). A missing
// path contributes its name — appearing/disappearing invalidates the stamp.
const STAMP_EXCLUDES = new Set(['node_modules', 'target', 'dist', 'gen', 'test-results'])

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
