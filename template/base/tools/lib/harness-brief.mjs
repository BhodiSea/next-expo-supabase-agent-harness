// tools/lib/harness-brief.mjs — the harness brief (1.1.0): one collector, one pure renderer.
//
// WHAT IT IS FOR. An agent that starts or resumes a session learned the install's state by
// running into it: the version and tier are in .harness/manifest.json, parked upgrades in
// .harness/pending/, the blocks a turn spent in the turn ledger, and the reviewers the
// current diff owes only inside the Stop step. The brief puts the four in one place.
// `.claude/hooks/session-brief.mjs` prints it into context on SessionStart, and
// `node tools/harness-status.mjs` prints the same bytes on demand. Both are thin: every rule
// lives here, under the write guard (`tools-lib`) and the gate-integrity hash.
//
// IT IS AN INJECTION SURFACE, so the output is closed, not merely short:
//   - the renderer prints four fields in a fixed order and nothing else;
//   - every value passes a closed validator (versions, tier and mode from closed sets, agent
//     and gate names, repository-relative paths) or prints as `(unprintable)`;
//   - no file content is ever read into the output, only counts, names and paths;
//   - the whole output is capped at BRIEF_CAP characters and cut at a line, with a marker;
//   - a source that cannot be read prints `<field>: unavailable`, and nothing throws.
//
// READ-ONLY. It writes nothing, `.harness/turn.lock` included, so it never calls
// recordTurnOutcome. Paths are CWD-relative, the rule every gate and the Stop hook's
// `.harness/` reads follow; the hook and the CLI both run from the project root.
//
// ONE COMPUTATION PER FIELD, REUSED. The last turn comes from the turn ledger's own pure
// helpers, over EVERY session's records: a new session's id matches none of the earlier
// ones, so scoping by it would read a session that ended red at the cap as green. The owed
// reviewers are the set tools/check-reviewer-verdicts.mjs decides on, from the same libs.
// Each dependency is imported inside its own field, so an unloadable one costs that field.
// SOURCE: docs/harness/README.md (the session-start brief)
import { readFileSync } from 'node:fs'
import process from 'node:process'

/** The ceiling on the whole brief, marker included. */
const BRIEF_CAP = 1200
const CUT_MARKER = `[brief cut at ${String(BRIEF_CAP)} characters]`
/** Entries shown per list; the rest are counted. */
const LIST_MAX = 5
const UNPRINTABLE = '(unprintable)'

const FIELD = {
  install: 'harness',
  parked: 'parked',
  lastTurn: 'last turn in this directory',
  reviewers: 'reviewers owed by the current diff',
}

// ── the closed validators ───────────────────────────────────────────────────────

const VERSION_RE = /^\d+\.\d+\.\d+$/
const TIERS = new Set(['core', 'standard', 'strict'])
const MODES = new Set(['bootstrap', 'retrofit'])
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const PATH_RE = /^[A-Za-z0-9._@+/-]{1,160}$/

/** @param {(v: unknown) => boolean} ok @returns {(v: unknown) => string} */
const printer = (ok) => (v) => (ok(v) ? String(v) : UNPRINTABLE)

const version = printer((v) => typeof v === 'string' && VERSION_RE.test(v))
const tier = printer((v) => typeof v === 'string' && TIERS.has(v))
const mode = printer((v) => typeof v === 'string' && MODES.has(v))
const agentName = printer((v) => typeof v === 'string' && NAME_RE.test(v))
// A gate name, or a hook's `<hook>/<rule>` pair (the SubagentStop hook records its blocks
// as `subagent-verdict/<agent>`): each segment is a name, and there are at most two.
const gateName = printer(
  (v) =>
    typeof v === 'string' && v.split('/').length <= 2 && v.split('/').every((s) => NAME_RE.test(s)),
)
const path = printer(
  (v) => typeof v === 'string' && PATH_RE.test(v) && !v.split('/').includes('..'),
)
const count = printer((v) => Number.isInteger(v) && Number(v) >= 0)

// ── the renderer ────────────────────────────────────────────────────────────────

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** @param {string[]} entries already printable @param {number} total */
function listLines(entries, total) {
  const lines = entries.slice(0, LIST_MAX).map((e) => `  - ${e}`)
  if (total > LIST_MAX) lines.push(`  - … and ${String(total - LIST_MAX)} more`)
  return lines
}

/** @param {unknown} f */
function installLines(f) {
  if (!isObject(f)) return [`${FIELD.install}: unavailable`]
  return [
    `harness ${version(f.harnessVersion)} (base ${version(f.baseVersion)}) · tier ${tier(f.tier)} · mode ${mode(f.mode)}`,
  ]
}

/** @param {unknown} f */
function parkedLines(f) {
  if (!isObject(f) || !Array.isArray(f.paths)) return [`${FIELD.parked}: unavailable`]
  const paths = f.paths
  return [
    `${FIELD.parked}: ${String(paths.length)}`,
    ...listLines(paths.slice(0, LIST_MAX).map(path), paths.length),
  ]
}

/** @param {Record<string, any>} f */
function lastTurnValue(f) {
  if (f.kind === 'none') return 'none recorded'
  if (f.kind === 'green') return 'green'
  if (f.kind === 'blocks') {
    const cap = f.cap === null ? 'off' : count(f.cap)
    return `${count(f.blocks)} consecutive block(s), cap ${cap}`
  }
  if (f.kind === 'cap') {
    const gates = Array.isArray(f.gates) ? f.gates : []
    const shown = gates.slice(0, LIST_MAX).map(gateName).join(', ')
    return `ended red at the cap (${shown}${gates.length > LIST_MAX ? ', …' : ''})`
  }
  return 'unavailable'
}

/** @param {unknown} f */
function lastTurnLines(f) {
  return [`${FIELD.lastTurn}: ${isObject(f) ? lastTurnValue(f) : 'unavailable'}`]
}

/** @param {unknown} f */
function reviewerLines(f) {
  if (!isObject(f) || !Array.isArray(f.owed)) return [`${FIELD.reviewers}: unavailable`]
  const owed = f.owed
  const entries = owed
    .slice(0, LIST_MAX)
    .map((o) => (isObject(o) ? `${agentName(o.agent)} (${path(o.path)})` : UNPRINTABLE))
  return [`${FIELD.reviewers}: ${String(owed.length)}`, ...listLines(entries, owed.length)]
}

/**
 * Lines up to the cap, cut at a line boundary; a cut brief ends in the marker.
 * @param {string[]} lines
 */
function capped(lines) {
  const whole = `${lines.join('\n')}\n`
  if (whole.length <= BRIEF_CAP) return whole
  const room = BRIEF_CAP - CUT_MARKER.length - 1
  let out = ''
  for (const line of lines) {
    if (out.length + line.length + 1 > room) break
    out += `${line}\n`
  }
  return `${out}${CUT_MARKER}\n`
}

/**
 * The brief, as text: four fields in a fixed order, each value validated, capped. Never
 * throws: a field it cannot render prints as unavailable.
 * @param {unknown} fields collectBrief()'s result
 * @returns {string}
 */
export function renderBrief(fields) {
  const f = isObject(fields) ? fields : {}
  const lines = []
  for (const [render, value] of /** @type {const} */ ([
    [installLines, f.install],
    [parkedLines, f.parked],
    [lastTurnLines, f.lastTurn],
    [reviewerLines, f.reviewers],
  ])) {
    try {
      lines.push(...render(value))
    } catch {
      lines.push(render(null)[0])
    }
  }
  return capped(lines)
}

// ── the collector ───────────────────────────────────────────────────────────────

const MANIFEST = '.harness/manifest.json'
const PENDING = '.harness/pending'
const SETTINGS = '.claude/settings.json'
const TRIGGERS = 'tools/reviewer-triggers.json'
// Not parked FILES awaiting a merge: obligations `doctor` classifies apart, as it lists them.
const NOT_PARKED = new Set(['dependencies.json', 'source-fixes.json'])

// The reviewer ledger v2's ramp, as tools/check-reviewer-verdicts.mjs opens it. The step is a
// script that runs on import, so the brief carries the two versions and
// tests/gates/harness-brief.test.mjs holds them equal to the step's rampNote call.
const V2_SINCE = '1.1.0'
const V2_UNTIL = '2.1.0'

/** @param {string} p */
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

/** The install record, or null when it is absent or does not parse to an object. */
function readInstall() {
  try {
    const m = readJson(MANIFEST)
    return isObject(m) ? m : null
  } catch {
    return null
  }
}

/** @param {Record<string, any>|null} manifest */
function installField(manifest) {
  if (manifest === null) return null
  return {
    harnessVersion: manifest.harnessVersion,
    // A manifest written before 0.1.5 has no baseVersion: its seeded content dates from the
    // version that installed it, which is its harnessVersion (installer/lib/manifest.mjs).
    baseVersion: manifest.baseVersion ?? manifest.harnessVersion,
    tier: manifest.tier,
    mode: manifest.mode,
  }
}

async function parkedField() {
  try {
    const { walkFiles } = await import('./fs-walk.mjs')
    return { paths: walkFiles(PENDING).filter((p) => !NOT_PARKED.has(p)) }
  } catch {
    return null
  }
}

/**
 * The block cap as a session sees it: the value `.claude/settings.json` hands every hook
 * through its `env`, so a terminal run prints the cap the session runs under. With none
 * there, the environment's value, then Claude Code's documented default (readCap).
 * @param {Record<string, string|undefined>} env
 */
function capSetting(env) {
  try {
    const v = readJson(SETTINGS)?.env?.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP
    if (typeof v === 'string' || typeof v === 'number') return String(v)
  } catch {
    // an unreadable settings file is gate-integrity's finding; the environment decides here
  }
  return env?.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP
}

/**
 * The last turn in this directory, over the WHOLE ledger: every session's records.
 * @param {Record<string, string|undefined>} env
 */
async function lastTurnField(env) {
  try {
    const turns = await import('../../.claude/hooks/lib/turn-outcomes.mjs')
    let raw
    try {
      raw = readFileSync(turns.TURN_LOG, 'utf8')
    } catch (e) {
      return e?.code === 'ENOENT' ? { kind: 'none' } : null
    }
    const { records } = turns.parseLedger(raw)
    if (records.length === 0) return { kind: 'none' }
    // null as the prompt id: no turn of this session is running, so any mark counts.
    const mark = turns.priorCapHit(records, null)
    if (mark !== null) return { kind: 'cap', gates: Array.isArray(mark.gates) ? mark.gates : [] }
    const blocks = turns.consecutiveBlocks(records)
    if (blocks === 0) return { kind: 'green' }
    const { cap } = turns.readCap({ CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: capSetting(env) })
    return { kind: 'blocks', blocks, cap }
  } catch {
    return null
  }
}

/**
 * Whether the Stop step's 1.1.0 ramp holds the reviewer ledger v2 as NOTEs on this install,
 * so the 1.0.x owed set is the one that decides. rampNote's rule: no install record, a base
 * at or past V2_SINCE, or a harness at or past V2_UNTIL leaves v2 live.
 * @param {Record<string, any>|null} manifest @param {(a: string, b: string) => number} cmp
 */
function v2Ramped(manifest, cmp) {
  if (manifest === null) return false
  const base = manifest.baseVersion ?? manifest.harnessVersion
  if (typeof base !== 'string' || !VERSION_RE.test(base) || cmp(base, V2_SINCE) >= 0) return false
  const live = manifest.harnessVersion ?? manifest.baseVersion
  return !(typeof live === 'string' && VERSION_RE.test(live) && cmp(live, V2_UNTIL) >= 0)
}

/**
 * The owed set the Stop step decides on: the reviewer ledger v2's (the merge-base diff with
 * deletions, plus the whole-turn class) where it is live and the branch has a merge base,
 * the 1.0.x one (uncommitted changes) otherwise. Namespace imports, as in the step, so a
 * forked lib that predates 1.1.0 does not fail to link: where the ramp holds v2 its 1.0.x
 * set decides, and where v2 is live the field is unavailable, because the step's finding
 * there is the fork itself.
 * @param {Record<string, any>|null} manifest @param {Record<string, string|undefined>} env
 */
async function reviewersField(manifest, env) {
  try {
    const triggers = readJson(TRIGGERS)
    const gitDiff = await import('./git-diff.mjs')
    const verdicts = await import('./reviewer-verdicts.mjs')
    const { cmpDotted } = await import('./gate.mjs')
    let owed = null
    if (!v2Ramped(manifest, cmpDotted)) {
      // v2 is live. A forked lib that predates it is the step's finding, not a set it
      // computes, and the 1.0.x set does not decide here: say so rather than print it.
      if (
        typeof gitDiff.reviewChanges !== 'function' ||
        typeof verdicts.owedByTurn !== 'function'
      ) {
        return null
      }
      const review = gitDiff.reviewChanges({ env })
      if (review.base !== null) owed = verdicts.owedByTurn(review.files, triggers)
    }
    owed ??= verdicts.owedBy(gitDiff.changedFiles(), triggers?.reviewers ?? [])
    return { owed: owed.map((o) => ({ agent: o.agent, path: o.because })) }
  } catch {
    // Outside a git repository, or with no readable trigger table: a set that cannot be
    // computed is not an empty one.
    return null
  }
}

/**
 * The four fields, raw. Never throws: a source that cannot be read yields null for its
 * field, which renderBrief prints as unavailable.
 * @param {{ env?: Record<string, string|undefined> }} [opts]
 */
export async function collectBrief({ env = process.env } = {}) {
  const manifest = readInstall()
  return {
    install: installField(manifest),
    parked: await parkedField(),
    lastTurn: await lastTurnField(env),
    reviewers: await reviewersField(manifest, env),
  }
}
