// The converted-gates ratchet (2.1.0, #185): scripts/advisory-ratchet.json.
//
// The list names every producer whose findings go through the advisory recorder
// (tools/lib/gate.mjs noteAdvisory) and whose leg writes its terminator (noteComplete), each
// mapped to the families that have joined issues. A producer that is listed but never writes
// a terminator would read as covered while every one of its legs reads as incomplete, so
// nothing could ever close; a family outside the recorder's enum is one no record can carry.
// Both red here, on the real list and, to prove the check can fail, on a mutated copy.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ADVISORY_PRODUCERS, ADVISORY_RULES } from '../../template/base/tools/lib/gate.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const RATCHET = 'scripts/advisory-ratchet.json'
// Each producer's script, scaffold-relative under template/base. A producer joins this map in
// the item that converts it.
const PRODUCER_SCRIPTS = {
  duplication: 'tools/check-duplication.mjs',
  'query-shapes': 'tools/check-query-shapes.mjs',
  parity: 'tools/check-mobile-parity.mjs',
  contracts: 'tools/check-contract-drift.mjs',
  i18n: 'tools/check-i18n.mjs',
}

// A call, not a mention: `noteComplete(` or `noteComplete?.(` with the producer's name as the
// literal `producer`, on a line that is not a comment.
const COMPLETE_RE = /\bnoteComplete(?:\?\.)?\(\s*\{\s*producer:\s*'([\w-]+)'/g

/** @param {string} src @returns {Set<string>} the producers `src` writes a terminator for */
function terminatorsIn(src) {
  const code = src
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
  return new Set([...code.matchAll(COMPLETE_RE)].map((m) => m[1]))
}

/**
 * Every way the list fails its two rules.
 * @param {unknown} ratchet the parsed list
 * @param {(script: string) => string} readScript scaffold-relative path -> source
 * @returns {string[]}
 */
function ratchetProblems(ratchet, readScript) {
  const converted = /** @type {any} */ (ratchet)?.converted
  if (converted === null || typeof converted !== 'object' || Array.isArray(converted)) {
    return [`${RATCHET} must hold a "converted" object of producer -> families`]
  }
  const problems = []
  for (const [producer, families] of Object.entries(converted)) {
    if (!ADVISORY_PRODUCERS.includes(producer)) {
      problems.push(`${producer} is not a producer the recorder knows (ADVISORY_PRODUCERS)`)
      continue
    }
    const script = PRODUCER_SCRIPTS[producer]
    if (script === undefined) problems.push(`${producer} has no script in this test's PRODUCER_SCRIPTS`)
    else if (!terminatorsIn(readScript(script)).has(producer)) {
      problems.push(`${producer} is listed as converted, but ${script} never calls noteComplete({ producer: '${producer}', … })`)
    }
    if (!Array.isArray(families)) {
      problems.push(`${producer} must map to an array of families`)
      continue
    }
    for (const family of families) {
      if (!ADVISORY_RULES[producer].includes(family)) {
        problems.push(`${producer} lists the family ${JSON.stringify(family)}, which is not in the recorder's enum (ADVISORY_RULES)`)
      }
    }
  }
  return problems
}

const ratchet = JSON.parse(readFileSync(new URL(`../../${RATCHET}`, import.meta.url), 'utf8'))
/** @param {string} script */
const readTemplate = (script) => readFileSync(`${ROOT}template/base/${script}`, 'utf8')

test('the ratchet list holds: every converted producer writes its terminator, every family is in the enum', () => {
  assert.deepEqual(ratchetProblems(ratchet, readTemplate), [])
  assert.ok(Object.hasOwn(ratchet.converted, 'duplication'), 'duplication is the first converted producer (#185)')
})

test('the ratchet reds when the noteComplete call is removed from check-duplication.mjs', () => {
  const src = readTemplate('tools/check-duplication.mjs')
  const call = "gateLib.noteComplete?.({ producer: 'duplication', leg: 'l0' })\n"
  assert.ok(src.includes(call), 'precondition: the call is there to remove')
  const without = (/** @type {string} */ script) =>
    script === 'tools/check-duplication.mjs' ? src.replace(call, '') : readTemplate(script)
  assert.deepEqual(ratchetProblems(ratchet, without), [
    "duplication is listed as converted, but tools/check-duplication.mjs never calls noteComplete({ producer: 'duplication', … })",
  ])
  // A call that survives only in a comment does not count.
  const commented = (/** @type {string} */ script) =>
    script === 'tools/check-duplication.mjs' ? src.replace(call, `// ${call}`) : readTemplate(script)
  assert.equal(ratchetProblems(ratchet, commented).length, 1)
})

test('the ratchet reds on a family outside the enum, an unknown producer, and a malformed list', () => {
  assert.deepEqual(ratchetProblems({ converted: { duplication: ['exact', 'wire-orphan'] } }, readTemplate), [
    'duplication lists the family "wire-orphan", which is not in the recorder\'s enum (ADVISORY_RULES)',
  ])
  assert.match(ratchetProblems({ converted: { tenancy: [] } }, readTemplate)[0], /not a producer the recorder knows/)
  assert.match(ratchetProblems({ converted: { embeddings: [] } }, readTemplate)[0], /no script/)
  assert.match(ratchetProblems({ converted: { duplication: 'exact' } }, readTemplate)[0], /array of families/)
  assert.match(ratchetProblems({ converted: [] }, readTemplate)[0], /"converted" object/)
})
