// scripts/lib/maturity-claim.mjs — the one sentence this repository must never ship.
//
// v0.9.9 added a machine-checked map of all 149 requirements of ASD's Essential Eight
// Maturity Level Three. The research that produced it also produced the reason the map
// must never become a claim: maturity attaches to an ORGANISATION'S SYSTEM, ASD certifies
// no products, and a repo-scoped reading of the model collapses to Maturity Level Zero
// rather than Three (one strategy has no reachable requirements in a web + mobile stack,
// and risk-accepting a strategy forces the whole implementation to zero). So the register
// is worth having and the claim built on top of it would be false — in the direction that
// sells.
//
// That asymmetry is exactly why a sweep exists rather than a note in CONTRIBUTING. The
// pressure to write the sentence arrives later than the review that would catch it: a
// README edit for a launch, a changelog line, a design doc quoting a customer question.
// Every one of those lands in a file no gate reads for meaning. This one does.
//
// WHAT IT MATCHES is the AFFIRMATIVE form only — a claim verb adjacent to a level token,
// or a level token used as an adjective. Describing the model, quoting a requirement,
// counting requirements, and DENYING the claim must all stay legal, because the map's own
// documentation does all four on nearly every page. So each hit is re-judged against the
// sentence it sits in and dropped when that sentence negates it.
//
// ITS STATED LIMIT, in the shape docs/harness/enforcement-tiers.md asks for: it names the
// claim shapes it knows. A novel phrasing — "assessment-ready to the highest tier", a
// number dressed as a level — walks past it, and that half belongs to the reviewer. What
// it buys is that the OBVIOUS sentence, the one somebody writes in a hurry, cannot land.

/** Punctuation that can sit between a claim verb and the level it claims: markdown
 * emphasis, quotes, brackets. `is **Maturity Level Three**` is the same claim as
 * `is Maturity Level Three`, and a matcher that only reads spaces says otherwise. */
const SEP = String.raw`[\s"'*_‘’“”(\[]+`

/** A maturity level, spelled any of the ways the material spells it. */
const LEVEL = String.raw`(?:(?:ASD['’]?s?\s+)?(?:the\s+)?(?:Essential[\s-]?Eight\s+)?Maturity\s+Level\s+(?:Zero|One|Two|Three|[0-3])\b|ML[0-3]\b)`

/** Verbs that turn a mention into an assertion. */
const VERB = String.raw`(?:achiev\w*|attain\w*|meets?|met|satisf\w*|deliver\w*|guarantee\w*|reach\w*|is|are|was|were|becomes?|became|certified|accredited|assessed|rated|assured|conforms?|compliant|complies)`

const CLAIM = new RegExp(
  [
    // "achieves ML3", "is Maturity Level Three", "certified at ML3", "compliant with ML3"
    String.raw`\b${VERB}(?:\s+(?:at|to|with|as|for))?${SEP}${LEVEL}`,
    // "ML3-compliant", "Maturity Level Three certified"
    String.raw`${LEVEL}[\s-]*(?:compliant|certified|accredited|conformant|assured|ready)\b`,
    // "Essential Eight compliant" — the level left implicit, the claim unchanged.
    String.raw`Essential[\s-]?Eight[\s-]*(?:compliant|certified|accredited|conformant)\b`,
  ].join('|'),
  'gi',
)

/** Words that make the surrounding sentence a denial rather than an assertion.
 *
 * The second group — `indefensible`, `disproven`, `unearned` — is here because the first
 * thing this sweep found was a LABELLED COUNTER-EXAMPLE: the frozen research artefact
 * records the defensible sentence beside the indefensible one, quoting the claim in order
 * to reject it. A rule that cannot read a counter-example forces the material that
 * explains the rule to be deleted or exempted, and both are worse than the rule. */
const NEGATION =
  /\b(?:no|not|never|nothing|neither|nor|cannot|can['’]?t|without|unable|impossible|refus\w*|den(?:y|ies|ied)|declin\w*|false\w*|mislead\w*|overstat\w*|inflat\w*|overclaim\w*|myth|wrong|indefensib\w*|untrue|disprov\w*|refut\w*|prohibit\w*|forbid\w*|unearned)\b/i

/** How far back to read for a negation. Long enough to cross a markdown soft wrap,
 * short enough that a denial two paragraphs up cannot launder a fresh claim. */
const WINDOW = 400

/**
 * The sentence (or clause) a match sits in, read backwards from the match.
 * Stops at the nearest sentence terminator, paragraph break, or WINDOW chars —
 * whichever comes last. Prose soft-wraps mid-sentence, so a plain newline is NOT a
 * boundary: "it never claims\nthe application IS ML3" is one sentence, and treating the
 * wrap as a stop would hide the `never` that makes it legal.
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
 * Every unearned maturity claim in a text, with 1-based line numbers.
 * @param {string} text
 * @returns {Array<{ line: number, claim: string }>}
 */
export function maturityClaims(text) {
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
