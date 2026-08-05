// The claims gate (G12) must be TRUE on the shipped docs and must be able to RED.
// The source harness's v0.1.5 shipped a README claiming cold ≈70 s while the CHANGELOG
// claimed ≈85 s for the same release, and "21 gates" was never recomputed — a harness
// whose headline is "prove, don't claim" cannot ship unverified numbers about itself.
//
// scripts/check-claims.mjs takes NO positional overrides — every input path is
// import.meta.url-relative. So the red cases run a byte-identical COPY of the script
// inside a fixture tree that mirrors the repo layout (README/CHANGELOG/harness.config/
// guard-rules/injections.json are all fixture-controlled), and the live repo is pinned
// green as-is. Both claim classes are exercised: DERIVABLE (chain length, canary-registry
// size, guard-rule ids — recomputed from the source of truth) and CONSISTENT (README vs
// latest CHANGELOG entry wall-clock timings).
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../../scripts/check-claims.mjs', import.meta.url))
const SCRIPT_BYTES = readFileSync(SCRIPT, 'utf8')

function cleanEnv() {
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  delete env.GITHUB_BASE_REF
  return env
}

// A 3-step chain, a 3-step canary registry, and 2+1+1 = 4 guard-rule ids — small
// fixed truths so every claim below is unambiguous.
const FIXTURE_CONFIG =
  "export const VALIDATE_STEPS = [['a', 'x'], ['b', 'x'], ['c', 'x']]\nexport const STOP_HOOK_STEPS = []\n"
const FIXTURE_GUARDS = [
  "export const BASH_RULES = [{ id: 'r-one' }, { id: 'r-two' }]",
  "export const WRITE_PROTECTED = [{ id: 'w-one' }]",
  "export const WRITE_GLOBAL_CHECKS = [{ id: 'g-one' }]",
  '',
].join('\n')
const FIXTURE_REGISTRY = JSON.stringify({ steps: { a: [], b: [], c: [] } })

/**
 * Mirror the repo layout the script's import.meta.url-relative reads expect,
 * then run the copied script from inside it.
 * @param {{ readme: string, changelog?: string, registry?: string | null }} parts
 */
function runFixture({ readme, changelog = '## [0.1.0]\nnothing measured\n', registry = FIXTURE_REGISTRY }) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-claims-'))
  const files = {
    'scripts/check-claims.mjs': SCRIPT_BYTES,
    'template/base/tools/harness.config.mjs': FIXTURE_CONFIG,
    'template/base/.claude/hooks/lib/guard-rules.mjs': FIXTURE_GUARDS,
    'README.md': readme,
    'CHANGELOG.md': changelog,
  }
  if (registry !== null) files['tests/canary/injections.json'] = registry
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  const r = spawnSync('node', [join(dir, 'scripts/check-claims.mjs')], { encoding: 'utf8', env: cleanEnv() })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

test('GREEN: the shipped README claims match the computed truth (live repo, no overrides)', () => {
  const r = spawnSync('node', [SCRIPT], { encoding: 'utf8', env: cleanEnv() })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  assert.equal(r.status, 0, out)
  assert.match(out, /CLAIMS: CLEAN/)
})

test('GREEN: a fixture whose every claim is true is CLEAN — and only the LATEST changelog entry is compared', () => {
  const r = runFixture({
    readme:
      'The chain runs all 3 gates; the canary registry 9 → 3 steps; 4 guard-rule ids.\n' +
      'Warm validate ≈ measured cold ≈ 70 s and warm ≈ 5 s.\n',
    changelog:
      '## [0.1.0]\ncold ≈ 70 s, warm ≈ 5 s\n\n' +
      '## [0.0.9]\ncold ≈ 99 s, warm ≈ 9 s (older entry — must be ignored)\n',
  })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /CLAIMS: CLEAN \(chain 3 steps, canary 3 steps, 4 guard-rule ids, \d+ executed canary legs, gates-catalog chain count in lockstep; README\/CHANGELOG timings agree\)/)
})

test('RED (DERIVABLE): a drifted chain-length claim fails, naming the true count', () => {
  const r = runFixture({ readme: 'This harness runs all 4 gates.\n' })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /4 gates\/steps.*VALIDATE_STEPS has 3/s)
})

test('RED (DERIVABLE): a drifted canary-registry claim fails against the real registry size', () => {
  // "3 steps" equals the chain truth, so ONLY the canary class reds here.
  const r = runFixture({
    readme: 'canary registry 9 → 3 steps\n',
    registry: JSON.stringify({ steps: { a: [], b: [] } }), // truth: 2
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /README claims a 3-step canary registry but tests\/canary\/injections\.json has 2/)
})

test('RED (DERIVABLE): a drifted guard-rule-id count fails against the exported rule tables', () => {
  const r = runFixture({ readme: 'There are 9 guard-rule ids.\n' })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /README claims 9 guard-rule ids but guard-rules\.mjs exports 4/)
})

test('RED (CONSISTENT): README and the latest CHANGELOG entry disagreeing on a timing fails', () => {
  const r = runFixture({
    readme: 'cold ≈ 70 s, warm ≈ 5 s\n',
    changelog: '## [0.1.0]\ncold ≈ 85 s, warm ≈ 5 s\n',
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /README says cold ≈ 70 s but the latest CHANGELOG entry says cold ≈ 85 s/)
})

test('NOTE: a missing canary registry SKIPS the canary class loudly — never crashed on, never silently passed', () => {
  const r = runFixture({
    readme: 'canary registry 9 → 3 steps\n', // unverifiable without the registry
    registry: null,
  })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /CLAIMS: NOTE — tests\/canary\/injections\.json does not exist yet/)
  assert.match(r.out, /canary registry pending \(W5b\)/)
})
