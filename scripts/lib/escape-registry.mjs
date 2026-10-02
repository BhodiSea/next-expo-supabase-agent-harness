// escape-registry — the reviewed-data files are enumerated in FOUR places (three until
// 1.1.0), and until 0.5.0 nothing compared the copies.
//
// WHY THIS EXISTS. `tools/lib/enforcement-surface.mjs` opens by explaining that a second
// hand-maintained copy of the escape list "would drift, and the drift would be invisible —
// the second gate would simply stop asking about whatever the first one added". It wrote
// that about two consumers and shipped a third. The three lists are:
//
//   1. installer/lib/layout.mjs#SEEDED_FILES      — what `update` must plant, never clobber
//   2. tools/lib/enforcement-surface.mjs#ESCAPE_LISTS — what gate-integrity's
//                                                   commit-not-dirty rule iterates
//   3. .claude/hooks/lib/guard-rules.mjs#WRITE_PROTECTED — what the agent may not edit
//   4. installer/lib/proposals.mjs#PROPOSABLE      — what `apply-proposal` may write (1.1.0,
//                                                   #65); a copy, because the installer never
//                                                   imports a template module
//
// Its first run found three live divergences, and the sharpest was not the one anybody had
// predicted: tools/security-headers.json was SEEDED and in ESCAPE_LISTS with NO write-guard
// rule — one protection layer where every peer in its own block had three.
//
// PURE — no fs, no process, no side effects — so tests can inject inputs and the runner
// (scripts/check-escape-registry.mjs) owns every exit. The split follows
// scripts/lib/ramp-sites.mjs: importing a check must never be able to exit the importer.
// SOURCE: template/base/tools/lib/enforcement-surface.mjs (the drift-is-invisible header)

// ── the reviewed classification ────────────────────────────────────────────────────
// A member of the population is one of these KINDS. The kind decides which layers it
// owes — deliberately a closed map over reviewed data rather than one rule for
// everything, because the exceptions below are genuinely different shapes and
// forcing them into `escape` would produce a confidently wrong consumer message.
//
// `escape`   — reviewed data that EXEMPTS code from a gate or RAISES a budget. Owes all
//              three layers. This is the default and every unlisted member must be one.
// `pin`      — a value the gate compares AGAINST. Widening is meaningless; the failure
//              mode is the pin MOVING, which is not what ESCAPE_LISTS' dirty rule asks.
// `hash`     — integrity comes from a hash lock the gate re-derives, not from a commit.
// `generated`— integrity comes from a regen-diff. Hand-editing is never legitimate.
// `advisory` — reviewed text a gate PRINTS and never judges: it exempts nothing, raises no
//              budget and cannot change a verdict, so there is no widening for
//              ESCAPE_LISTS' commit rule to ask about. It still owes the seed (`update`
//              must never clobber it) and the guard (an agent must not write what it is
//              about to be told).
export const KINDS = new Map([
  [
    'tools/identity.lock.json',
    {
      kind: 'pin',
      why: 'store identity (bundle id / package) is UPGRADE identity and never changes. ESCAPE_LISTS is defined by its own header as data that "EXEMPTS code from a gate or RAISES a budget"; this is the value check-expo-policy.mjs compares the resolved config against. Its control is that write-guard rule plus the gate, not a reviewed widening.',
      owes: ['seeded', 'guard'],
    },
  ],
  [
    'tools/prompts.lock.json',
    {
      kind: 'hash',
      why: 'the `prompts` gate re-derives the hash of every LLM prompt file and diffs it against this lock, so a hand edit is caught by re-derivation rather than by a commit rule.',
      owes: ['seeded', 'guard'],
    },
  ],
  [
    'tools/generated/query-shapes.json',
    {
      kind: 'generated',
      why: 'written by EXECUTING each DAL function through a harness-owned recording port and regen-diffed by the `contracts` step. Nothing may hand-edit it, so "commit the widening" is not the applicable rule.',
      owes: ['seeded', 'guard'],
    },
  ],
  [
    'tools/generated/action-inventory.json',
    {
      kind: 'generated',
      why: 'generated from the consumer’s tRPC router by `pnpm gen` and regen-diffed by the `contracts` step (seeded as of 0.7.0 — while it was owned, `update` planted the template router’s census into every upgraded repo). Nothing may hand-edit it, so "commit the widening" is not the applicable rule.',
      owes: ['seeded', 'guard'],
    },
  ],
  [
    'tools/field-notes.json',
    {
      kind: 'advisory',
      why: 'per-gate field notes (1.1.0): tools/lib/gate.mjs prints a note as one extra line after a failing gate’s FIX line, only on a run that is already red. The file exempts nothing and raises no budget, so ESCAPE_LISTS (data that EXEMPTS code or RAISES a budget) is the wrong list and its commit rule would ask about a widening that cannot exist. Seeded so `update` never clobbers a project’s notes; write-guarded because the text reaches an agent while it decides how to make a red go away.',
      owes: ['seeded', 'guard'],
    },
  ],
])

// Tolerated-absent escapes: in ESCAPE_LISTS but deliberately NOT seeded, because their
// gates read absent-as-empty and CREATING one is the widening. They owe the escape and
// guard layers but not the seed.
export const TOLERATED_ABSENT = new Set([
  'tools/retrofit-accept.json',
  'tools/secret-scan-allow.json',
  'tools/migrations-allow.json',
  // 1.1.0 (#74): schema-rls' grant-bound allowances. The gate reads it absent-as-empty, and
  // a (table, role, privilege) row is a privilege no policy admits, allowed to stand.
  'tools/grant-bound-allow.json',
])

// Explicitly out of population, with the reason. tools/harness.config.mjs is reviewed
// data a project tunes, but it is CONFIG_FILES rather than an escape: its integrity is
// the frozen floor snapshot (`validate.mjs --min-floor`), which is a strictly stronger
// control than a dirty check — a locally weakened config cannot weaken CI at all.
export const OUT_OF_POPULATION = new Map([
  [
    'tools/harness.config.mjs',
    'CONFIG_FILES, not an escape — its control is the frozen floor snapshot, which CI trusts over the config itself',
  ],
])

// The escapes a proposal may NOT target (1.1.0, #65), with the reason. Each is written by
// its own generator, which the bash guard's self-rebaseline-writer rule reserves for a human;
// a hand-staged baseline would be the same acceptance without the measurement behind it.
export const NOT_PROPOSABLE = new Map([
  [
    'tools/perf-baseline.json',
    'written only by tools/perf-baseline.mjs, from a measured build; a human re-runs it (HARNESS_ALLOW_SELF_EDIT=1) rather than applying a hand-written floor',
  ],
  [
    'tools/mutation-baseline.json',
    'written only by `check-mutation-ratchet.mjs --write`, from a mutation run; a human re-runs it (HARNESS_ALLOW_SELF_EDIT=1) rather than applying a hand-written survivor set',
  ],
])

/**
 * The fourth list (1.1.0, #65). `apply-proposal` keeps its own copy of the proposable set,
 * so it is reconciled here: ESCAPE_LISTS, plus every `advisory` member of KINDS (reviewed
 * text a human may want to change as much as an escape), minus NOT_PROPOSABLE. Pure, like
 * deriveRegistry: the runner and the tests hand it the lists.
 *
 * @param {{ escapes: readonly string[], proposable: readonly string[] }} input
 * @returns {string[]}
 */
export function reconcileProposable({ escapes, proposable }) {
  const problems = []
  const advisory = [...KINDS].filter(([, d]) => d.kind === 'advisory').map(([f]) => f)
  const expected = new Set([...escapes, ...advisory].filter((f) => !NOT_PROPOSABLE.has(f)))
  const actual = new Set(proposable)
  for (const file of [...expected].sort()) {
    if (!actual.has(file)) {
      problems.push(
        `${file} is a reviewed register (ESCAPE_LISTS or an advisory KINDS member) but is absent from installer/lib/proposals.mjs#PROPOSABLE, so an agent cannot stage an edit to it for a human to apply. Add it there, or to NOT_PROPOSABLE in this script with the reason.`,
      )
    }
  }
  for (const file of [...actual].sort()) {
    if (NOT_PROPOSABLE.has(file)) {
      problems.push(`${file} is in installer/lib/proposals.mjs#PROPOSABLE but NOT_PROPOSABLE excludes it: ${NOT_PROPOSABLE.get(file)}. Remove it from PROPOSABLE.`)
    } else if (!expected.has(file)) {
      problems.push(
        `${file} is in installer/lib/proposals.mjs#PROPOSABLE but is not in ESCAPE_LISTS or an advisory KINDS member, so \`apply-proposal\` would write a file that is owned, pinned, generated or unguarded. Remove it from PROPOSABLE.`,
      )
    }
  }
  for (const file of NOT_PROPOSABLE.keys()) {
    if (!escapes.includes(file)) {
      problems.push(`NOT_PROPOSABLE names ${file}, which is not in ESCAPE_LISTS — a stale entry. Remove it.`)
    }
  }
  return problems
}

// The anti-vacuity floor, sized against the MEASURED population rather than a round
// number, in the shape check-tier-coverage.mjs uses. Measured 2026-08-06: SEEDED ∩ tools/**
// is 30 and ESCAPE_LISTS is 30 (29 + decision-groups.json, added this release), union 33.
// A scanner that finds materially fewer has broken, and every assertion below it is
// vacuous — which is the failure mode every closure in this repo is written against.
const MIN_POPULATION = 28

/**
 * Derive the population and its findings from injected inputs.
 *
 * Injectable — NOT reading the three modules itself — so the anti-vacuity floor is
 * PROVABLE rather than merely asserted: the test hands it an empty set and checks that it
 * reds. `shippedRampSites(toolsDir)` takes a directory for the same reason.
 *
 * @param {{ seeded: Iterable<string>, escapes: string[], guards: {id: string, re: RegExp}[] }} input
 */
export function deriveRegistry({ seeded, escapes, guards }) {
  const seededTools = [...seeded].filter((f) => f.startsWith('tools/'))
  const population = [...new Set([...seededTools, ...escapes])]
    .filter((f) => !OUT_OF_POPULATION.has(f))
    .sort()

  const problems = []

  if (population.length < MIN_POPULATION) {
    problems.push(
      `only ${String(population.length)} member(s) derived, below the floor of ${String(MIN_POPULATION)} — the measured population is 33, so the derivation is broken and every assertion below it would pass vacuously`,
    )
    return { population, problems }
  }

  const seededSet = new Set(seededTools)
  const escapeSet = new Set(escapes)
  const guarded = (f) => guards.some((r) => r.re.test(f))

  for (const file of population) {
    const declared = KINDS.get(file)
    const owes = declared?.owes ?? ['seeded', 'escape', 'guard']
    const kind = declared?.kind ?? 'escape'

    if (owes.includes('guard') && !guarded(file)) {
      problems.push(
        `${file} has NO write-guard rule in .claude/hooks/lib/guard-rules.mjs#WRITE_PROTECTED — an agent can edit it mid-turn. Add a rule with its own id (and a RULE_CANARIES deny/allow case, or check-canary-coverage.mjs reds).`,
      )
    }
    if (owes.includes('escape') && !escapeSet.has(file)) {
      problems.push(
        `${file} is reviewed data under tools/ but is absent from ESCAPE_LISTS, so gate-integrity's commit-not-dirty rule never asks whether a widening was committed. Add it there, or declare it in this script's KINDS map with the layer that covers it instead and why.`,
      )
    }
    if (owes.includes('seeded') && !seededSet.has(file) && !TOLERATED_ABSENT.has(file)) {
      problems.push(
        `${file} is in ESCAPE_LISTS but not in SEEDED_FILES, so \`update\` treats it as harness-OWNED and will CLOBBER the consumer's reviewed edits on every upgrade. Seed it, or add it to TOLERATED_ABSENT with its gate's absent-as-empty behaviour.`,
      )
    }
    // A `pin`/`hash`/`generated` member must not ALSO be in ESCAPE_LISTS: the two
    // messages contradict each other, and the consumer gets told to commit a widening to
    // a file whose only legitimate change is a re-derivation.
    if (kind !== 'escape' && escapeSet.has(file)) {
      problems.push(
        `${file} is declared \`${kind}\` (${declared?.why ?? ''}) but also appears in ESCAPE_LISTS — the two controls give contradictory advice. Remove it from ESCAPE_LISTS or reclassify it.`,
      )
    }
  }

  return { population, problems }
}
