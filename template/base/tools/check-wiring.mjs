#!/usr/bin/env node
// Gate: wiring — the enforcement layers are actually CONNECTED to this project.
//
// WHY THIS GATE EXISTS. Five load-bearing invariants had exactly one check between them —
// `installer doctor` — and NOTHING RAN IT. Not the Stop chain, not a validate step, not a
// CI lane; `doctor` is a command a human types, and a control whose only trigger is a
// human remembering is not a control. So an install could carry every gate script, pass
// every hash, and still have: a hook unwired, `pnpm validate` redefined to something that
// is not the gate, a CLAUDE.md that silently replaced the project memory, an
// enforcement-surface path no CODEOWNERS rule covers, and `defaultMode:
// "bypassPermissions"` — with the whole 31-step chain green, because no step was looking.
//
// Placed at step 3, directly after `gate-integrity`: integrity proves the enforcement
// FILES are the ones the harness wrote; this proves they are WIRED. Both must be true
// before any gate's verdict means anything, and both are static and fast (~15ms).
//
// Everything here is judged BY VALUE against reviewed data (tools/lib/enforcement-surface.mjs,
// tools/stop.floor.json, tools/validate.floor.json), never against a hand-copied list.
// SOURCE: docs/harness/README.md (the three enforcement layers) [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'
import { VALIDATE_STEPS } from './harness.config.mjs'
import {
  CONFIG_COMMIT,
  ESCAPE_LISTS,
  SURFACE_FILES,
  SURFACE_PREFIXES,
} from './lib/enforcement-surface.mjs'
import { walkFiles } from './lib/fs-walk.mjs'
import { failures, ok, rampNote, skipOrFail } from './lib/gate.mjs'

const GATE = 'wiring'
const errs = []
const notes = []

// The six shipped hooks. A missing entry is not a degraded posture — it is that whole
// event unguarded, which is precisely how `mcp__` tool calls reached the database for
// three releases while docs/security/approved-tools.md declared default-deny.
const SHIPPED_HOOKS = [
  'pretool-bash-guard',
  'pretool-write-guard',
  'pretool-mcp-guard',
  'posttool-fast-check',
  'posttool-source-check',
  'stop-validate-gate',
]

const SETTINGS = '.claude/settings.json'
if (!existsSync(SETTINGS)) {
  skipOrFail(GATE, `${SETTINGS} not found (not an installed harness)`)
}

let settings
try {
  settings = JSON.parse(readFileSync(SETTINGS, 'utf8'))
} catch (e) {
  failures(GATE, [
    `${SETTINGS} is not valid JSON (${e.message}) — it is write-guard-protected, so an unparseable settings file is tampering. Restore it from git history.`,
  ])
}

// ── 1. every shipped hook is wired ───────────────────────────────────────────────
const hookText = JSON.stringify(settings.hooks ?? {})
for (const hook of SHIPPED_HOOKS) {
  if (!hookText.includes(hook)) {
    errs.push(
      `${SETTINGS} no longer wires ${hook} — that entire tool surface runs unguarded. Restore it with \`npx next-expo-supabase-agent-harness update\`.`,
    )
  }
}

// ── 2. PERMISSION POSTURE — a hard red, and the sharpest check in this gate ──────
// `bypassPermissions` turns off the permission model wholesale: every deny rule in the
// settings file stops applying, which includes the ones protecting .claude/hooks/**, the
// settings file itself, and .env reads. `disableBypassPermissionsMode: "disable"` is what
// makes the mode unreachable. A retrofit deliberately KEEPS the target's posture scalars
// (never ambush a human's permission choice) — but keeping theirs and then CLAIMING
// enforcement over it are different things, and this is where the claim is refused.
const perms = settings.permissions ?? {}
if (perms.disableBypassPermissionsMode !== 'disable') {
  errs.push(
    `${SETTINGS}: permissions.disableBypassPermissionsMode is ${JSON.stringify(perms.disableBypassPermissionsMode)}, not "disable". Without it, bypassPermissions mode is reachable — and in that mode every deny rule in this file stops applying, including the ones protecting .claude/hooks/**, the settings file itself, and .env reads. The harness cannot claim enforcement over a session that can switch it off.`,
  )
}
if (perms.defaultMode === 'bypassPermissions') {
  errs.push(
    `${SETTINGS}: permissions.defaultMode is "bypassPermissions" — every session starts with the permission model off. Use "acceptEdits" (the harness default): the write-guard hook, not the prompt, is what stops a bad write.`,
  )
}

// ── 3. `pnpm validate` still runs the gate ──────────────────────────────────────
// Script indirection is the tamper hole harness.config.mjs's own header documents: an
// agent redefining "validate" to `true` in package.json passes a hollow gate. The Stop
// hook already invokes the runner directly for that reason; this closes the other half,
// where a HUMAN types `pnpm validate` and believes the answer.
try {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const v = pkg.scripts?.validate ?? pkg.scripts?.['harness:validate']
  if (typeof v !== 'string' || !v.includes('tools/validate.mjs')) {
    errs.push(
      `package.json: the \`validate\` script is ${JSON.stringify(v ?? null)} and does not run tools/validate.mjs. \`pnpm validate\` is what humans and CI type; if it no longer runs the gate, every "validate is green" claim in a PR is about something else.`,
    )
  }
} catch (e) {
  errs.push(`package.json is unreadable (${e.message})`)
}

// ── 4. CLAUDE.md stays a pure `@AGENTS.md` include ──────────────────────────────
// Two memory files that can disagree is one memory file plus a decoy. docs-sync asserts
// the same thing later in the chain; it is here too because this gate runs at step 3 and
// the agent surface is the layer everything else is read through.
if (existsSync('CLAUDE.md') && readFileSync('CLAUDE.md', 'utf8').trim() !== '@AGENTS.md') {
  errs.push(
    'CLAUDE.md is no longer a pure `@AGENTS.md` include — project memory belongs in AGENTS.md, and two files that can disagree is one file plus a decoy.',
  )
}

// ── 5. the chain still contains its frozen floor ────────────────────────────────
// The in-scaffold expression of doctor's `requiredConfigSteps` check. doctor reads
// template/migrations.json, which exists only in the INSTALLER — a scaffold does not
// carry it, so a gate running inside the project cannot ask that question in those terms.
// tools/validate.floor.json is the same claim in data the scaffold does have: it IS the
// list of steps the harness requires, frozen, and `update`'s configSteps injection is
// what keeps it satisfiable. (STOP_HOOK_STEPS ⊇ stop.floor.json is gate-integrity's.)
const FLOOR = 'tools/validate.floor.json'
if (existsSync(FLOOR)) {
  try {
    const floor = JSON.parse(readFileSync(FLOOR, 'utf8'))?.steps
    if (Array.isArray(floor)) {
      const local = new Set(VALIDATE_STEPS.map(([name]) => name))
      for (const [name] of floor) {
        if (!local.has(name)) {
          errs.push(
            `tools/harness.config.mjs: VALIDATE_STEPS is missing the floored step '${name}'. CI merges the floor in via \`--min-floor\`, so the step still runs there — which means a local chain missing it reports green on a turn CI will red. A project may APPEND steps, never subtract them.`,
          )
        }
      }
    }
  } catch (e) {
    errs.push(`${FLOOR} is not valid JSON (${e.message}) — restore it from git history`)
  }
}

// ── 6. parked upgrades are a NOTE, never a red ──────────────────────────────────
// `update` preserves local drift and parks the incoming version under .harness/pending/.
// That is correct behaviour and must not fail a build — but parked FOREVER is how an
// upgrade silently stops reaching a project, so it stays named on every run.
const parked = walkFiles('.harness/pending')
if (parked.length > 0) {
  notes.push(
    `${String(parked.length)} parked upgrade(s) awaiting a human merge under .harness/pending/ (${parked.slice(0, 5).join(', ')}${parked.length > 5 ? ', …' : ''}) — reconcile each into its real path, then delete the parked copy.`,
  )
}

// ── 7. the commit-time layer is INSTALLED, not merely committed ─────────────────
if (existsSync('.git') && existsSync('lefthook.yml')) {
  const preCommit = '.git/hooks/pre-commit'
  const installed = existsSync(preCommit) && readFileSync(preCommit, 'utf8').includes('lefthook')
  if (!installed) {
    notes.push(
      'lefthook is not installed into .git/hooks — the commit-time layer is DORMANT on this machine even though lefthook.yml is committed. Run `pnpm install` (the prepare script) or `pnpm exec lefthook install`.',
    )
  }
}

// ── 8. CODEOWNERS COVERAGE — the compensating control ~ten gates cite by name ────
//
// Escape-list widenings, seeded-data edits and every "reviewed human act" in this repo end
// with "…so it lands in the PR diff under CODEOWNERS". Until 0.3.0 nothing checked that
// CODEOWNERS covered those paths — or that it existed. A rule can also silently disable
// review by naming a path with NO owners, which is valid CODEOWNERS syntax and reads, to a
// human skimming the file, exactly like a rule.
//
// Deliberately NOT hash-pinned in gate-integrity: adding a team or moving a directory are
// correct acts, and a pin guaranteed to break on correct use is a gate everyone learns to
// ignore. Coverage is the property that survives legitimate use.
//
// PARSED CONSERVATIVELY, per the release's own rule: red only on the two unambiguous
// cases — no matching rule at all, and a matching rule with an empty owner list. Anything
// this subset cannot decide is a NOTE, because a false red here teaches people to delete
// the check.
const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']
const codeownersPath = CODEOWNERS_PATHS.find((p) => existsSync(p))

/**
 * One CODEOWNERS line -> a matcher. Subset of the gitignore-style grammar GitHub uses:
 * a leading `/` anchors at the repo root, `**` crosses directories, `*` does not, and a
 * trailing `/` means the subtree. Anything with a character class or a `?` is reported as
 * UNPARSED rather than guessed at.
 * @param {string} pattern
 * @returns {{ re: RegExp } | null}
 */
function patternToRegExp(pattern) {
  if (/[[\]?]/.test(pattern)) return null
  const anchored = pattern.startsWith('/')
  let body = anchored ? pattern.slice(1) : pattern
  const dirOnly = body.endsWith('/')
  if (dirOnly) body = body.slice(0, -1)
  // Single-pass, so `**` and `*` are decided in one scan: a two-pass replace needs a
  // sentinel, and any sentinel is a byte that can appear in a real pattern.
  const escaped = body.replace(/[\\.+()|^$]|\*\*|\*/g, (m) => {
    if (m === '**') return '.*'
    if (m === '*') return '[^/]*'
    return `\\${m}`
  })
  // A pattern with no slash matches at any depth (gitignore semantics); an anchored or
  // slash-bearing one matches from the root. Either way a directory match covers its
  // whole subtree.
  const head = anchored || body.includes('/') ? '^' : '^(?:.*/)?'
  return { re: new RegExp(`${head}${escaped}(?:/.*)?$`) }
}

let ownersSummary = 'no CODEOWNERS file (skipped)'
if (codeownersPath === undefined) {
  errs.push(
    'no CODEOWNERS file (.github/CODEOWNERS) — ~ten gate failure messages in this harness promise that a widening "lands in the PR diff under CODEOWNERS". Without the file that promise is prose. The harness ships one; restore it with `npx next-expo-supabase-agent-harness update`.',
  )
} else {
  /** @type {Array<{ raw: string, pattern: string, owners: string[], re: RegExp | null, line: number }>} */
  const rules = []
  const unparsed = []
  const lines = readFileSync(codeownersPath, 'utf8').split('\n')
  lines.forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) return
    const [pattern, ...owners] = line.split(/\s+/)
    const compiled = patternToRegExp(pattern)
    if (compiled === null) unparsed.push(`${codeownersPath}:${String(i + 1)} ${pattern}`)
    rules.push({ raw: line, pattern, owners, re: compiled?.re ?? null, line: i + 1 })
  })
  if (unparsed.length > 0) {
    notes.push(
      `${String(unparsed.length)} CODEOWNERS pattern(s) use syntax this gate does not parse and were NOT judged: ${unparsed.join(', ')}. Coverage over them is unverified.`,
    )
  }

  // Every path whose review this harness promises. The escape lists and threshold configs
  // come from the same reviewed data check-gate-integrity judges, so a file added there is
  // covered here the same day rather than the day someone remembers.
  const mustCover = [
    ...ESCAPE_LISTS,
    ...CONFIG_COMMIT,
    ...SURFACE_FILES,
    // A prefix is probed at a representative path inside it: CODEOWNERS matches paths,
    // not directories, so `tools/` is asked as `tools/<a file>`.
    ...SURFACE_PREFIXES.map((p) => `${p}probe`),
  ]

  const uncovered = []
  const ownerless = []
  for (const path of [...new Set(mustCover)]) {
    // GitHub semantics: the LAST matching rule wins, including when it has no owners.
    const match = [...rules].reverse().find((r) => r.re?.test(path))
    if (match === undefined) {
      uncovered.push(path)
    } else if (match.owners.length === 0) {
      ownerless.push(
        `${path} (matched by ${codeownersPath}:${String(match.line)} \`${match.pattern}\`, which names NO owner)`,
      )
    }
  }
  if (uncovered.length > 0) {
    errs.push(
      `${codeownersPath} covers no rule for ${String(uncovered.length)} enforcement path(s): ${uncovered.join(', ')}. Each is a surface a gate's failure message promises is reviewed. Add a rule (a catch-all \`*\` owner counts).`,
    )
  }
  if (ownerless.length > 0) {
    errs.push(
      `${codeownersPath} matches ${String(ownerless.length)} enforcement path(s) with a rule that names NO OWNER, which is valid syntax that SILENTLY DISABLES review for them while reading, to a human skimming the file, exactly like a rule: ${ownerless.join('; ')}`,
    )
  }
  ownersSummary = `${codeownersPath}: ${String(rules.length)} rule(s) cover ${String(mustCover.length)} enforcement path(s)`
}

for (const n of notes) console.log(`${GATE}: NOTE — ${n}`)

// The whole gate is ramped: an install upgrading into 0.3.0 may legitimately have a
// CODEOWNERS file predating half these paths, or a posture a retrofit deliberately kept.
// It gets a release to converge; a fresh scaffold has no legacy and is covered from day
// one. The ramp is on the FINDINGS, never on the check running.
if (
  errs.length > 0 &&
  rampNote(GATE, '0.3.0', `${String(errs.length)} wiring finding(s)`, { until: '0.5.0' })
) {
  for (const e of errs) console.log(`${GATE}: NOTE — (ramp) ${e}`)
  ok(GATE, `${String(errs.length)} finding(s) held as ramp NOTEs; ${ownersSummary}`)
}

failures(
  GATE,
  errs,
  'These are the invariants `doctor` used to be the only check for — and nothing ran doctor. Fix the wiring; do not weaken the gate.',
)
ok(
  GATE,
  `${String(SHIPPED_HOOKS.length)} hooks wired; permission posture held; \`pnpm validate\` runs the gate; CLAUDE.md pure; the frozen floor is present in VALIDATE_STEPS; ${ownersSummary}`,
)
