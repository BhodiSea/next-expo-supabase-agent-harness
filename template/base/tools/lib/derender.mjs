// tools/lib/derender.mjs — rebuild a template SOURCE from an installed, placeholder-rendered
// copy (1.1.0, #84). Pure: no imports, no side effects, no fs.
//
// A copy of `derender` in the harness installer's lib/provenance.mjs, which `update` uses to
// tell a file a release shipped from a fork. An install has no installer/ directory, and
// gate-integrity needs the same answer for the escape lists: tools/lib/planted-shas.json
// records the sha of each planted list's SOURCE, tokens intact, plus where the tokens sat, so
// a list rendered with this project's answers is compared after its tokens are put back. Two
// copies are one more than the drift-is-invisible rule likes, so the factory pins them to
// each other on a shared set of cases (tests/gates/derender-parity.test.mjs).
// SOURCE: docs/harness/README.md (tamper evidence) [corpus: harness/doctrine]

// What sits at one site of an installed copy: the literal token (no answer existed when the
// file was rendered — an install upgraded from before the token shipped — even if one was
// backfilled since), else the answer's value. Literal first, so a later backfill can never
// turn an untouched file into a mismatch.
/** @param {string} text @param {number} at @param {string} literal @param {unknown} value */
function consumedAt(text, at, literal, value) {
  if (text.startsWith(literal, at)) return literal.length
  if (value !== undefined && text.startsWith(String(value), at)) return String(value).length
  return null
}

/**
 * Rebuild the template SOURCE from an installed, placeholder-rendered copy, or null.
 *
 * Walks the recorded sites in order — never a search: an owners handle can occur anywhere in
 * a list and only the offset says which occurrence was the token. Null means a site does not
 * hold (the rendered value was edited, the answers changed since install, or the sites are
 * not ascending); an edit anywhere ELSE survives into the rebuilt text and moves its sha.
 * Either way the caller reads "not what a release planted".
 *
 * @param {string} installed
 * @param {Array<[number, string]>} sites [offset in the SOURCE, bare token name]
 * @param {Record<string, unknown>} answers
 * @returns {string | null}
 */
export function derender(installed, sites, answers) {
  let out = ''
  let cursor = 0 // into `installed`
  let sourceAt = 0 // into the source being rebuilt
  for (const [offset, token] of sites) {
    const gap = offset - sourceAt
    if (gap < 0 || cursor + gap > installed.length) return null
    const literal = `{{${token}}}`
    const consumed = consumedAt(installed, cursor + gap, literal, answers[token])
    if (consumed === null) return null
    out += installed.slice(cursor, cursor + gap) + literal
    cursor += gap + consumed
    sourceAt = offset + literal.length
  }
  return out + installed.slice(cursor)
}
