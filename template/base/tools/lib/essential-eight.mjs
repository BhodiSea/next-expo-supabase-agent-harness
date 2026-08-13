// tools/lib/essential-eight.mjs — the pure judgements behind the Essential Eight
// conformance register (tools/essential-eight.json). I/O lives in the two callers:
// tools/check-essential-eight.mjs (the consumer gate, second script of `docs-sync`) and
// scripts/check-essential-eight-evidence.mjs (the factory-side canary closure).
//
// WHY THE SPLIT IS WHAT IT IS. tests/canary/injections.json is FACTORY-ONLY — no install
// ever receives it — so the "a simulated-activity claim names a registered can-fail proof"
// closure cannot run in a consumer's chain. Asking a consumer to answer for a registry
// they do not have is the same defect check-tier-coverage.mjs avoids by living in
// scripts/: that is where the artefact is authored, so that is where it is judged.
// Both callers share these functions, so the two can never disagree about the shape.
//
// DIRECTION OF THE DEPENDENCY. This lives under template/base/tools/lib/ and scripts/
// imports IT, never the reverse — the npm `files` list ships only installer/ and
// template/, so a template gate importing a scripts/ module would resolve on the
// harness's own checkout and be missing on every install.
// SOURCE: tools/lib/live-controls.mjs (the same dependency-direction note)

// Module-private on purpose: the vocabularies are enforced HERE, and exporting them would
// invite a caller to re-implement the judgement against its own copy — which is how the
// two consumers of this lib would come to disagree about what a valid grade is.
/** ASD's assessment outcomes that a PRODUCT-boundary row may carry. */
const OUTCOMES = ['effective', 'alternate-control', 'not-implemented', 'not-applicable']

/** ASD ranks evidence; these are its tiers, weakest last. */
const EVIDENCE_TIERS = ['simulated-activity', 'system-generated-artefact', 'documentation']

const BOUNDARIES = ['product', 'organisation']
const REACHABILITY = ['direct', 'alternate', 'none']

/**
 * Closure 1 — the census, by count.
 *
 * A naive union of the model's appendices gives 152 and is WRONG: exactly three ML1/ML2
 * requirements are SUPERSEDED at ML3. The expected counts are committed data, so a row
 * silently dropped (or a superseded row silently re-added) reds naming the strategy.
 * @param {{ requirements: any[], expectedCounts: { total: number, byStrategy: Record<string, number> } }} reg
 * @returns {string[]}
 */
export function censusProblems(reg) {
  const problems = []
  const expected = reg.expectedCounts?.byStrategy ?? {}
  const actual = {}
  for (const r of reg.requirements) actual[r.strategy] = (actual[r.strategy] ?? 0) + 1

  for (const [strategy, want] of Object.entries(expected)) {
    const got = actual[strategy] ?? 0
    if (got !== want) {
      problems.push(
        `census: strategy '${strategy}' has ${String(got)} row(s), expected ${String(want)}. ASD's Appendix C is the authority; a row is missing, duplicated, or mis-attributed.`,
      )
    }
  }
  for (const strategy of Object.keys(actual)) {
    if (!(strategy in expected)) {
      problems.push(
        `census: strategy '${strategy}' is not in expectedCounts.byStrategy — either the strategy name is misspelled or the register grew a strategy the model does not have.`,
      )
    }
  }
  const total = reg.requirements.length
  if (total !== reg.expectedCounts?.total) {
    problems.push(
      `census: ${String(total)} requirement(s) present, expected ${String(reg.expectedCounts?.total)}.`,
    )
  }
  return problems
}

/**
 * Closure 1b — the supersession record.
 *
 * A cut requirement and a forgotten requirement look identical six months later, so the
 * three superseded rows are RECORDED with what replaced them rather than deleted. Each
 * `replacedBy` id must resolve to a live row, and a superseded text must not also appear
 * as a live requirement.
 * @param {any} reg
 * @returns {string[]}
 */
export function supersessionProblems(reg) {
  const problems = []
  const rows = reg.supersededAtML3 ?? []
  if (rows.length === 0) {
    problems.push(
      'supersession: supersededAtML3[] is empty. The 2023 model supersedes exactly three ML1/ML2 requirements at ML3; an empty list means the 152-vs-149 trap has been re-introduced.',
    )
  }
  const ids = new Set(reg.requirements.map((r) => r.id))
  const texts = new Set(reg.requirements.map((r) => r.text))
  for (const s of rows) {
    for (const id of s.replacedBy ?? []) {
      if (!ids.has(id)) {
        problems.push(
          `supersession: '${String(s.strategy)}' names replacedBy '${id}', which is not a requirement id in this register.`,
        )
      }
    }
    if (texts.has(s.text)) {
      problems.push(
        `supersession: the superseded text under '${String(s.strategy)}' also appears as a LIVE requirement. A superseded requirement is recorded, never counted.`,
      )
    }
  }
  return problems
}

/**
 * Closure 2 — every claimed control is LIVE, and the row shape holds.
 *
 * `live` and `conditional` come from liveControls() — the same derivation check-docs-sync
 * and check-tier-coverage use, so a control nameable in one place is nameable in all.
 * @param {any} reg
 * @param {{ live: Set<string>, conditional: Set<string> }} controls
 * @returns {string[]}
 */
/** The vocabulary fields every row carries, whatever its boundary. @returns {string[]} */
function vocabularyProblems(r, at) {
  const out = []
  if (typeof r.text !== 'string' || r.text.trim().length < 20) {
    out.push(`${at}: 'text' must carry ASD's VERBATIM requirement wording.`)
  }
  if (!BOUNDARIES.includes(r.boundary)) {
    out.push(`${at}: boundary '${String(r.boundary)}' is not one of ${BOUNDARIES.join(' | ')}.`)
  }
  if (!REACHABILITY.includes(r.reachability)) {
    out.push(
      `${at}: reachability '${String(r.reachability)}' is not one of ${REACHABILITY.join(' | ')}. It is FROZEN from the research pass and records what a codebase COULD satisfy — never edit it to match a grade.`,
    )
  }
  if (!EVIDENCE_TIERS.includes(r.evidenceTier)) {
    out.push(
      `${at}: evidenceTier '${String(r.evidenceTier)}' is not one of ${EVIDENCE_TIERS.join(' | ')}.`,
    )
  }
  return out
}

/** An organisation-boundary row states whose it is, and grades nothing. @returns {string[]} */
function organisationRowProblems(r, at) {
  const out = []
  if (r.outcome !== null) {
    out.push(
      `${at}: boundary 'organisation' means the outcome is NOT this system's to assign — 'outcome' must be null, and it is '${String(r.outcome)}'.`,
    )
  }
  if (!r.owner || String(r.owner).trim().length < 10) {
    out.push(`${at}: an organisation-boundary row must name an 'owner' who answers for it.`)
  }
  return out
}

/** A claimed control must be one something actually runs. @returns {string[]} */
function claimedControlProblems(r, at, controls) {
  const out = []
  if (!r.control) {
    out.push(`${at}: outcome '${r.outcome}' must name the 'control' that proves it.`)
  } else if (!controls.live.has(r.control)) {
    out.push(
      `${at}: control '${String(r.control)}' is not a LIVE control — it must be a step in VALIDATE_STEPS/STOP_HOOK_STEPS, a job in a shipped workflow, or a gate script a workflow invokes. A control nobody runs is not a control.`,
    )
  } else if (
    controls.conditional.has(r.control) &&
    !/\((?:path-filtered|schedule-gated)\)/.test(String(r.note ?? ''))
  ) {
    // "This control exists" and "this control ran on this commit" are different claims. A
    // conditional lane may make only the first, and the row must say which kind it is —
    // path-filtered (skipped when a PR misses its paths) or schedule-gated (runs on cron,
    // so it is proven periodically rather than per-commit). Either marker is accepted;
    // silence is not, because a reader cannot tell the two apart from the grade alone.
    out.push(
      `${at}: control '${String(r.control)}' is CONDITIONAL, so it did not necessarily run on this commit. Say which kind in the note — '(path-filtered)' or '(schedule-gated)'.`,
    )
  }
  if (!r.proof || String(r.proof).trim().length < 10) {
    out.push(`${at}: outcome '${r.outcome}' must name the 'proof' artefact.`)
  }
  return out
}

/** What each product-boundary outcome obliges the row to carry. @returns {string[]} */
function outcomeContractProblems(r, at) {
  const out = []
  if (r.outcome === 'alternate-control' && r.assessorMayRefuse !== true) {
    out.push(
      `${at}: an alternate control is demonstrated by the SYSTEM OWNER and may be refused by an assessor — it is never pre-earned by a generator. Set assessorMayRefuse: true.`,
    )
  }
  if (r.outcome !== 'alternate-control' && r.assessorMayRefuse === true) {
    out.push(`${at}: assessorMayRefuse belongs only on an 'alternate-control' row.`)
  }
  if (
    r.outcome === 'not-applicable' &&
    (!r.negativeProof || String(r.negativeProof).trim().length < 40)
  ) {
    out.push(
      `${at}: 'not-applicable' requires a written negativeProof stating WHY the asset class is absent from the generated system. Silence is not a proof.`,
    )
  }
  if (r.outcome === 'not-implemented' && !r.obligation) {
    out.push(
      `${at}: 'not-implemented' must name an 'obligation' row id, so the register cannot hide a gap — every unbuilt row is carried in scripts/obligations.json.`,
    )
  }
  if (r.outcome === 'not-implemented' && r.evidenceTier === 'simulated-activity') {
    out.push(`${at}: an unbuilt requirement cannot be evidenced by simulated activity.`)
  }
  return out
}

/** One product-boundary row. @returns {string[]} */
function productRowProblems(r, at, controls) {
  if (!OUTCOMES.includes(r.outcome)) {
    return [`${at}: outcome '${String(r.outcome)}' is not one of ${OUTCOMES.join(' | ')}.`]
  }
  const claims = r.outcome === 'effective' || r.outcome === 'alternate-control'
  return [
    ...(claims ? claimedControlProblems(r, at, controls) : []),
    ...outcomeContractProblems(r, at),
  ]
}

export function rowProblems(reg, controls) {
  const problems = []
  const seen = new Set()

  for (const r of reg.requirements) {
    const at = `row '${String(r.id)}'`
    if (!r.id || typeof r.id !== 'string') {
      problems.push(`${at}: missing or non-string id.`)
      continue
    }
    if (seen.has(r.id)) problems.push(`${at}: duplicate id.`)
    seen.add(r.id)

    problems.push(...vocabularyProblems(r, at))
    problems.push(
      ...(r.boundary === 'organisation'
        ? organisationRowProblems(r, at)
        : productRowProblems(r, at, controls)),
    )
  }
  return problems
}

/**
 * Closure 3 — shared clauses declare their artefact ONCE.
 *
 * Eight logging/incident clauses repeat identically across four strategies — 32 of the 149
 * rows resting on one artefact set. Double-counting one artefact across rows is the
 * commonest form of compliance inflation, so the artefact is declared here and claimed by
 * AT MOST ONE row.
 *
 * Deliberately NOT asserted: that every instance carries the same outcome. The clause text
 * is identical but its SUBJECT is its parent strategy's log stream, and those differ — the
 * audit trail genuinely protects privileged-access events and genuinely has no
 * application-control events to protect. Forcing equal grades would inflate three rows or
 * deflate one.
 * @param {any} reg
 * @returns {string[]}
 */
/** A row that claims a control is one graded `effective` or `alternate-control`. */
const claimsAControl = (row) =>
  Boolean(row) && (row.outcome === 'effective' || row.outcome === 'alternate-control')

/** Each instance must point back at its clause and quote it identically. @returns {string[]} */
function clauseInstanceProblems(c, appears, byId) {
  const out = []
  for (const id of appears) {
    const row = byId.get(id)
    if (!row) {
      out.push(`sharedClause '${String(c.id)}': appearsIn names '${id}', which is not a row.`)
      continue
    }
    if (row.sharedClause !== c.id) {
      out.push(
        `sharedClause '${String(c.id)}': row '${id}' does not reference it back (sharedClause is '${String(row.sharedClause)}'). The link is closed BOTH ways.`,
      )
    }
    if (row.text !== c.text) {
      out.push(
        `sharedClause '${String(c.id)}': row '${id}' text differs from the declared clause text — a shared clause is shared because the wording is identical.`,
      )
    }
  }
  return out
}

/** One artefact, one claim — the anti-inflation half. @returns {string[]} */
function clauseClaimProblems(c, appears, byId) {
  const claimant = c.artefactClaimedBy
  const claiming = appears.filter((id) => claimsAControl(byId.get(id)))

  if (claimant === null || claimant === undefined) {
    return claiming.length === 0
      ? []
      : [
          `sharedClause '${String(c.id)}': artefactClaimedBy is null but ${String(claiming.length)} row(s) claim a control (${claiming.join(', ')}). Name the single claimant.`,
        ]
  }

  const out = []
  if (!appears.includes(claimant)) {
    out.push(
      `sharedClause '${String(c.id)}': artefactClaimedBy '${String(claimant)}' is not among its own instances.`,
    )
  }
  for (const id of claiming.filter((x) => x !== claimant)) {
    out.push(
      `sharedClause '${String(c.id)}': the artefact is claimed by '${String(claimant)}', but row '${id}' ALSO claims a control for the same clause. One artefact, one claim — counting it twice is compliance inflation.`,
    )
  }
  return out
}

export function sharedClauseProblems(reg) {
  const problems = []
  const declared = new Map((reg.sharedClauses ?? []).map((c) => [c.id, c]))
  const byId = new Map(reg.requirements.map((r) => [r.id, r]))

  for (const r of reg.requirements) {
    if (r.sharedClause && !declared.has(r.sharedClause)) {
      problems.push(
        `row '${String(r.id)}': sharedClause '${String(r.sharedClause)}' is not declared in sharedClauses[].`,
      )
    }
  }

  for (const c of declared.values()) {
    const appears = c.appearsIn ?? []
    if (appears.length < 2) {
      problems.push(
        `sharedClause '${String(c.id)}': appearsIn lists ${String(appears.length)} row(s). A clause claimed by fewer than two rows is not shared and should be inlined.`,
      )
    }
    problems.push(...clauseInstanceProblems(c, appears, byId))
    problems.push(...clauseClaimProblems(c, appears, byId))
  }
  return problems
}

/**
 * Closure 4 — a simulated-activity claim names a REGISTERED can-fail proof.
 *
 * FACTORY-SIDE ONLY: tests/canary/injections.json never ships to an install. ASD calls
 * documentation and interviews POOR evidence and testing with simulated activity
 * EXCELLENT, so the top tier is exactly the claim that must be hardest to make.
 * @param {any} reg
 * @param {Set<string>} canaryKeys registered step keys from tests/canary/injections.json
 * @returns {string[]}
 */
export function canaryProblems(reg, canaryKeys) {
  const problems = []
  for (const r of reg.requirements) {
    if (r.evidenceTier !== 'simulated-activity') {
      if (r.canary) {
        problems.push(
          `row '${String(r.id)}': names a canary but its evidenceTier is '${String(r.evidenceTier)}'. Claim the tier or drop the reference.`,
        )
      }
      continue
    }
    if (!r.canary) {
      problems.push(
        `row '${String(r.id)}': evidenceTier 'simulated-activity' must name the 'canary' whose injection proves the control can go RED. A gate that cannot go red is decoration.`,
      )
      continue
    }
    if (!canaryKeys.has(r.canary)) {
      problems.push(
        `row '${String(r.id)}': canary '${String(r.canary)}' has no entry in tests/canary/injections.json steps{}.`,
      )
    }
  }
  return problems
}

/**
 * Closure 5 — the machine-checkable half of the Office/document negative proof.
 *
 * Sixty-one rows are 'not-applicable' because the asset class is absent, and eleven of
 * them (the whole macro strategy) rest on there being no document-parsing surface. That
 * half is decidable from the tree, so it is decided rather than asserted: `[storage]`
 * disabled in supabase/config.toml, and no upload route.
 * @param {{ configToml: string, uploadRoutes: string[] }} evidence
 * @returns {string[]}
 */
export function negativeProofProblems({ configToml, uploadRoutes }) {
  const problems = []
  const storage = /\[storage\][^[]*?enabled\s*=\s*(true|false)/s.exec(configToml ?? '')
  if (!storage) {
    problems.push(
      "negative proof: could not find an explicit `enabled` under [storage] in supabase/config.toml. The macro strategy's not-applicable rows rest on storage being OFF; an absent setting is not a proof.",
    )
  } else if (storage[1] === 'true') {
    problems.push(
      "negative proof: [storage] is ENABLED. Eleven 'Restrict Microsoft Office macros' rows are graded not-applicable on the ground that no document-parsing surface exists. Enabling storage re-opens that surface, so those grades must be revisited in the same change.",
    )
  }
  for (const route of uploadRoutes ?? []) {
    problems.push(
      `negative proof: '${route}' looks like a file-upload surface. The macro strategy's not-applicable grades assume none exists.`,
    )
  }
  return problems
}

/**
 * Summary counts, for the gate's OK line and for scripts/check-claims.mjs.
 * Published figures are DERIVED from the register, never hand-carried.
 * @param {any} reg
 * @returns {{ total: number, effective: number, alternateControl: number, notImplemented: number, notApplicable: number, organisation: number, sharedClauses: number, obligations: string[] }}
 */
export function summarise(reg) {
  const out = {
    total: reg.requirements.length,
    effective: 0,
    alternateControl: 0,
    notImplemented: 0,
    notApplicable: 0,
    organisation: 0,
    sharedClauses: (reg.sharedClauses ?? []).length,
    obligations: [],
  }
  const obligations = new Set()
  for (const r of reg.requirements) {
    if (r.boundary === 'organisation') out.organisation += 1
    else if (r.outcome === 'effective') out.effective += 1
    else if (r.outcome === 'alternate-control') out.alternateControl += 1
    else if (r.outcome === 'not-implemented') out.notImplemented += 1
    else if (r.outcome === 'not-applicable') out.notApplicable += 1
    if (r.obligation) obligations.add(r.obligation)
  }
  out.obligations = [...obligations].sort()
  return out
}
