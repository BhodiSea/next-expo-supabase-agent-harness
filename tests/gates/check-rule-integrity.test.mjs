// Can-fail proofs for the config-rule integrity check (G28, config-driven half). The
// comparison lives in scripts/lib/rule-integrity.mjs, tested here as a pure function.
//
// This is the canary for the boundary rules the runner-kind steps cannot see fire: a depcruise
// architecture rule or an eslint import-ban that is DELETED, WEAKENED, or STARVED of files leaves
// the gate running and exiting 0 over code it should reject. The last two cases (severity flip /
// scope broadening on eslint; options-shrink on depcruise) were holes an adversarial review of
// the source harness's v0.1.6 confirmed in the first cut — this file pins all of them, plus the
// real script + record staying green over the shipped configs.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { compareRules, hashText, hashValue, ruleHash } from '../../scripts/lib/rule-integrity.mjs'

const ruleA = { name: 'mobile-not-into-server', severity: 'error', from: { path: '^apps/mobile' }, to: { path: '^apps/server' } }
const ruleB = { name: 'db-context-dal-only', severity: 'error', from: { pathNot: '^apps/server' }, to: { path: 'db/context' } }
const OPTIONS = { doNotFollow: { path: 'node_modules' }, tsPreCompilationDeps: true }
const ESLINT_TEXT = "...'no-restricted-imports': ['error', { patterns: [{ group: ['expo-secure-store'] }] }]..."

const record = {
  depcruise: { [ruleA.name]: ruleHash(ruleA), [ruleB.name]: ruleHash(ruleB) },
  depcruiseOptions: hashValue(OPTIONS),
  eslintConfigSha: hashText(ESLINT_TEXT),
}
const clean = { depcruise: [ruleA, ruleB], depcruiseOptions: OPTIONS, eslintText: ESLINT_TEXT }

test('an unchanged config is clean', () => {
  assert.deepEqual(compareRules(clean, record), [])
})

test('a DELETED depcruise rule reds — the silently no-op\'d boundary G28 exists for', () => {
  const problems = compareRules({ ...clean, depcruise: [ruleA] }, record)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /'db-context-dal-only' is in the integrity record but GONE/)
})

test('a WEAKENED depcruise rule reds — a narrowed regex keeps the name but neuters the rule', () => {
  const weakened = { ...ruleB, from: { pathNot: '^apps/server/NEVER-MATCHES' } }
  const problems = compareRules({ ...clean, depcruise: [ruleA, weakened] }, record)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /'db-context-dal-only' CHANGED/)
})

test('a NEW unregistered depcruise rule reds — the record cannot fall behind the config', () => {
  const extra = { name: 'brand-new-rule', severity: 'error', from: {}, to: { path: 'x' } }
  const problems = compareRules({ ...clean, depcruise: [ruleA, ruleB, extra] }, record)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /'brand-new-rule' exists in the config but is NOT in the integrity record/)
})

test('SHRINKING depcruise scan options reds — starving rules of files neuters them all at once (G28 finding 3)', () => {
  // No rule OBJECT changed, so every ruleHash still matches; only the scanned set shrank.
  const starved = { ...clean, depcruiseOptions: { ...OPTIONS, exclude: { path: '.' } } }
  const problems = compareRules(starved, record)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /depcruise OPTIONS changed/)
})

test('a WEAKENED eslint ban reds even with the group array intact (G28 finding 2)', () => {
  // Severity flipped 'error' -> 'off': the banned group substring is still present, but the ban
  // is off. A substring check would pass; the full-text hash catches it.
  const flipped = { ...clean, eslintText: ESLINT_TEXT.replace("'error'", "'off'") }
  const problems = compareRules(flipped, record)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /template\/base\/eslint\.config\.mjs changed/)
})

test('hashes are order-stable for equal input and distinct for different', () => {
  assert.equal(ruleHash(ruleA), ruleHash({ ...ruleA }))
  assert.notEqual(ruleHash(ruleA), ruleHash(ruleB))
  assert.equal(hashText('a\r\nb'), hashText('a\nb')) // CRLF-normalised
})

test('GREEN: the real script over the shipped configs + scripts/rule-integrity.json is CLEAN', () => {
  // The record file and both shipped configs are repo-committed; the gate reads
  // them via its own hardcoded repo-root paths, so this is the live lockstep.
  const script = fileURLToPath(new URL('../../scripts/check-rule-integrity.mjs', import.meta.url))
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  delete env.GITHUB_BASE_REF
  const r = spawnSync('node', [script], { encoding: 'utf8', env })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  assert.equal(r.status, 0, out)
  assert.match(out, /RULE INTEGRITY: CLEAN/, out)
})
