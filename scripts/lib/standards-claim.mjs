// scripts/lib/standards-claim.mjs — the ASVS/MASVS/CRA sentence this repository must never
// ship, as the factory sees it.
//
// THE JUDGEMENT IS THE SHIPPED ONE, re-exported rather than re-implemented. The regex and
// the negation window live in template/base/tools/lib/standards-claim.mjs, because the
// CONSUMER gate (tools/check-conformance-map.mjs) applies the identical ban to the
// register's own note/negativeProof/comment text on every validate — and a template gate
// cannot import scripts/ (the npm `files` list ships only installer/ and template/, so the
// import would resolve on the harness's checkout and be missing on every install). Two
// copies of "is this sentence a claim" is how the factory sweep and the consumer gate come
// to disagree about one sentence; this file is the direction of the dependency, made
// explicit. Same argument as scripts/check-essential-eight-evidence.mjs importing
// template/base/tools/lib/essential-eight.mjs.
//
// What is factory-specific — and so lives here — is the SURFACE: which repo paths
// scripts/hygiene.mjs sweeps. The maturity sweep reads the whole repository; this one is
// scoped to the places a standing claim would naturally land — the root README and
// CHANGELOG, every shipped markdown page (template/**/*.md), and the shipped tools/*.json
// registers (the conformance map itself, its E8 sibling, and every other policy file a
// consumer receives). Design notes and machinery comments are deliberately outside it: a
// design doc quoting the sentence in order to reject it is exactly the counter-example the
// negation window exists for, and the design tree is where those get written.
// SOURCE: template/base/tools/lib/standards-claim.mjs (the judgement) · scripts/lib/
// maturity-claim.mjs (the sweep this parallels)
export { standardsClaims } from '../../template/base/tools/lib/standards-claim.mjs'

/**
 * Whether a repo-relative path is inside the standards-claim sweep's surface.
 * @param {string} relPath POSIX, repo-relative
 * @returns {boolean}
 */
export function inStandardsClaimSurface(relPath) {
  if (relPath === 'README.md' || relPath === 'CHANGELOG.md') return true
  if (relPath.startsWith('template/') && relPath.endsWith('.md')) return true
  return /^template\/base\/tools\/[^/]+\.json$/.test(relPath)
}
