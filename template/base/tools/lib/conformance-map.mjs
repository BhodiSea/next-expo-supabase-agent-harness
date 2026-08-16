// tools/lib/conformance-map.mjs — the pure judgements behind the conformance MAP
// (tools/conformance-map.json): OWASP ASVS 5.0.0, OWASP MASVS 2.1 and CRA Annex I, row by
// row, against what the generated tree actually runs. I/O lives in the callers:
// tools/check-conformance-map.mjs (the consumer gate, third script of `docs-sync`),
// tools/gen-conformance-docs.mjs (the two generated documents), and
// scripts/check-conformance-evidence.mjs (the factory-side canary closure).
//
// THE SHAPE IS THE ESSENTIAL EIGHT REGISTER'S, deliberately (tools/lib/essential-eight.mjs):
// same split between what an install can decide and what only the factory can, same
// direction of dependency (scripts/ imports THIS, never the reverse — the npm `files` list
// ships only installer/ and template/), same rule that a register is judged for CLAIM
// defects and never for security defects. What differs is the subject. The Essential Eight
// asks whether an ORGANISATION meets an objective; these three ask what an APPLICATION
// verifiably does — so the outcomes here are `covered | partial | not-covered |
// not-applicable` rather than ASD's `effective | alternate-control | not-implemented`, and
// there is no assessor-may-refuse arm because nothing here is an alternate control.
//
// WHAT THE MAP IS AND IS NOT. It is a per-requirement statement of which LIVE control bears
// on the requirement, how much of it that control reaches, and what is left. It is not a
// verification: a level attaches to a verification of an application performed by an
// assessor, and CRA conformity is a manufacturer's legal act — the register's own header
// says so, and `claimProblems` below reds any row or comment that says otherwise.
//
// MODULE ROWS ARE CONDITIONAL. A row with `module` set rests on an opt-in module (e2ee,
// eas-update). Its control is judged for liveness ONLY when that module is installed in the
// tree being judged; on a tree without it the row is CONDITIONAL and skipped with no finding,
// because "this control exists in the module" and "this control runs here" are different
// claims and only the second is decidable from the tree. The install marker is
// `docs/modules/<name>/README.md` — every module ships exactly one, it lands at that path on
// enable and leaves on disable, and it is the one file that does not depend on which
// half of the module (packages, workflows, tools) a consumer kept.
// SOURCE: tools/lib/essential-eight.mjs (the register machinery this mirrors)
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { standardsClaims } from './standards-claim.mjs'

// Module-private on purpose, for essential-eight.mjs's reason: exporting the vocabularies
// would invite a caller to re-implement the judgement against its own copy.
const STANDARDS = ['asvs', 'masvs', 'cra']
const OUTCOMES = ['covered', 'partial', 'not-covered', 'not-applicable']
const BOUNDARIES = ['harness', 'consumer', 'organisation', 'shared']
/** ASD's ranking, borrowed as the evidence bar: weakest last. */
const EVIDENCE_TIERS = ['simulated-activity', 'system-generated-artefact', 'documentation']
/** The two outcomes that CLAIM a control. */
const CLAIMING = new Set(['covered', 'partial'])
/** The two outcomes that claim NOTHING and may therefore name no control, canary or proof. */
const NON_CLAIMING = new Set(['not-covered', 'not-applicable'])
/** How a row discloses that its control did not necessarily run on this commit. Two markers
 * are the Essential Eight register's; the third is the shape liveControls() also reports as
 * conditional and neither of the first two describes honestly — a job whose `if:` names
 * `github.event_name` for a PR/merge-queue event (the diff-aware OSV scan), which runs on
 * every pull request but not on a push. */
const CONDITIONAL_MARKER = /\((?:path-filtered|schedule-gated|event-gated)\)/
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Which hook OWNS each rule table in .claude/hooks/lib/guard-rules.mjs. */
const HOOK_FOR_TABLE = new Map([
  ['BASH_RULES', 'pretool-bash-guard.mjs'],
  ['MCP_RULES', 'pretool-mcp-guard.mjs'],
  ['WRITE_PROTECTED', 'pretool-write-guard.mjs'],
  ['WRITE_CONFIG_CHECKS', 'pretool-write-guard.mjs'],
  ['WRITE_GLOBAL_CHECKS', 'pretool-write-guard.mjs'],
  ['WRITE_SQL_CHECKS', 'pretool-write-guard.mjs'],
])

/**
 * Every guard-rule id in guard-rules.mjs SOURCE, mapped to the hook file that runs it.
 *
 * A TEXT read rather than an import, on purpose: the gate runs inside a consumer's chain
 * where the hooks are `.claude/`-relative and owned, and reading the file the hooks read
 * is what makes "a write-guard rule is a live control" a statement about THIS tree. Ids
 * are matched by the shape every rule uses (`id: '<kebab>'`), attributed to the nearest
 * preceding `export const <TABLE> = [` — which is what lets the canary closure demand that
 * a row resting on `weak-crypto-algorithm` cite pretool-write-guard.mjs's proof and not
 * the bash guard's.
 * @param {string} source
 * @returns {Map<string, string>} rule id -> owning hook file
 */
export function guardRuleIds(source) {
  const out = new Map()
  const tables = [...source.matchAll(/^export const ([A-Z_]+) = \[/gm)].map((m) => ({
    name: m[1],
    at: m.index ?? 0,
  }))
  for (const m of source.matchAll(/\bid: '([a-z0-9-]+)'/g)) {
    const at = m.index ?? 0
    let table = null
    for (const t of tables) if (t.at < at) table = t.name
    out.set(m[1], HOOK_FOR_TABLE.get(table ?? '') ?? 'pretool-write-guard.mjs')
  }
  return out
}

/**
 * Which opt-in modules are installed in the tree at `root` — see the header for the marker.
 * @param {{ root: string, modules: Iterable<string> }} input
 * @returns {Set<string>}
 */
export function installedModules({ root, modules }) {
  const out = new Set()
  for (const m of modules) {
    if (existsSync(join(root, 'docs', 'modules', m, 'README.md'))) out.add(m)
  }
  return out
}

// ── Closure 1: the census, by count ────────────────────────────────────────────────────

/** Compare one expected-count table against the actual distribution. @returns {string[]} */
function countTableProblems(label, expected, actual, authority) {
  const out = []
  if (!expected || typeof expected !== 'object') {
    return [
      `census: expectedCounts.${label} is missing — the counts are asserted from the source, never typed, and a missing table asserts nothing.`,
    ]
  }
  for (const [key, want] of Object.entries(expected)) {
    const got = actual[key] ?? 0
    if (got !== want) {
      out.push(
        `census: ${label} '${key}' has ${String(got)} row(s), expected ${String(want)}. ${authority} is the authority; a row is missing, duplicated, or mis-attributed.`,
      )
    }
  }
  for (const key of Object.keys(actual)) {
    if (!(key in expected)) {
      out.push(
        `census: ${label} '${key}' is not in expectedCounts — either the key is misspelled or the register grew a group the source does not have.`,
      )
    }
  }
  return out
}

/** Count rows by a key, over a subset. @returns {Record<string, number>} */
function tally(rows, key) {
  const out = {}
  for (const r of rows) {
    const k = String(key(r))
    out[k] = (out[k] ?? 0) + 1
  }
  return out
}

/**
 * Closure 1 — every count the register asserts is re-derived from its rows: the grand
 * total, each standard's total, ASVS by chapter AND by level, MASVS by group, CRA by part.
 * An ASVS census by chapter alone would let a row change level silently; by level alone
 * would let one change chapter. Both are asserted because both are how a register drifts
 * from its source without anyone deleting anything. Duplicate ids and non-verbatim texts
 * are census defects too — a duplicated row is a count that lies about coverage.
 * @param {any} reg
 * @returns {string[]}
 */
export function censusProblems(reg) {
  const rows = Array.isArray(reg.requirements) ? reg.requirements : []
  const ec = reg.expectedCounts ?? {}
  const problems = []
  if (rows.length !== ec.total) {
    problems.push(
      `census: ${String(rows.length)} requirement(s) present, expected ${String(ec.total)}.`,
    )
  }
  const byStd = tally(rows, (r) => r.standard)
  for (const std of STANDARDS) {
    const want = ec[std]?.total
    const got = byStd[std] ?? 0
    if (got !== want) {
      problems.push(
        `census: standard '${std}' has ${String(got)} row(s), expected ${String(want)}.`,
      )
    }
  }
  const asvs = rows.filter((r) => r.standard === 'asvs')
  problems.push(
    ...countTableProblems(
      'asvs.byChapter',
      ec.asvs?.byChapter,
      tally(asvs, (r) => r.chapter),
      'ASVS 5.0.0 at tag v5.0.0',
    ),
    ...countTableProblems(
      'asvs.byLevel',
      ec.asvs?.byLevel,
      tally(asvs, (r) => r.level),
      'ASVS 5.0.0 at tag v5.0.0',
    ),
    ...countTableProblems(
      'masvs.byGroup',
      ec.masvs?.byGroup,
      tally(
        rows.filter((r) => r.standard === 'masvs'),
        (r) => r.chapter,
      ),
      'MASVS v2.1.0',
    ),
    ...countTableProblems(
      'cra.byPart',
      ec.cra?.byPart,
      tally(
        rows.filter((r) => r.standard === 'cra'),
        (r) => r.chapter,
      ),
      'Regulation (EU) 2024/2847 Annex I',
    ),
  )
  const seen = new Set()
  for (const r of rows) {
    if (seen.has(r.id)) problems.push(`census: id '${String(r.id)}' appears more than once.`)
    seen.add(r.id)
    if (typeof r.text !== 'string' || r.text.trim().length < 20) {
      problems.push(
        `row '${String(r.id)}': 'text' must carry the source's VERBATIM requirement wording.`,
      )
    }
  }
  return problems
}

// ── Closure 2: every claimed control is LIVE, and the row shape holds ───────────────────

/** The vocabulary fields every row carries. @returns {string[]} */
function vocabularyProblems(r, at) {
  const out = []
  if (!STANDARDS.includes(r.standard)) {
    out.push(`${at}: standard '${String(r.standard)}' is not one of ${STANDARDS.join(' | ')}.`)
  }
  if (typeof r.chapter !== 'string' || r.chapter.length === 0) {
    out.push(`${at}: 'chapter' must name the source's chapter, group or part.`)
  }
  if (r.standard === 'asvs' ? ![1, 2, 3].includes(r.level) : r.level !== null) {
    out.push(
      `${at}: 'level' is ${JSON.stringify(r.level)} — ASVS rows carry 1, 2 or 3 (the requirement's own level, never a claimed one) and MASVS/CRA rows carry null.`,
    )
  }
  if (!BOUNDARIES.includes(r.boundary)) {
    out.push(`${at}: boundary '${String(r.boundary)}' is not one of ${BOUNDARIES.join(' | ')}.`)
  }
  if (!OUTCOMES.includes(r.outcome)) {
    out.push(`${at}: outcome '${String(r.outcome)}' is not one of ${OUTCOMES.join(' | ')}.`)
  }
  if (!EVIDENCE_TIERS.includes(r.evidenceTier)) {
    out.push(
      `${at}: evidenceTier '${String(r.evidenceTier)}' is not one of ${EVIDENCE_TIERS.join(' | ')}.`,
    )
  }
  if (typeof r.note !== 'string' || r.note.trim().length === 0) {
    out.push(
      `${at}: every row carries a 'note' — the grade's reasoning is the register's whole value.`,
    )
  }
  if (!DATE.test(String(r.reviewedOn))) {
    out.push(`${at}: 'reviewedOn' must be the YYYY-MM-DD the row was last judged against the tree.`)
  }
  return out
}

/** A claimed control must be one something actually runs. @returns {string[]} */
function claimedControlProblems(r, at, controls) {
  const out = []
  if (!r.control) {
    out.push(`${at}: outcome '${r.outcome}' must name the 'control' that bears on it.`)
  } else if (!controls.live.has(r.control)) {
    out.push(
      `${at}: control '${String(r.control)}' is not a LIVE control — it must be a step in VALIDATE_STEPS/STOP_HOOK_STEPS, a job in a shipped workflow, a gate script a workflow invokes, or a write-guard rule id in .claude/hooks/lib/guard-rules.mjs. A control nobody runs is not a control.`,
    )
  } else if (
    controls.conditional.has(r.control) &&
    !CONDITIONAL_MARKER.test(String(r.note ?? ''))
  ) {
    // "This control exists" and "this control ran on this commit" are different claims;
    // a conditional lane may make only the first, and the row must say which kind it is.
    out.push(
      `${at}: control '${String(r.control)}' is CONDITIONAL, so it did not necessarily run on this commit. Say which kind in the note — '(path-filtered)', '(schedule-gated)' or '(event-gated)'.`,
    )
  }
  if (!r.proof || String(r.proof).trim().length < 10) {
    out.push(`${at}: outcome '${r.outcome}' must name the 'proof' artefact.`)
  }
  return out
}

/** A module row is conditional on its module, and must say so. @returns {string[]} */
function moduleRowProblems(r, at, knownModules) {
  const out = []
  if (!knownModules.has(r.module)) {
    out.push(
      `${at}: module '${String(r.module)}' is not in tools/modules.json \`modules\` — a row conditional on a module nobody can enable is conditional on nothing.`,
    )
  }
  if (!/module/i.test(String(r.note ?? ''))) {
    out.push(
      `${at}: rests on module '${String(r.module)}' but the note never says so — a reader of the grade alone cannot tell it is CONDITIONAL on an opt-in.`,
    )
  }
  return out
}

/** The negative arm: what a not-applicable row owes, and what no other row may carry. @returns {string[]} */
function absenceProblems(r, at) {
  if (r.outcome !== 'not-applicable') {
    return r.negativeProof || r.negativeCanary
      ? [
          `${at}: carries a negativeProof/negativeCanary but its outcome is '${r.outcome}', which claims no absence.`,
        ]
      : []
  }
  const out = []
  if (!r.negativeProof || String(r.negativeProof).trim().length < 40) {
    out.push(
      `${at}: 'not-applicable' requires a written negativeProof stating WHY the surface is absent from the generated system. Silence is not a proof.`,
    )
  }
  if (r.evidenceTier !== 'documentation' && !r.negativeCanary) {
    out.push(
      `${at}: grades 'not-applicable' at evidenceTier '${String(r.evidenceTier)}' — a claim that a machine-generated artefact establishes the absence — but names no 'negativeCanary'. Name the registered proof that would RED if the surface reappeared, or regrade the row to 'documentation'.`,
    )
  }
  return out
}

/** A row that grades nothing may cite nothing, and may not claim the top tier. @returns {string[]} */
function nonClaimingProblems(r, at) {
  const out = []
  if (NON_CLAIMING.has(r.outcome)) {
    for (const f of ['control', 'canary', 'proof']) {
      if (r[f]) {
        out.push(
          `${at}: outcome '${r.outcome}' claims no control, so it may not name '${f}' ('${String(r[f])}') — a proof cited by a row that grades nothing reads as evidence for a claim nobody made.`,
        )
      }
    }
  }
  if (r.evidenceTier === 'simulated-activity') {
    if (!r.canary) {
      out.push(
        `${at}: evidenceTier 'simulated-activity' must name a 'canary' — the registered injection that proves the control can go RED. It is the top tier and the one claim that must be hardest to make.`,
      )
    }
    if (!CLAIMING.has(r.outcome)) {
      out.push(`${at}: a row that claims no control cannot be evidenced by simulated activity.`)
    }
  }
  return out
}

/** What each outcome obliges the row to carry, and forbids it from carrying. @returns {string[]} */
function outcomeContractProblems(r, at) {
  const out = []
  if (r.boundary === 'organisation' && CLAIMING.has(r.outcome)) {
    out.push(
      `${at}: boundary 'organisation' means the requirement is the OPERATOR's to meet — a tree cannot grade it '${r.outcome}'. Grade it not-covered or not-applicable and say whose it is.`,
    )
  }
  if (r.outcome === 'covered' && r.evidenceTier === 'documentation') {
    out.push(
      `${at}: 'covered' may not rest on evidenceTier 'documentation' — a control whose subject IS the requirement leaves an artefact; if only prose says so, the honest grade is 'partial'.`,
    )
  }
  if (r.outcome === 'not-covered' && String(r.note ?? '').trim().length < 40) {
    out.push(
      `${at}: 'not-covered' must carry a note of at least 40 characters saying what would be needed — an unexplained gap is a gap nobody can close.`,
    )
  }
  return [...out, ...absenceProblems(r, at), ...nonClaimingProblems(r, at)]
}

/**
 * Closure 2 — vocabulary, live controls, module conditionality, and the per-outcome contract.
 * @param {any} reg
 * @param {{ live: Set<string>, conditional: Set<string> }} controls liveControls() ∪ guard-rule ids
 * @param {{ installedModules: Set<string>, knownModules: Set<string> }} tree
 * @returns {string[]}
 */
export function rowProblems(reg, controls, { installedModules: installed, knownModules }) {
  const problems = []
  for (const r of reg.requirements ?? []) {
    const at = `row '${String(r.id)}'`
    if (!r.id || typeof r.id !== 'string') {
      problems.push(`${at}: missing or non-string id.`)
      continue
    }
    problems.push(...vocabularyProblems(r, at))
    if (r.module) problems.push(...moduleRowProblems(r, at, knownModules))
    // Liveness is judged for every claiming base row, and for a module row ONLY when its
    // module is installed here — see the header. An uninstalled module row is CONDITIONAL
    // and produces no finding, because nothing in this tree can decide it either way.
    const decidable = !r.module || installed.has(r.module)
    if (CLAIMING.has(r.outcome) && decidable) {
      problems.push(...claimedControlProblems(r, at, controls))
    }
    problems.push(...outcomeContractProblems(r, at))
  }
  return problems
}

// ── Closure 3: unmappedControls — every step is placed, exactly once ────────────────────

/**
 * Closure 3 — every VALIDATE_STEPS ∪ STOP_HOOK_STEPS name is either NAMED as some row's
 * control or KEYED in `unmappedControls` with a reason of at least 40 characters, never
 * both, and never neither. A step that is neither is a control the map forgot; a step that
 * is both is a reason contradicting a grade; a key naming no step is a stale record.
 * @param {any} reg
 * @param {Iterable<string>} steps
 * @returns {string[]}
 */
export function unmappedControlProblems(reg, steps) {
  const problems = []
  const unmapped = reg.unmappedControls ?? {}
  const named = new Set((reg.requirements ?? []).map((r) => r.control).filter(Boolean))
  const stepSet = new Set(steps)
  for (const step of stepSet) {
    if (named.has(step)) continue
    if (!(step in unmapped)) {
      problems.push(
        `unmappedControls: chain step '${step}' is named as no row's control and is not keyed in unmappedControls — every control the tree runs is either mapped or carries a written reason why no requirement in the three standards is its subject.`,
      )
    }
  }
  for (const [key, reason] of Object.entries(unmapped)) {
    if (!stepSet.has(key)) {
      problems.push(
        `unmappedControls: '${key}' is not a step in VALIDATE_STEPS or STOP_HOOK_STEPS — a reason for a control nothing runs is a stale record.`,
      )
    }
    if (named.has(key)) {
      problems.push(
        `unmappedControls: '${key}' is keyed as unmapped AND named as a row's control — the reason and the grade contradict each other; delete one.`,
      )
    }
    if (typeof reason !== 'string' || reason.trim().length < 40) {
      problems.push(
        `unmappedControls: '${key}' carries a reason under 40 characters — an unreasoned exemption is not a review.`,
      )
    }
  }
  return problems
}

// ── Closure 4: the claim-sentence ban, applied to the register's own prose ──────────────

/**
 * Closure 4 — no note, negativeProof or header comment may carry an affirmative
 * ASVS/MASVS/CRA standing claim. The register's header says it never claims a level;
 * this is what makes that sentence a rule rather than a promise. The judgement is
 * tools/lib/standards-claim.mjs — the same one scripts/hygiene.mjs sweeps the README with.
 * @param {any} reg
 * @returns {string[]}
 */
export function claimProblems(reg) {
  const problems = []
  const judge = (where, text) => {
    for (const { claim } of standardsClaims(String(text ?? ''))) {
      problems.push(
        `${where}: claims "${claim}". A conformance MAP states which live control bears on a requirement; it never says the application IS ASVS-, MASVS- or CRA-anything. Say the true thing — what the control reaches, and what is left.`,
      )
    }
  }
  for (const [i, line] of (reg.comment ?? []).entries()) judge(`comment[${String(i)}]`, line)
  for (const r of reg.requirements ?? []) {
    judge(`row '${String(r.id)}' note`, r.note)
    judge(`row '${String(r.id)}' negativeProof`, r.negativeProof)
  }
  return problems
}

// ── Closure 5 (factory-side): every claim names a REGISTERED can-fail proof ─────────────

/** One claiming row's canary obligations. @returns {string[]} */
function claimingCanaryProblems(r, at, canaryKeys, guardRules) {
  if (!r.canary) {
    // A module row's control may live entirely in the module (the eas-update `publish`
    // job), and tests/canary/injections.json keys only what the BASE tree runs — so a
    // module row may leave `canary` null and stays CONDITIONAL. A base row may not.
    return r.module
      ? []
      : [
          `${at}: outcome '${String(r.outcome)}' claims a control, so it must name the 'canary' — the tests/canary/injections.json key (steps ∪ lanes ∪ hookRules) under which the injection proving control '${String(r.control)}' can go RED is registered. A control nobody has shown to fail is indistinguishable from one that cannot.`,
        ]
  }
  const out = []
  if (!canaryKeys.has(r.canary)) {
    out.push(
      `${at}: canary '${String(r.canary)}' has no entry in tests/canary/injections.json under steps{}, lanes{} or hookRules{} — the red-proof this row cites is not registered anywhere.`,
    )
  }
  // THE ANTI-INFLATION HALF: a row may cite only the red-proof of its OWN control. A step or
  // lane control's proof is keyed by its own name; a write-guard rule's proof is keyed by the
  // HOOK that runs the rule (hookRules{}), which is why the guard-rule map is consulted. Two
  // names are BOTH a chain step and a guard-rule id (`db-limits`, `data-flow` — the step and
  // the rule that protects the step's policy file), so either proof is that control's own.
  const own = new Set([r.control, guardRules.get(r.control)].filter(Boolean))
  if (r.control && !own.has(r.canary)) {
    out.push(
      `${at}: canary '${String(r.canary)}' does not name the red-proof of the control this row claims ('${String(r.control)}' → ${[...own].map((k) => `'${k}'`).join(' | ')}). Citing another gate's proof resolves cleanly and proves nothing about this requirement.`,
    )
  }
  return out
}

/** The negative half — an absence claimed above the documentation floor is machine-checked. @returns {string[]} */
function negativeCanaryProblems(r, at, canaryKeys) {
  if (r.outcome !== 'not-applicable') {
    return r.negativeCanary
      ? [
          `${at}: names a negativeCanary but its outcome is '${String(r.outcome)}', which claims no absence.`,
        ]
      : []
  }
  if (r.evidenceTier === 'documentation') return []
  if (!r.negativeCanary) {
    return [
      `${at}: grades 'not-applicable' at evidenceTier '${String(r.evidenceTier)}' but names no 'negativeCanary' — the proof that would RED if the surface reappeared.`,
    ]
  }
  if (!canaryKeys.has(r.negativeCanary)) {
    return [
      `${at}: negativeCanary '${String(r.negativeCanary)}' has no entry in tests/canary/injections.json under steps{}, lanes{} or hookRules{} — the proof this row's absence rests on is not registered anywhere.`,
    ]
  }
  return []
}

/**
 * Closure 5 — FACTORY-SIDE ONLY, because tests/canary/injections.json never ships to an
 * install. Every `covered`/`partial` row's canary is a registered key (steps ∪ lanes ∪
 * hookRules) and is the proof of ITS OWN control; every negativeCanary likewise; a
 * simulated-activity row may not rest on an unregistered canary; a non-claiming row may
 * not carry a canary at all.
 * @param {any} reg
 * @param {Set<string>} canaryKeys registered keys from tests/canary/injections.json
 * @param {Map<string, string>} [guardRules] guard-rule id -> owning hook, from guardRuleIds()
 * @returns {string[]}
 */
export function canaryProblems(reg, canaryKeys, guardRules = new Map()) {
  const problems = []
  for (const r of reg.requirements ?? []) {
    const at = `row '${String(r.id)}'`
    if (CLAIMING.has(r.outcome)) {
      problems.push(...claimingCanaryProblems(r, at, canaryKeys, guardRules))
    } else if (r.canary) {
      problems.push(
        `${at}: names a canary but its outcome is '${String(r.outcome)}', which claims no control. A red-proof cited by a row that grades nothing reads as evidence for a claim nobody made.`,
      )
    }
    problems.push(...negativeCanaryProblems(r, at, canaryKeys))
    // The tier rule, independent of the above so a module row cannot reach the top tier
    // through the null-canary allowance: simulated activity is the hardest claim to make.
    if (r.evidenceTier === 'simulated-activity' && (!r.canary || !canaryKeys.has(r.canary))) {
      problems.push(
        `${at}: evidenceTier 'simulated-activity' must name a REGISTERED canary whose injection proves the control can go RED — it is the top tier and the one claim that must be hardest to make.`,
      )
    }
  }
  return problems
}

// ── The summary the published figures derive from ───────────────────────────────────────

/**
 * Summary counts, for the gate's OK line, the README sentence scripts/check-claims.mjs
 * value-matches, and the generated documents. Published figures are DERIVED, never typed.
 * @param {any} reg
 * @returns {{ total: number, covered: number, partial: number, notCovered: number, notApplicable: number, byStandard: { asvs: number, masvs: number, cra: number }, asvsByLevel: { 1: number, 2: number, 3: number }, byBoundary: { harness: number, consumer: number, organisation: number, shared: number }, moduleConditional: number }}
 */
export function summarise(reg) {
  const rows = reg.requirements ?? []
  const out = {
    total: rows.length,
    covered: 0,
    partial: 0,
    notCovered: 0,
    notApplicable: 0,
    byStandard: { asvs: 0, masvs: 0, cra: 0 },
    asvsByLevel: { 1: 0, 2: 0, 3: 0 },
    byBoundary: { harness: 0, consumer: 0, organisation: 0, shared: 0 },
    moduleConditional: 0,
  }
  const outcomeKey = {
    covered: 'covered',
    partial: 'partial',
    'not-covered': 'notCovered',
    'not-applicable': 'notApplicable',
  }
  for (const r of rows) {
    if (outcomeKey[r.outcome]) out[outcomeKey[r.outcome]] += 1
    if (r.standard in out.byStandard) out.byStandard[r.standard] += 1
    if (r.standard === 'asvs' && r.level in out.asvsByLevel) out.asvsByLevel[r.level] += 1
    if (r.boundary in out.byBoundary) out.byBoundary[r.boundary] += 1
    if (r.module) out.moduleConditional += 1
  }
  return out
}
