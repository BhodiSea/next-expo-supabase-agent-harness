#!/usr/bin/env node
// Gate: gate-integrity — the enforcement surface on disk still matches the sha256
// hashes .harness/manifest.json recorded at install/update time, so a raw write
// that slipped past the write-guard hook (shell redirection, sed -i, an external
// editor) into a gate script, hook, or the settings surface reds the very next
// validate run. Scope: manifest entries that are harness-OWNED and inside the
// gate surface (tools/, .claude/hooks/, .claude/settings.json, .github/workflows/,
// the RLS and migration runners). 'config' entries are skipped — they are
// human-tunable, and `update` re-records their hashes on sanctioned changes.
//
// Three sub-checks, because the manifest cannot be its own root of trust:
//   1. owned-file hashes      — the surface matches what the installer wrote
//   2. baseVersion monotonic  — the version-ramp bar can never be rolled BACK
//   3. escape lists undirty   — widening a security/budget escape is a reviewed commit
// Static and fast: sha256 recompute + two cheap git reads.
// SOURCE: docs/harness/README.md (tamper evidence) [corpus: harness/doctrine]
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { fail, failures, ok, rampNote, runCmd, skipOrFail } from './lib/gate.mjs'

const GATE = 'gate-integrity'
const MANIFEST = '.harness/manifest.json'

// The enforcement surface (mirrors the write-guard's blanket-protected paths
// wherever the manifest records harness ownership). `.github/workflows/` is here
// because a doctored workflow silently neuters the CI backstop the whole
// tamper-evidence story leans on — the local hooks are the fast path, CI is the
// enforcement, and an unhashed CI lane is an enforcement layer with no evidence.
const SURFACE = [
  /^tools\//,
  /^\.claude\/hooks\//,
  /^\.claude\/settings\.json$/,
  /^\.github\/workflows\//,
  /^tests\/rls\/run-rls\.mjs$/,
]

// The one carve-out from /^tools\//, and it is not a weakening — it is the difference
// between a file the HARNESS wrote and a file the CONSUMER'S CODE wrote.
//
// tools/generated/* is regenerated from the project's own router, event catalogs and
// DALs. Hash-pinning it to the bytes installed at `init` meant the FIRST tRPC procedure
// a consumer added reds this gate as "tampered or hand-edited", with a prescribed remedy
// (`restore it from git`) that undoes their feature. Verified against a real install:
// one regenerated action-inventory.json is enough. A pin that is guaranteed to break on
// correct use is not evidence; it is a gate everyone learns to ignore, and the habit it
// teaches — that a gate-integrity mismatch is routine — is what makes a real mismatch
// invisible.
//
// Nothing is lost. These files are covered better than a hash could: `contracts`
// REGENERATES each one and diffs it on every validate, so a hand-edit that does not
// match what the code actually does reds there (and fails closed in CI), and the
// write-guard denies an agent editing them at all (guard-rules.mjs: 'action-inventory',
// 'query-shapes-manifest'). A hash proves the bytes are old; the regen-diff proves they
// are TRUE, which is the property that matters.
const SURFACE_EXCLUDE = [/^tools\/generated\//]

// RAMPED ADDITIONS (0.2.0). `.claude/rules/` is loaded into every turn — it is the
// always-on statement of the security invariants — and `.claude/statusline.mjs` runs on
// the developer's machine every prompt. Both are as much enforcement surface as a hook.
//
// They are ramped, and this is the single riskiest thing in the release if it is not.
// Their manifest mode is `owned`, so an install that TUNED `security-invariants.md` for
// its own product — an entirely reasonable thing the file invites — reds the instant this
// lands, and the prescribed remedy (`update`, which re-records the hashes) clobbers the
// tuning it was pointing at. The ramp gives those installs a release to converge in; a
// fresh scaffold has no legacy and is covered from day one.
const RAMPED_SURFACE = [/^\.claude\/rules\//, /^\.claude\/statusline\.mjs$/]
const SURFACE_RAMP = '0.2.0'

// The escape hatches: reviewed human data that EXEMPTS code from a gate or RAISES a
// budget. They are 'seeded' (a project tunes them deliberately), so their content is
// not hash-pinned — but a widening must be a reviewable act, not an agent's mid-turn
// edit. Committing one puts it in the PR diff under CODEOWNERS; leaving it dirty in
// the working tree at gate time is how an agent buys itself a green turn.
const ESCAPE_LISTS = [
  'tools/rls-exempt.json', // exempting a table from FORCE RLS — the security one
  'tools/tenancy.json', // the closed predicate-form set + the one seat-writer role
  'tools/security-definer-allow.json', // authorizes EXECUTE-to-authenticated on a definer fn
  'tools/audit-columns.json', // opting a column's VALUES into the audit trail
  'tools/pii-columns.json', // the deny list that opt-in is checked against
  'tools/db-limits.json', // the per-role blast-radius ceilings + the quota trigger shape
  'tools/security-headers.json', // the web response posture, asserted by value
  'tools/rate-limit-budget.json', // raising a budget is raising what one caller may cost everyone
  'tools/db-perf-baseline.json', // the plan-probe floor + budgets — lowering minRows is how a plan probe becomes vacuous
  'tools/provenance-overrides.json', // cross-group citation escapes
  'tools/license-exceptions.json',
  'tools/route-allowlist.json',
  'tools/dto-bounds-allow.json', // exempting a wire string from the .max() bound
  'tools/duplication-allow.json', // accepting a code clone
  'tools/i18n-allow.json', // letting a user-facing string bypass the catalog
  'tools/expo-permissions.json', // granting the app a new platform permission
  'tools/expo-plugins.json', // admitting a config plugin to the native build
  'tools/perf-budget.json',
  'tools/interaction-budget.json',
  'tools/startup-budget.json', // raising a cold-start / per-screen nav ceiling
  'tools/bundle-budget.json',
  'tools/perf-baseline.json',
  'tools/styleguide.manifest.json',
  'tools/mutation-baseline.json', // accepting a surviving mutant
  'tools/test-quality-allow.json', // letting a disabled/assertion-free test stand
]

if (!existsSync(MANIFEST)) skipOrFail(GATE, 'no .harness/manifest.json (not an installed harness)')

let manifest
try {
  manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
} catch (e) {
  fail(
    GATE,
    `${MANIFEST} is not valid JSON (${e.message}) — restore it from git history (do NOT re-run \`init\`)`,
  )
}

const errs = []

// ── 1. the owned enforcement surface still hashes to what was installed ──────────
let checked = 0
// Resolved once: the ramp is a property of the INSTALL, not of each file.
const surfaceRamped = rampNote(
  GATE,
  SURFACE_RAMP,
  'hash coverage of .claude/rules/ and .claude/statusline.mjs',
)
const rampedFindings = []

for (const [ip, meta] of Object.entries(manifest.files ?? {})) {
  if (meta?.mode !== 'owned') continue // config + seeded are human-tunable by design
  if (SURFACE_EXCLUDE.some((re) => re.test(ip))) continue // generated FROM the project's code
  const core = SURFACE.some((re) => re.test(ip))
  const ramped = !core && RAMPED_SURFACE.some((re) => re.test(ip))
  if (!core && !ramped) continue
  const into = ramped && surfaceRamped ? rampedFindings : errs
  checked += 1
  if (!existsSync(ip)) {
    into.push(`${ip}: missing from disk (the manifest records it as harness-owned)`)
    continue
  }
  // RAW bytes — the installer hashes the exact content it writes.
  const current = createHash('sha256').update(readFileSync(ip)).digest('hex')
  if (current !== meta.sha256) {
    into.push(`${ip}: sha256 mismatch against ${MANIFEST} (tampered or hand-edited)`)
  }
}
for (const f of rampedFindings) {
  console.log(`${GATE}: NOTE — (ramp ${SURFACE_RAMP}) ${f}`)
}

// A manifest that records zero owned enforcement files is itself mangled — a
// gate that verifies nothing must never read as green.
if (checked === 0) {
  fail(GATE, `${MANIFEST} records no harness-owned enforcement files — restore it from git history`)
}

// ── git: the only root of trust the manifest itself cannot forge ─────────────────
// The manifest hashes every other file, but nothing hashes the manifest — so its own
// fields (baseVersion above all) were free bytes. Git history is the external record
// an agent cannot rewrite without a force-push, which the bash-guard denies.
/** @param {string} cmd @returns {string | null} */
function git(cmd) {
  try {
    return runCmd(`git ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null // no git, no history, shallow clone, or the path is untracked
  }
}
const hasGit = git('rev-parse --is-inside-work-tree') === 'true'

// ── 2. the version-ramp bar can never be rolled BACK ─────────────────────────────
// rampNote() downgrades a not-yet-graduated check to a NOTE — including in CI. It reads
// baseVersion from the manifest, so a committed rolled-back baseVersion in a newer tree
// would disarm every ramped check ON THE PR, with every gate green. A legitimate install
// only ever moves baseVersion FORWARD (init stamps it; update preserves it; graduation
// raises it). Monotonicity is therefore the invariant, and git is what makes it checkable.
/** @param {string} a @param {string} b @returns {number} */
function cmpDotted(a, b) {
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
/** @param {unknown} m @returns {string | null} */
const baseOf = (m) => {
  if (!m || typeof m !== 'object') return null
  const v =
    /** @type {Record<string, unknown>} */ (m).baseVersion ??
    /** @type {Record<string, unknown>} */ (m).harnessVersion
  return typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v) ? v : null
}

const currentBase = baseOf(manifest)
if (!currentBase) {
  fail(
    GATE,
    `${MANIFEST} carries no usable baseVersion/harnessVersion — the version ramp cannot fail open; restore it from git history`,
  )
}

if (hasGit) {
  // Every revision of the manifest, newest first. It changes only on init/update/
  // graduation, so this list is short (bounded anyway, so a long-lived repo stays fast).
  const revs = (git(`log --format=%H --max-count=50 -- ${MANIFEST}`) ?? '')
    .split('\n')
    .filter(Boolean)
  let newest = currentBase
  for (const rev of revs) {
    const raw = git(`show ${rev}:${MANIFEST}`)
    if (!raw) continue
    let past
    try {
      past = JSON.parse(raw)
    } catch {
      continue // a historically-corrupt manifest is not this gate's problem
    }
    const pastBase = baseOf(past)
    if (!pastBase) continue
    if (cmpDotted(newest, pastBase) < 0) {
      errs.push(
        `${MANIFEST}: baseVersion went BACKWARDS (${pastBase} at ${rev.slice(0, 8)} -> ${newest} now). ` +
          'Lowering baseVersion re-arms the version ramp and silently downgrades live gates to advisory NOTEs — in CI too. ' +
          'A legitimate install only moves it forward (docs/runbooks/harness-upgrade.md).',
      )
      break
    }
    newest = pastBase // walk back through history keeping the newest-so-far
  }
}

// ── 3. widening an escape hatch is a reviewed commit, never a working-tree edit ───
// These files are the gate's own escape hatches — one appended entry in rls-exempt.json
// makes an owner-less table pass schema-rls, and the runtime RLS suite never probes it.
// They are 'seeded' so they are NOT hash-pinned (a project tunes them), which left the
// widening entirely un-evidenced. The invariant that respects both facts: an escape list
// may differ from the template, but it may not be DIRTY at gate time — commit it and the
// widening lands in the PR diff under CODEOWNERS.
const present = ESCAPE_LISTS.filter((p) => existsSync(p))
if (hasGit && present.length > 0 && process.env.HARNESS_ALLOW_SELF_EDIT !== '1') {
  // Ask per path rather than parsing porcelain status columns — the path is then the one
  // we already hold, so no slicing can mangle it and a path with spaces cannot confuse us.
  for (const p of present) {
    if (!git(`status --porcelain -- ${p}`)) continue // empty output = clean (or untracked-but-ignored)
    errs.push(
      `${p}: escape hatch modified but not committed. Exempting code from a gate or raising a budget is a REVIEWED act — ` +
        'commit it so the widening appears in the PR diff under CODEOWNERS (or export HARNESS_ALLOW_SELF_EDIT=1 for a deliberate local edit).',
    )
  }
}

failures(
  GATE,
  errs,
  'Restore the file(s) from git; if the change came from a sanctioned harness upgrade, re-run `npx next-expo-supabase-agent-harness update` (it re-records the hashes).',
)
ok(
  GATE,
  `${checked} harness-owned enforcement file(s) match their recorded hashes; baseVersion ${currentBase} never regressed; ${present.length} escape list(s) clean`,
)
