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
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { CONFIG_COMMIT, ESCAPE_LISTS } from './lib/enforcement-surface.mjs'
import { walkFiles } from './lib/fs-walk.mjs'
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

// RAMPED ADDITIONS (0.3.0) — the enforcement CONFIGS the surface never reached.
//
// SURFACE covered the gate scripts, the hooks, the settings file and the workflows: the
// code. It never covered the files that decide WHETHER that code runs and HOW STRICTLY.
// `lefthook.yml` is the entire commit-time layer. `.mcp.json` is which MCP servers this
// project starts. `.gitleaks.toml` is what the credential scanner looks for. `renovate.json`
// is whether dependency bumps stay pinned and cooled-down. The actionlint/zizmor configs
// decide how hard the workflow-lint lanes look at the workflows the surface DOES hash.
//
// Each is harness-owned and none of them is a threshold a project legitimately tunes per
// feature — which is exactly what separates this list from CONFIG_COMMIT below.
const RAMPED_SURFACE_030 = [
  /^\.mcp\.json$/,
  /^lefthook\.yml$/,
  /^\.gitleaks\.toml$/,
  /^renovate\.json$/,
  /^\.github\/actionlint\.yaml$/,
  /^\.github\/zizmor\.yml$/,
]
const SURFACE_RAMP_030 = '0.3.0'

// CONFIG_COMMIT (tools/lib/enforcement-surface.mjs) is judged by COMMIT rather than by
// hash, and the reason is the reason CODEOWNERS is not hash-pinned either: human tuning is
// LEGITIMATE here. Raising a coverage floor, adding an eslint rule, tightening a tsconfig
// are correct acts a project performs, and a pin guaranteed to break on correct use is a
// gate everyone learns to ignore. What is NOT legitimate is an agent widening one mid-turn
// to buy itself a green run — so the invariant is the one the escape lists already use:
// the file may DIFFER from the template, but it may not be DIRTY at gate time.

// tsconfig*.json wherever it lives. The root pair carries the max-strict compiler surface
// every workspace extends, but a per-workspace `"strict": false` is not caught by `tsc -b`
// — it simply typechecks that package laxly and stays green — so the whole set is covered.
function tsconfigPaths() {
  const roots = ['.', 'apps', 'packages']
  const found = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const rel of walkFiles(root, {
      // `.git` is excluded for robustness, not just speed: a background auto-gc
      // (which `git commit` detaches) prunes object directories mid-walk, and the
      // readdir-then-scandir race crashed this gate in CI on a tree nobody touched.
      // No tsconfig lives under VCS or stack runtime state.
      excludeDirs: new Set([
        'node_modules',
        'dist',
        'gen',
        '.next',
        '.expo',
        'android',
        'ios',
        '.git',
        '.temp',
      ]),
    })) {
      if (!/(^|\/)tsconfig[^/]*\.json$/.test(rel)) continue
      found.push(root === '.' ? rel : `${root}/${rel}`)
    }
  }
  // The '.' walk already yields apps/**/tsconfig*.json and packages/**/tsconfig*.json;
  // the explicit roots exist only so a tree without them still resolves. Dedupe.
  return [...new Set(found)]
}

// The escape hatches and the threshold-bearing configs are REVIEWED DATA shared with
// tools/check-wiring.mjs (which asks a different question of the same list: is each path
// covered by a CODEOWNERS rule with a real owner). One definition, in tools/lib — a second
// hand-maintained copy would drift, and the drift would be invisible.

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
  { until: '0.4.0' },
)
const surfaceRamped030 = rampNote(
  GATE,
  SURFACE_RAMP_030,
  'hash coverage of the enforcement configs (.mcp.json, lefthook.yml, .gitleaks.toml, renovate.json, actionlint/zizmor) and the commit-not-dirty rule over the threshold-bearing configs',
  { until: '0.5.0' },
)
const rampedFindings = []
const ramped030Findings = []

for (const [ip, meta] of Object.entries(manifest.files ?? {})) {
  if (meta?.mode !== 'owned') continue // config + seeded are human-tunable by design
  if (SURFACE_EXCLUDE.some((re) => re.test(ip))) continue // generated FROM the project's code
  const core = SURFACE.some((re) => re.test(ip))
  const ramped = !core && RAMPED_SURFACE.some((re) => re.test(ip))
  const ramped030 = !core && !ramped && RAMPED_SURFACE_030.some((re) => re.test(ip))
  if (!core && !ramped && !ramped030) continue
  const into =
    ramped && surfaceRamped
      ? rampedFindings
      : ramped030 && surfaceRamped030
        ? ramped030Findings
        : errs
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
for (const f of ramped030Findings) {
  console.log(`${GATE}: NOTE — (ramp ${SURFACE_RAMP_030}) ${f}`)
}

// A manifest that records zero owned enforcement files is itself mangled — a
// gate that verifies nothing must never read as green.
if (checked === 0) {
  fail(GATE, `${MANIFEST} records no harness-owned enforcement files — restore it from git history`)
}

// ── 1a. RETROFIT CONFLICTS ARE EVIDENCE (0.3.0) ──────────────────────────────────
// A retrofit keeps the target's config and parks the harness version in a sidecar. That is
// the right call — never clobber a human's configuration — but until 0.3.0 the installer
// `continue`d BEFORE the manifest line, so the state was invisible to everything
// afterwards. The consequence was specific: `lint`, `types`, `dead-code`, `architecture`
// and the coverage floors ran against the TARGET's configs, with zero harness rules in
// them, and reported green. The install looked enforced and was not.
//
// This step runs on EVERY install, which is why the check lives here rather than in
// `doctor` (which nothing runs). A reviewed acceptance in tools/retrofit-accept.json
// converts the red into a NOTE — pinned to the exact `theirsSha256` that was reviewed, so
// editing that config afterwards re-opens the question rather than inheriting the
// judgement.
const ACCEPT = 'tools/retrofit-accept.json'
/** @type {Array<{ path?: string, theirsSha256?: string, reason?: string }>} */
let retrofitAccepted = []
if (existsSync(ACCEPT)) {
  try {
    const parsed = JSON.parse(readFileSync(ACCEPT, 'utf8'))
    retrofitAccepted = Array.isArray(parsed.accept) ? parsed.accept : []
  } catch (e) {
    fail(
      GATE,
      `${ACCEPT} is not valid JSON (${e.message}) — an unparseable acceptance file cannot fail open`,
    )
  }
  for (const a of retrofitAccepted) {
    if (typeof a?.reason !== 'string' || a.reason.trim().length < 10) {
      fail(
        GATE,
        `${ACCEPT}: every acceptance needs a real \`reason\` (>= 10 chars) — an empty reason is an acceptance nobody reviewed. Offending entry: ${JSON.stringify(a)}`,
      )
    }
  }
}

const conflictNotes = []
for (const [ip, meta] of Object.entries(manifest.files ?? {})) {
  if (meta?.mode !== 'conflicted') continue
  const theirsNow = existsSync(ip)
    ? createHash('sha256').update(readFileSync(ip)).digest('hex')
    : null
  const accepted = retrofitAccepted.find(
    (a) => a.path === ip && (a.theirsSha256 === undefined || a.theirsSha256 === theirsNow),
  )
  const detail =
    `${ip}: RETROFIT CONFLICT — this install kept the target's file and parked the harness version at ${meta.sidecar ?? '(unrecorded)'}. ` +
    "Until the two are merged, every gate that reads this config is judging the TARGET's rules, not the harness's, and reporting green either way. " +
    `Merge it: diff \`${ip}\` against \`${meta.sidecar ?? '<sidecar>'}\`, fold the harness rules in, delete the sidecar, and re-run \`npx next-expo-supabase-agent-harness update\` so the manifest re-records the file as owned. ` +
    `To accept the divergence instead, add {"path":"${ip}","theirsSha256":"${theirsNow ?? '<sha>'}","reason":"…"} to ${ACCEPT} and COMMIT it — the sha pins the acceptance to the content that was reviewed.`
  if (accepted) conflictNotes.push(`${ip}: accepted divergence — ${accepted.reason}`)
  else errs.push(detail)
}
for (const n of conflictNotes) console.log(`${GATE}: NOTE — ${n}`)

// ── 1b. the hooks are wired BY VALUE, not by having a file on disk ───────────────
// Hashing .claude/settings.json proves its BYTES are what the installer wrote. It does
// not prove those bytes still WIRE anything, because a legitimately-tuned settings file
// (a new permission, a new MCP server) re-records its hash on the next `update` and the
// gate is green either way. Two failures lived in that gap:
//
//   1. Until 0.3.0 every hook command was a BARE PATH relying on the executable bit, and
//      this gate hashes CONTENT and never MODE — so `chmod -x` on the Stop hook disarmed
//      the turn gate while every sha256 still matched. 0.3.0 deletes the vulnerability
//      rather than detecting it: each command now invokes `node` explicitly, so the bit
//      is not in the trust path at all. (A mode check would also have had to skip on
//      win32, where there is no exec bit — and a skip that is never a pass is a skip that
//      cannot be written for a property half the platforms do not have.)
//   2. A command rewritten to `true`, or pointed at a path that does not exist, is a
//      wired-looking hook that runs nothing.
//
// So the assertion is over the VALUE: every command names `node` and an existing file.
// The roster question — which hooks must be present at all — belongs to the `wiring`
// gate, which owns the whole doctor-invariant surface.
// SOURCE: docs/harness/README.md (tamper evidence) [corpus: harness/doctrine]
const SETTINGS = '.claude/settings.json'
if (existsSync(SETTINGS)) {
  let settings
  try {
    settings = JSON.parse(readFileSync(SETTINGS, 'utf8'))
  } catch (e) {
    fail(GATE, `${SETTINGS} is not valid JSON (${e.message}) — restore it from git history`)
  }
  const commands = Object.entries(settings.hooks ?? {}).flatMap(([event, groups]) =>
    (Array.isArray(groups) ? groups : []).flatMap((g) =>
      (Array.isArray(g?.hooks) ? g.hooks : []).map((h) => [event, String(h?.command ?? '')]),
    ),
  )
  for (const [event, command] of commands) {
    // The canonical shape the installer writes: node "<$CLAUDE_PROJECT_DIR-rooted path>".
    const m = /^node\s+"?\$CLAUDE_PROJECT_DIR\/([^"\s]+)"?\s*$/.exec(command)
    if (m === null) {
      errs.push(
        `${SETTINGS}: the ${event} hook command ${JSON.stringify(command)} is not \`node "$CLAUDE_PROJECT_DIR/<path>"\` — a hook that does not invoke node explicitly depends on the executable bit, which nothing in this repo hashes, and a command rewritten to anything else is a wired-looking hook that runs nothing.`,
      )
      continue
    }
    if (!existsSync(m[1])) {
      errs.push(
        `${SETTINGS}: the ${event} hook command points at ${m[1]}, which does not exist — the hook is wired to nothing.`,
      )
    }
  }
}

// ── 1c. the Stop chain still contains its frozen floor ───────────────────────────
// harness.config.mjs is manifest mode `config`, and the loop above skips every non-`owned`
// entry — so STOP_HOOK_STEPS, the list of checks that decide whether a TURN may end, was
// hashed by nothing at all. Deleting `test-quality` or `diff-coverage` from it mid-turn
// ended the turn green with this gate printing OK, because a `config` file is human-tunable
// by design and that is exactly the right rule for a file projects extend.
//
// The floor resolves the tension without changing the file's mode: tools/stop.floor.json is
// `owned`, so it is hashed above like every other tools/ file, and the invariant here is a
// SUPERSET one. A project may APPEND a step; it may not subtract one, and it may not
// rewrite a floor step's command into something weaker.
// SOURCE: docs/harness/README.md (the CI floor; tamper evidence) [corpus: harness/doctrine]
const STOP_FLOOR = 'tools/stop.floor.json'
const CONFIG = 'tools/harness.config.mjs'
if (existsSync(STOP_FLOOR) && existsSync(CONFIG)) {
  let floorSteps = null
  try {
    floorSteps = JSON.parse(readFileSync(STOP_FLOOR, 'utf8'))?.steps
  } catch (e) {
    errs.push(`${STOP_FLOOR} is not valid JSON (${e.message}) — restore it from git history`)
  }
  if (Array.isArray(floorSteps)) {
    try {
      const { STOP_HOOK_STEPS } = await import(pathToFileURL(resolve(CONFIG)).href)
      const local = new Map(
        (Array.isArray(STOP_HOOK_STEPS) ? STOP_HOOK_STEPS : []).map(([n, c]) => [n, c]),
      )
      for (const [name, cmd] of floorSteps) {
        if (!local.has(name)) {
          errs.push(
            `${CONFIG}: STOP_HOOK_STEPS is missing the floored step '${name}' (${cmd}). The Stop chain has a frozen floor in ${STOP_FLOOR}: a project may APPEND steps, never subtract them. The Stop hook runs it anyway via the union, so this is evidence, not a hole — restore the step.`,
          )
        } else if (local.get(name) !== cmd) {
          errs.push(
            `${CONFIG}: STOP_HOOK_STEPS['${name}'] runs ${JSON.stringify(local.get(name))} but the frozen floor pins ${JSON.stringify(cmd)}. Rewriting a floored command is how a step stays in the list and stops checking anything.`,
          )
        }
      }
    } catch (e) {
      errs.push(`${CONFIG} failed to import (${e.message}) — the Stop chain cannot be verified`)
    }
  }
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
//
// ONE THING IS NOT A WIDENING: the file the harness itself just planted. `update` plants
// a new escape list into an existing install (0.3.0 does it with tools/approved-tools.json,
// and 0.2.x did it with tenancy.json / db-limits.json / security-headers.json), which
// leaves it UNTRACKED — and the rule above then accuses the consumer of widening a hatch
// they have never seen, on the very run that delivered it. Found by upgrade-lane.sh, which
// is the second time this release that the lane caught the harness redding an install for
// the harness's own act; the first was `docs-sync`, and the fix is the same shape:
// CLASSIFY, do not blanket-ramp. The discriminator is exact and holds at every vintage —
// untracked AND byte-identical to the sha the installer recorded when it wrote the file
// means nobody has tuned it yet. A hand-created escape list has no manifest entry and a
// tuned one no longer matches, so both keep the hard red they had before.
const present = ESCAPE_LISTS.filter((p) => existsSync(p))
if (hasGit && present.length > 0 && process.env.HARNESS_ALLOW_SELF_EDIT !== '1') {
  // Ask per path rather than parsing porcelain status columns — the path is then the one
  // we already hold, so no slicing can mangle it and a path with spaces cannot confuse us.
  for (const p of present) {
    const status = git(`status --porcelain -- ${p}`)
    if (!status) continue // empty output = clean (or untracked-but-ignored)
    if (isUntouchedPlant(p, status)) {
      console.log(
        `${GATE}: NOTE — ${p} is present but not yet committed, and its bytes are exactly what the installer planted. ` +
          'That is a harness plant, not a widening, so it is not a finding — commit it along with the rest of the upgrade.',
      )
      continue
    }
    errs.push(
      `${p}: escape hatch modified but not committed. Exempting code from a gate or raising a budget is a REVIEWED act — ` +
        'commit it so the widening appears in the PR diff under CODEOWNERS (or export HARNESS_ALLOW_SELF_EDIT=1 for a deliberate local edit).',
    )
  }
}

/**
 * Is this dirty escape list one the installer planted and nobody has touched since?
 * Both halves are required: untracked (so there is no prior committed version a diff
 * could review) AND byte-identical to the installer's recorded hash (so it carries no
 * exemption a human chose). Either alone is not enough — an untracked file a human wrote
 * by hand is a widening with no diff, and a tracked-but-modified one is the original case.
 * @param {string} p @param {string} status porcelain output for exactly this path
 * @returns {boolean}
 */
function isUntouchedPlant(p, status) {
  if (!status.startsWith('??')) return false
  return matchesRecordedHash(p)
}

/**
 * Byte-identical to what the installer recorded for this path in the manifest.
 *
 * The manifest is rewritten by `init`/`update` and by nothing else, so a match means the
 * bytes on disk are the ones the HARNESS last wrote — no human has tuned them since. That
 * is the fact both dirty-file rules actually turn on, in opposite directions: an escape
 * list matching its record carries no exemption anybody chose, and a threshold config
 * matching its record carries no threshold anybody moved.
 * @param {string} p @returns {boolean}
 */
function matchesRecordedHash(p) {
  const recorded = /** @type {Record<string, {sha256?: string}>} */ (manifest.files ?? {})[p]
    ?.sha256
  if (typeof recorded !== 'string') return false
  return createHash('sha256').update(readFileSync(p)).digest('hex') === recorded
}

// ── 3b. the same rule for the threshold-bearing configs (0.3.0) ──────────────────
// Two tiers, split by whether human tuning is legitimate — see CONFIG_COMMIT's header.
// These files carry the NUMBERS the gates judge against (coverage floors, the complexity
// ceiling, the architecture rules, the strictness surface), and a project raises them for
// real reasons. So they are not hash-pinned; the invariant is that the raise must be a
// COMMIT, not an agent's mid-turn edit. Ramped with the 0.3.0 surface additions, because
// an install upgrading mid-branch with a legitimately dirty vitest.config.ts should get a
// release to adopt the habit rather than a red on the update that shipped it.
const configCommitPaths = [...CONFIG_COMMIT, ...tsconfigPaths()].filter((p) => existsSync(p))
let configCommitSummary = `${String(configCommitPaths.length)} threshold config(s) committed`
if (hasGit && configCommitPaths.length > 0 && process.env.HARNESS_ALLOW_SELF_EDIT !== '1') {
  const dirty = []
  for (const p of configCommitPaths) {
    if (!git(`status --porcelain -- ${p}`)) continue
    // A file `update` JUST REWROTE is not a widening — it is the upgrade, and the consumer
    // has not touched it. vitest.config.ts and eslint.config.mjs are harness-OWNED, so any
    // release that changes them leaves this rule accusing the install of "modifying" a file
    // the harness modified, on the very run that delivered it. Found by the upgrade lane,
    // and it is the same shape as the escape-list plant discriminator above: the manifest is
    // written by init/update alone, so bytes matching the recorded hash mean nobody has
    // tuned them since. A hand-tuned config no longer matches and keeps its finding.
    if (matchesRecordedHash(p)) {
      console.log(
        `${GATE}: NOTE — ${p} differs from the last commit but is byte-identical to what the installer recorded, so it is a harness refresh rather than a tuned threshold. Commit it along with the rest of the upgrade.`,
      )
      continue
    }
    dirty.push(
      `${p}: threshold-bearing config modified but NOT COMMITTED. This file carries numbers the gates judge against (coverage floors, the complexity ceiling, the architecture rules, the strictness surface) — lowering one turns a red into a green with no other trace. Raising a threshold is legitimate and stays green forever once REVIEWED: commit the change so it lands in the PR diff under CODEOWNERS (or export HARNESS_ALLOW_SELF_EDIT=1 for a deliberate local edit).`,
    )
  }
  if (dirty.length > 0) {
    if (surfaceRamped030) {
      for (const d of dirty) console.log(`${GATE}: NOTE — (ramp ${SURFACE_RAMP_030}) ${d}`)
      configCommitSummary = `threshold-config commit rule NOTE-only (${String(dirty.length)} dirty, withheld by the ${SURFACE_RAMP_030} ramp)`
    } else {
      errs.push(...dirty)
    }
  }
}

failures(
  GATE,
  errs,
  'Restore the file(s) from git; if the change came from a sanctioned harness upgrade, re-run `npx next-expo-supabase-agent-harness update` (it re-records the hashes).',
)
ok(
  GATE,
  `${checked} harness-owned enforcement file(s) match their recorded hashes; baseVersion ${currentBase} never regressed; ${present.length} escape list(s) clean; ${configCommitSummary}`,
)
