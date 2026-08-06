#!/usr/bin/env node
// Gate: licenses — the production dependency tree stays inside the license allowlist,
// so the Stop gate itself refuses a copyleft/unknown-license dependency the moment an
// agent adds one. Exceptions live in tools/license-exceptions.json (reviewable data:
// {"exceptions": [{"package", "reason"}]}). Native platform dependencies enter this
// stack through npm packages (Expo modules, config plugins, autolinking), so the pnpm
// license tree is the whole production surface.
// SOURCE: docs/harness/README.md (license gate) [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'
import { fail, failures, ok, runCmd, skipOrFail, stampGate } from './lib/gate.mjs'
import { STAMP_INPUTS } from './lib/stamp-inputs.mjs'

const GATE = 'licenses'
// Content-addressed local skip: the license verdict is a pure function of the
// lockfile + exception list (declared in lib/stamp-inputs.mjs). CI always re-runs.
const recordGreen = stampGate(GATE, STAMP_INPUTS[GATE])

const ALLOWED = new Set([
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'CC-BY-4.0',
  'Unlicense',
  'Zlib',
  'Python-2.0',
  'MPL-2.0', // file-level copyleft: acceptable as a dependency, never vendored
])

// ── citeability + license declaration (G25) ──────────────────────────────────────
// Runs FIRST, and deliberately BEFORE the node_modules / `pnpm licenses` skips below:
// this half is pure filesystem, so it is always possible. Letting an absent install skip
// it would mean the artifact's own licensing went unchecked on exactly the machines that
// have not installed yet.
//
// The source harness proved ITS OWN licensing (REUSE, CITATION.cff) but shipped a scaffold
// that declared none: no LICENSE, no CITATION.cff, no `license` field. The delivered
// "research artifact" was therefore all-rights-reserved by default and not citable-as-a-work
// — the two things such an artifact most needs to be. This asserts it DECLARES its terms and
// can be cited, and that the declarations stay in lockstep. It never dictates WHICH license
// (that is the project's own legal decision — change LICENSE, the package.json field and
// CITATION.cff together).
// Ramped: live from this lineage's first release (0.1.0) — every install seeds these files,
// so the ramp exists only for the doctrine's sake (a future check rides the same rail).
// SOURCE: Citation File Format 1.2.0 — the standard GitHub/Zenodo read for software
// citation https://citation-file-format.github.io/
const citeErrs = []
const pkgRaw = existsSync('package.json') ? readFileSync('package.json', 'utf8') : null
if (pkgRaw !== null) {
  let pkg = {}
  try {
    pkg = JSON.parse(pkgRaw)
  } catch {
    citeErrs.push('package.json is not valid JSON')
  }
  const declared = typeof pkg.license === 'string' ? pkg.license.trim() : ''
  if (declared === '') {
    citeErrs.push(
      'package.json declares no "license" — the produced artifact is all-rights-reserved by default; declare your terms (e.g. "Apache-2.0", or "UNLICENSED" if deliberately proprietary)',
    )
  }
  if (!existsSync('LICENSE')) {
    citeErrs.push('no LICENSE file — the declared license needs its text in the repository root')
  }
  if (!existsSync('CITATION.cff')) {
    citeErrs.push(
      'no CITATION.cff — a research artifact must be citable-as-a-work (GitHub/Zenodo/reference managers read this file directly)',
    )
  } else {
    // Lockstep: a citation naming the wrong version or license misattributes the work.
    const cff = readFileSync('CITATION.cff', 'utf8')
    const cffField = (name) => {
      const m = new RegExp(`^${name}:\\s*(.+?)\\s*$`, 'm').exec(cff)
      return m === null ? null : m[1].replace(/^['"]|['"]$/g, '')
    }
    const cffVersion = cffField('version')
    const cffLicense = cffField('license')
    if (cffVersion === null) {
      citeErrs.push('CITATION.cff carries no `version:` field')
    } else if (typeof pkg.version === 'string' && cffVersion !== pkg.version) {
      citeErrs.push(
        `CITATION.cff version "${cffVersion}" != package.json version "${pkg.version}" — a citation must name the version it describes; bump both together`,
      )
    }
    if (cffLicense === null) {
      citeErrs.push('CITATION.cff carries no `license:` field')
    } else if (declared !== '' && cffLicense !== declared) {
      citeErrs.push(
        `CITATION.cff license "${cffLicense}" != package.json license "${declared}" — the artifact must state ONE set of terms`,
      )
    }
  }
}
// 0.4.0 DELETED THIS RAMP rather than expiring it. Its minVersion sat below v0.1.3,
// this lineage's oldest release, so gate.mjs returned false at `base >= minVersion` for
// every install that has ever existed: the escape was never reachable and the check has
// always been unconditional in practice. Removing the branch changes no behaviour on any
// real tree — it deletes a deadline that could not arrive.
// SOURCE: scripts/check-ramp-ledger.mjs (never-armed ramps)
if (citeErrs.length > 0) {
  failures(
    GATE,
    citeErrs,
    'The produced artifact must declare its terms and be citable: keep LICENSE, package.json#license and CITATION.cff (version + license) in lockstep.',
  )
}

if (!existsSync('node_modules')) {
  skipOrFail(GATE, 'node_modules missing — run pnpm install (license tree needs a resolution)')
}

// Exceptions — the ONE escape hatch, so its parse fails LOUD, never open.
// Canonical shape: { "comment": string, "exceptions": [{ "package": string, "reason": string }] }
const EXCEPTIONS_FILE = 'tools/license-exceptions.json'
const exceptions = new Set()
if (existsSync(EXCEPTIONS_FILE)) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(EXCEPTIONS_FILE, 'utf8'))
  } catch (e) {
    fail(
      GATE,
      `${EXCEPTIONS_FILE} is not valid JSON (${e.message}) — the exception list must be reviewable data`,
    )
  }
  if (!Array.isArray(parsed.exceptions)) {
    fail(
      GATE,
      `${EXCEPTIONS_FILE} must carry an "exceptions" ARRAY of {package, reason} entries — got ${JSON.stringify(Object.keys(parsed))}`,
    )
  }
  for (const entry of parsed.exceptions) {
    const okShape =
      entry !== null &&
      typeof entry === 'object' &&
      typeof entry.package === 'string' &&
      typeof entry.reason === 'string' &&
      entry.reason.trim().length > 0
    if (!okShape) {
      fail(
        GATE,
        `${EXCEPTIONS_FILE}: every exception must be {"package": string, "reason": non-empty string} — got ${JSON.stringify(entry)}`,
      )
    }
    exceptions.add(entry.package)
  }
}

let parsed
try {
  const out = runCmd('pnpm licenses list --prod --json')
  parsed = JSON.parse(out)
} catch (e) {
  skipOrFail(GATE, `pnpm licenses failed (${e.message?.slice(0, 120)})`)
}

const errs = []
for (const [license, pkgs] of Object.entries(parsed)) {
  // Compound SPDX expressions, parens stripped (flat evaluation): `A OR B` is the
  // licensee's choice — accept when ANY branch is allowed; `A AND B` means BOTH
  // apply — accept only when EVERY AND-part is allowed. Nested groups a flat
  // read cannot honour can only OVER-detect (red something acceptable), never
  // fail open — the exception list is the reviewed escape for those.
  const allowed = license
    .replace(/[()]/g, '')
    .split(/\s+AND\s+/i)
    .every((part) => part.split(/\s+OR\s+/i).some((b) => ALLOWED.has(b.trim())))
  if (allowed) continue
  for (const p of pkgs) {
    if (exceptions.has(p.name)) continue
    errs.push(`${p.name}@${(p.versions ?? []).join(',')} — license "${license}" not in allowlist`)
  }
}

failures(
  GATE,
  errs,
  'Either replace the dependency, or (human decision) add it to tools/license-exceptions.json with a reason.',
)
recordGreen()
ok(
  GATE,
  'production dependency licenses all within the allowlist; the artifact declares its license and is citable (CITATION.cff in version/license lockstep)',
)
