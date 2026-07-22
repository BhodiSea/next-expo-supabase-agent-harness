// Can-fail proofs for the machinery complexity ratchet (G16). The arithmetic lives in
// scripts/lib/complexity.mjs, so it is tested here as a pure function — measured scores in,
// problems out — without a 15-second ESLint run (scripts/check-complexity-ratchet.mjs only
// supplies the measurements by re-linting with --no-inline-config).
//
// The gate this backs is the one that stops the harness exempting ITSELF from the
// cognitive-complexity <= 15 bar it enforces on every consumer: a disable directive
// suppresses the rule entirely, so `eslint .` stays green while a disabled function grows
// without limit. These tests pin the comparison.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareComplexity, identify, keyScores, scoreOf } from '../../scripts/lib/complexity.mjs'

const record = { limit: 15, functions: { 'a.mjs::foo': 20, 'b.mjs::bar': 30 } }

test('a function that stayed at or below its record is clean', () => {
  const { problems, improved } = compareComplexity(
    new Map([['a.mjs::foo', 20], ['b.mjs::bar', 30]]),
    record,
  )
  assert.equal(problems.length, 0)
  assert.equal(improved.length, 0)
})

test('GREW: a ratcheted function that increased reds — the promise nothing kept', () => {
  const { problems } = compareComplexity(new Map([['a.mjs::foo', 21], ['b.mjs::bar', 30]]), record)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /GREW to 21 from a recorded 20/)
})

test('NEW: an over-limit function with no record reds — the next function is not free', () => {
  const { problems } = compareComplexity(
    new Map([['a.mjs::foo', 20], ['b.mjs::bar', 30], ['c.mjs::baz', 18]]),
    record,
  )
  assert.equal(problems.length, 1)
  assert.match(problems[0], /c\.mjs::baz: NEW over-limit function at 18/)
})

test('STALE: a record whose function is gone reds — bank the win, do not hoard the budget', () => {
  const { problems } = compareComplexity(new Map([['a.mjs::foo', 20]]), record)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /b\.mjs::bar: recorded at 30 but no longer over the limit/)
})

test('improvement is reported, not failed — so the headroom can be banked deliberately', () => {
  const { problems, improved } = compareComplexity(
    new Map([['a.mjs::foo', 17], ['b.mjs::bar', 30]]),
    record,
  )
  assert.equal(problems.length, 0)
  assert.deepEqual(improved, [['a.mjs::foo', 17, 20]])
})

test('identify: reads the function name off a declaration, position-independently', () => {
  assert.equal(identify('export async function init(opts) {'), 'init')
  assert.equal(identify('export function mergeClaudeSettings(a, b) {'), 'mergeClaudeSettings')
  assert.equal(identify('  const parseThing = (x) => {'), 'parseThing')
})

test('identify: an anonymous callback falls back to normalized declaration text', () => {
  const id = identify('  entries.forEach((entry, i) => {')
  assert.match(id, /^anon\(/)
  // Stable across line shifts — it is the text, not a line number.
  assert.equal(id, identify('\t\tentries.forEach((entry, i) => {  '))
})

test('scoreOf: extracts the measured score, or null for an unrelated message', () => {
  assert.equal(scoreOf('Refactor this function to reduce its Cognitive Complexity from 133 to the 15 allowed.'), 133)
  assert.equal(scoreOf('some other lint message'), null)
})

test('keyScores: distinct names all measured; no collision', () => {
  const { measured, collisions } = keyScores([
    { base: 'a.mjs::foo', score: 30 },
    { base: 'a.mjs::bar', score: 16 },
  ])
  assert.deepEqual(collisions, [])
  assert.equal(measured.get('a.mjs::foo'), 30)
  assert.equal(measured.get('a.mjs::bar'), 16)
})

test('keyScores: two OVER-LIMIT functions sharing a name are REFUSED, not guessed', () => {
  // The occurrence-index scheme (the first fix) was itself broken by an adversarial review: a
  // same-named sibling CROSSING the complexity limit renumbers the indices, so a real regression
  // can slide into a vacated slot and read as "improved". ESLint only reports over-limit
  // functions, so there is no stable occurrence population — the honest response is to refuse the
  // ambiguity and make the human give them distinct names, never to pick one silently.
  const { measured, collisions } = keyScores([
    { base: 'a.mjs::handle', score: 30 },
    { base: 'a.mjs::handle', score: 16 },
    { base: 'a.mjs::other', score: 20 },
  ])
  assert.deepEqual(collisions, ['a.mjs::handle'])
  // The colliding name is NOT in measured (it is reported as a collision, not scored).
  assert.equal(measured.has('a.mjs::handle'), false)
  assert.equal(measured.get('a.mjs::other'), 20)
})
