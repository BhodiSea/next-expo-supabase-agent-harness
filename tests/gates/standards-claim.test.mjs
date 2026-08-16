// Can-fail proofs for the ASVS/MASVS/CRA standing-claim judgement — the sentence this
// repository must never ship, and the sentences it must stay free to write.
//
// The judgement is template/base/tools/lib/standards-claim.mjs; scripts/lib/standards-claim.mjs
// re-exports it for the factory sweep in scripts/hygiene.mjs, and the consumer gate
// (tools/check-conformance-map.mjs) applies it to the register's own prose. Both directions
// are proven here on purpose: a matcher that catches the claim but also bites the DENIAL
// forces the material explaining the rule to be deleted or exempted, and every page of the
// conformance map's own documentation is that denial.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inStandardsClaimSurface, standardsClaims } from '../../scripts/lib/standards-claim.mjs'
import { standardsClaims as shipped } from '../../template/base/tools/lib/standards-claim.mjs'

test('the factory re-exports the SHIPPED judgement — one function, two callers', () => {
  assert.equal(standardsClaims, shipped)
})

// ---- affirmative shapes RED ------------------------------------------------------------
const AFFIRMATIVE = [
  'The generated application is ASVS L2-compliant.',
  'Every scaffold ships MASVS-certified.',
  'This template is CRA-compliant out of the box.',
  'The harness meets ASVS Level 2.',
  'The tRPC router conforms to MASVS.',
  'We are compliant with the CRA.',
  'A fresh install achieves ASVS Level 3.',
  'The mobile app is certified to OWASP ASVS 5.0.',
  'Delivered in compliance with the Cyber Resilience Act.',
  'It delivers CRA conformity for every consumer.',
  'The seed is **ASVS Level 2** verified.',
  'MASVS-L1 compliant, by construction.',
  'The generated application satisfies ASVS.',
  'The scaffold passes MASVS 2.1.',
  'Ships ASVS Level Two ready.',
  'Our product is Cyber Resilience Act conformant.',
]
for (const sentence of AFFIRMATIVE) {
  test(`RED: ${JSON.stringify(sentence)}`, () => {
    const hits = standardsClaims(sentence)
    assert.ok(hits.length > 0, `must red: ${sentence}`)
    assert.equal(hits[0].line, 1)
  })
}

test('RED: a claim reports its 1-based line, across markdown emphasis and a soft wrap', () => {
  const text = '# Title\n\nSome preamble.\n\nThe scaffold is\n**ASVS Level 2** compliant today.\n'
  const hits = standardsClaims(text)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].line, 5)
  assert.match(hits[0].claim, /is \*\*ASVS Level 2\*\* compliant/)
})

// ---- denials and descriptions stay GREEN ------------------------------------------------
const LEGAL = [
  'It does NOT claim ASVS Level 2.',
  'It never says the generated application is ASVS Level 1, 2 or 3, MASVS-verified, or CRA-conformant, and no sentence in it may.',
  'The template is not ASVS-compliant and cannot be.',
  'A template cannot hold ASVS Level 2, and a generator cannot confer one.',
  'No sentence here says the app is CRA-compliant.',
  'ASVS 5.0.0 has 345 requirements across 17 chapters.',
  'CRA conformity is a manufacturer’s legal act that no code tree performs.',
  'Requirement 8.2.2 of ASVS bears on the RLS closure; the row is graded covered.',
  'This map does not claim conformance with the CRA.',
  'We refuse to say it meets MASVS.',
  'Nothing here is MASVS-certified, and nothing here will be.',
  'ASVS Level 2 requirements are mapped, not met.',
  'The word ‘compliant’ is banned next to ASVS by the hygiene sweep.',
  'The unmapped ASVS chapter V17 (WebRTC) is not-applicable — no WebRTC surface exists.',
  'MASVS-NETWORK-1 is covered by expo-policy; MASVS-CODE-3 is partial.',
  'An assessor performs the ASVS verification; the map is their starting ledger.',
]
for (const sentence of LEGAL) {
  test(`GREEN: ${JSON.stringify(sentence)}`, () => {
    assert.deepEqual(standardsClaims(sentence), [], `must stay legal: ${sentence}`)
  })
}

test('GREEN: the whole conformance-map header — the densest denial in the tree — passes', async () => {
  const { readFileSync } = await import('node:fs')
  const reg = JSON.parse(
    readFileSync(
      new URL('../../template/base/tools/conformance-map.json', import.meta.url),
      'utf8',
    ),
  )
  assert.deepEqual(standardsClaims(reg.comment.join('\n')), [])
  // ...and every note and negativeProof, which is what the consumer gate sweeps.
  for (const r of reg.requirements) {
    assert.deepEqual(standardsClaims(`${r.note}\n${r.negativeProof ?? ''}`), [], r.id)
  }
})

test('GREEN: the negation window is a SENTENCE, not a paragraph — a denial two sentences back does not launder a fresh claim', () => {
  const text = 'This is not a certification. Nothing here is verified. The app is CRA-compliant.'
  const hits = standardsClaims(text)
  assert.equal(hits.length, 1)
  assert.match(hits[0].claim, /is CRA-compliant/)
})

test('GREEN: a hyphenated word that merely CONTAINS a token is not a token — `crash`, `crab`, `Ascraeus`', () => {
  assert.deepEqual(
    standardsClaims(
      'The first thing an unreviewed call does is crash. It is crab season on Ascraeus.',
    ),
    [],
  )
})

// ---- the factory surface predicate ------------------------------------------------------
test('the sweep surface is README, CHANGELOG, every shipped markdown page and the shipped tools/*.json registers — nothing else', () => {
  for (const p of [
    'README.md',
    'CHANGELOG.md',
    'template/base/docs/compliance/controls-crosswalk.md',
    'template/modules/e2ee/docs/modules/e2ee/README.md',
    'template/base/tools/conformance-map.json',
    'template/base/tools/essential-eight.json',
  ]) {
    assert.ok(inStandardsClaimSurface(p), p)
  }
  for (const p of [
    'CONTRIBUTING.md',
    'design/CONFORMANCE-FACTS.md',
    'scripts/check-claims.mjs',
    'template/base/tools/check-conformance-map.mjs',
    'template/base/tools/generated/action-inventory.json',
    'template/base/tools/mcp/corpus/index.json',
    'tests/canary/injections.json',
  ]) {
    assert.ok(!inStandardsClaimSurface(p), p)
  }
})
