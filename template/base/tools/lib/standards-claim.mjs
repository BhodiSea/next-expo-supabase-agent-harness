// tools/lib/standards-claim.mjs — the sentences the conformance map must never license.
//
// 1.0.0 shipped tools/conformance-map.json: every requirement of OWASP ASVS 5.0.0, OWASP
// MASVS 2.1 and CRA Annex I, graded against what the generated tree actually does. The
// research that produced it also produced the reason the map must never become a claim:
// a verification LEVEL attaches to a verification OF AN APPLICATION performed by an
// assessor against that application, so a template cannot hold one and a generator cannot
// confer one; and CRA conformity is a manufacturer's legal act (Annex I obligations, a
// conformity assessment, a declaration, CE marking) that no code tree performs. So the map
// is worth having and the sentence built on top of it — "ASVS L2-compliant",
// "MASVS-certified", "CRA-compliant" — would be false, in the direction that sells.
//
// This is the ASVS/MASVS/CRA twin of scripts/lib/maturity-claim.mjs, and it lives under
// template/base/tools/lib/ rather than beside it for the reason essential-eight.mjs
// states: the CONSUMER gate (tools/check-conformance-map.mjs) applies the same ban to the
// register's own note/negativeProof/comment text, and a template gate importing scripts/
// would resolve on the harness's checkout and be missing on every install. scripts/lib/
// standards-claim.mjs re-exports THIS module, so the two sweeps can never disagree.
//
// WHAT IT MATCHES is the AFFIRMATIVE form only — a claim verb adjacent to a standard token,
// a standard token used as an adjective ("ASVS L2-compliant"), or the "compliant with /
// conforms to" prepositional shape. Describing the standard, quoting a requirement,
// counting requirements, naming a control that BEARS ON a requirement, and DENYING the
// claim must all stay legal, because the map's own documentation does all five on nearly
// every page. So each hit is re-judged against the sentence it sits in and dropped when
// that sentence negates it — the identical mechanism, window and negation vocabulary the
// maturity sweep uses, so a sentence that is legal under one is legal under the other.
//
// ITS STATED LIMIT, in the shape docs/harness/enforcement-tiers.md asks for: it names the
// claim shapes it knows. A novel phrasing — "assessment-ready at Level 3", "passes the
// standard", a number dressed as a level — walks past it, and that half belongs to the
// reviewer. What it buys is that the OBVIOUS sentence, the one somebody writes in a hurry
// for a launch README, cannot land — and cannot land inside the register either.
// SOURCE: scripts/lib/maturity-claim.mjs (the sweep this mirrors)

/** Punctuation that can sit between a claim verb and the standard it claims: markdown
 * emphasis, quotes, brackets. `is **ASVS Level 2**` is the same claim as `is ASVS Level 2`,
 * and a matcher that only reads spaces says otherwise. */
const SEP = String.raw`[\s"'*_‘’“”(\[]+`
/** The same punctuation on the way OUT of a standard token — `**ASVS Level 2** compliant`. */
const CLOSE = String.raw`[\s"'*_‘’“”)\]-]*`

/** A standard, spelled any of the ways the material spells it, with an optional level. */
const STANDARD = String.raw`(?:(?:OWASP\s+)?(?:ASVS|MASVS)\b(?:[\s-]*(?:v?5(?:\.0(?:\.0)?)?|v?2(?:\.1(?:\.0)?)?))?(?:[\s-]+(?:Level\s+)?L?[1-3]\b|[\s-]+(?:Level\s+)?(?:One|Two|Three)\b)?|(?:the\s+)?(?:CRA|Cyber\s+Resilience\s+Act)\b)`

/** Verbs that turn a mention into an assertion. */
const VERB = String.raw`(?:achiev\w*|attain\w*|meets?|met|satisf\w*|deliver\w*|guarantee\w*|reach\w*|is|are|was|were|becomes?|became|certified|accredited|assessed|rated|assured|verified|conforms?|conforming|compliant|complies|complied|passes|passed)`

/** Adjectives that, hyphenated or spaced onto a standard token, make it a claim. */
const ADJ = String.raw`(?:compliant|certified|accredited|conformant|conforming|assured|ready|approved|verified|validated|attested)`

const CLAIM = new RegExp(
  [
    // "meets ASVS Level 2", "is MASVS-L2", "certified to ASVS", "conforms to the CRA",
    // "compliant with the Cyber Resilience Act", "achieves ASVS Level 3"
    String.raw`\b${VERB}(?:\s+(?:at|to|with|as|for|against|under))?${SEP}${STANDARD}(?:${CLOSE}${ADJ}\b)?`,
    // "ASVS L2-compliant", "MASVS-certified", "CRA-compliant", "ASVS Level 2 verified"
    String.raw`\b${STANDARD}${CLOSE}${ADJ}\b`,
    // "in compliance with the CRA", "in conformity with ASVS", "in conformance with MASVS"
    String.raw`\bin\s+(?:full\s+)?(?:compliance|conformity|conformance)\s+with${SEP}${STANDARD}`,
    // "ASVS Level 2 compliance", "CRA conformity" — the noun form used as a possession:
    // "achieves CRA conformity", "delivers ASVS L2 compliance". Only when a claim verb
    // stands before it, so "CRA conformity is a manufacturer's legal act" stays legal.
    String.raw`\b${VERB}(?:\s+(?:at|to|with|as|for))?${SEP}${STANDARD}${CLOSE}(?:compliance|conformity|conformance|certification)\b`,
  ].join('|'),
  'gi',
)

/** Words that make the surrounding sentence a denial rather than an assertion.
 *
 * Kept identical to the maturity sweep's vocabulary — including the second group
 * (`indefensible`, `disproven`, `unearned`), which exists because the first thing that
 * sweep found was a LABELLED COUNTER-EXAMPLE quoting the claim in order to reject it. A
 * rule that cannot read a counter-example forces the material that explains the rule to be
 * deleted or exempted, and both are worse than the rule. */
const NEGATION =
  /\b(?:no|not|never|nothing|neither|nor|cannot|can['’]?t|without|unable|impossible|refus\w*|den(?:y|ies|ied)|declin\w*|false\w*|mislead\w*|overstat\w*|inflat\w*|overclaim\w*|myth|wrong|indefensib\w*|untrue|disprov\w*|refut\w*|prohibit\w*|forbid\w*|unearned|ban(?:s|ned)?)\b/i

/** How far back to read for a negation. Long enough to cross a markdown soft wrap,
 * short enough that a denial two paragraphs up cannot launder a fresh claim. */
const WINDOW = 400

/**
 * The sentence (or clause) a match sits in, read backwards from the match. Stops at the
 * nearest sentence terminator, paragraph break, or WINDOW chars — whichever comes last.
 * Prose soft-wraps mid-sentence, so a plain newline is NOT a boundary.
 * @param {string} text
 * @param {number} at
 * @returns {string}
 */
function sentenceBefore(text, at) {
  const from = Math.max(0, at - WINDOW)
  const chunk = text.slice(from, at)
  let start = 0
  for (const m of chunk.matchAll(/[.!?](?=\s)|\n[ \t]*\n/g)) {
    start = (m.index ?? 0) + m[0].length
  }
  return chunk.slice(start)
}

/**
 * Every unearned ASVS/MASVS/CRA standing claim in a text, with 1-based line numbers.
 * @param {string} text
 * @returns {Array<{ line: number, claim: string }>}
 */
export function standardsClaims(text) {
  /** @type {Array<{ line: number, claim: string }>} */
  const out = []
  for (const m of text.matchAll(CLAIM)) {
    const at = m.index ?? 0
    if (NEGATION.test(sentenceBefore(text, at))) continue
    out.push({
      line: text.slice(0, at).split('\n').length,
      claim: m[0].replace(/\s+/g, ' ').trim(),
    })
  }
  return out
}
