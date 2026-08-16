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
// size, guard-rule ids, the Essential Eight conformance partition — recomputed from the
// source of truth) and CONSISTENT (README vs latest CHANGELOG entry wall-clock timings).
//
// The conformance class (0.9.9) is the only one judged for ABSENCE as well as drift, and
// the reason is in its own section at the bottom of this file.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../../scripts/check-claims.mjs', import.meta.url))
const SCRIPT_BYTES = readFileSync(SCRIPT, 'utf8')
const BUDGET_LIB_BYTES = readFileSync(
  fileURLToPath(new URL('../../scripts/lib/chain-budget.mjs', import.meta.url)),
  'utf8',
)
// The Essential Eight judgement, byte-identical for the same reason the budget lib is:
// the fixture must not get a stand-in `summarise()` that could partition a register
// differently from the one that ships.
const E8_LIB_BYTES = readFileSync(
  fileURLToPath(new URL('../../template/base/tools/lib/essential-eight.mjs', import.meta.url)),
  'utf8',
)
// A five-row register, one row per outcome, plus two shared clauses — so the published
// partition is "5 ML3 requirements: 1 effective, 1 alternate-control, 1 not-implemented,
// 1 not-applicable, 1 organisation-boundary; 2 shared clauses" and every figure below is
// unambiguous. Only the fields summarise() reads are present; the register's OTHER
// closures are proven against the SHIPPED file in tests/gates/check-essential-eight.test.mjs.
const FIXTURE_E8 = JSON.stringify({
  requirements: [
    { id: 'A', boundary: 'product', outcome: 'effective' },
    { id: 'B', boundary: 'product', outcome: 'alternate-control' },
    {
      id: 'C',
      boundary: 'product',
      outcome: 'not-implemented',
      obligation: 'e8-fixture',
    },
    { id: 'D', boundary: 'product', outcome: 'not-applicable' },
    { id: 'E', boundary: 'organisation', outcome: null },
  ],
  sharedClauses: [{ id: 'S1' }, { id: 'S2' }],
})
const FIXTURE_E8_SENTENCE =
  '5 ML3 requirements: 1 effective, 1 alternate-control, 1 not-implemented, 1 not-applicable, 1 organisation-boundary; 2 shared clauses'
// The conformance MAP judgement (1.0.0), byte-identical for the same reason: the fixture
// must partition through the shipping summarise(). Four rows, one per outcome, across the
// three standards — so the published sentence is "4 mapped requirements: 1 covered,
// 1 partial, 1 not-covered, 1 not-applicable — ASVS 5.0.0 (2), MASVS 2.1 (1), CRA Annex I (1)".
// The judgement lib imports its sibling standards-claim.mjs, so both are planted.
const CM_LIB_BYTES = readFileSync(
  fileURLToPath(new URL('../../template/base/tools/lib/conformance-map.mjs', import.meta.url)),
  'utf8',
)
const CM_CLAIM_LIB_BYTES = readFileSync(
  fileURLToPath(new URL('../../template/base/tools/lib/standards-claim.mjs', import.meta.url)),
  'utf8',
)
const FIXTURE_CM = JSON.stringify({
  requirements: [
    {
      id: '1.1.1',
      standard: 'asvs',
      level: 1,
      boundary: 'shared',
      outcome: 'covered',
    },
    {
      id: '2.1.1',
      standard: 'asvs',
      level: 2,
      boundary: 'shared',
      outcome: 'partial',
    },
    {
      id: 'MASVS-X-1',
      standard: 'masvs',
      level: null,
      boundary: 'consumer',
      outcome: 'not-covered',
    },
    {
      id: 'CRA-I.1',
      standard: 'cra',
      level: null,
      boundary: 'organisation',
      outcome: 'not-applicable',
    },
  ],
})
const FIXTURE_CM_SENTENCE =
  '4 mapped requirements: 1 covered, 1 partial, 1 not-covered, 1 not-applicable — ASVS 5.0.0 (2), MASVS 2.1 (1), CRA Annex I (1)'

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
 * @param {{ readme: string, changelog?: string, registry?: string | null, measuredWallMs?: number | null, stopWallMs?: number | null, coldWallMs?: number | null, docs?: Record<string, string>, contributing?: string | null, lintYml?: string | null, e8Register?: string | null, cmRegister?: string | null, config?: string, hooks?: string[] }} parts
 */
function runFixture({
  readme,
  changelog = '## [0.1.0]\nnothing measured\n',
  registry = FIXTURE_REGISTRY,
  // Unmeasured by default, which is the state the repo has shipped in since the budget
  // file was introduced — so every fixture below judges prose against a budget that
  // carries no measurement, exactly like the live tree.
  measuredWallMs = null,
  stopWallMs = null,
  // The COLD half (1.0.0) — absent by default, like the others: every earlier fixture that
  // published "cold ≈" against a WARM measurement now needs to say which run it means.
  coldWallMs = null,
  // Extra prose surfaces (template/base/docs/**, design/**, template/base/AGENTS.md) for
  // the 0.9.0 chain-length/chain-cost classes — absent by default, so every pre-0.9.0
  // fixture above stays byte-identical in intent.
  docs = {},
  // CONTRIBUTING.md and lint.yml are absent by default — the 0.7.0 checks are guarded
  // on their existence, so every pre-0.7.0 fixture above stays byte-identical in intent.
  contributing = null,
  lintYml = null,
  // The Essential Eight register is absent by default — its class is guarded on the
  // register existing, so every pre-0.9.9 fixture above stays byte-identical in intent
  // and takes the loud SKIP rather than a silent pass.
  e8Register = null,
  // The conformance map is absent by default for the same reason — its class is guarded
  // on the register existing, so every earlier fixture takes the loud SKIP.
  cmRegister = null,
  config = FIXTURE_CONFIG,
  hooks = ['alpha.mjs', 'beta.mjs'],
}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-claims-'))
  const files = {
    'scripts/check-claims.mjs': SCRIPT_BYTES,
    // The real judge, byte-identical — the fixture must not get a stand-in that could
    // answer `hasCommittedMeasurement` differently from the one that ships.
    'scripts/lib/chain-budget.mjs': BUDGET_LIB_BYTES,
    'scripts/chain-budget.json': JSON.stringify({
      wall: { ceilingMs: 120000, warnMs: 90000, measuredMs: measuredWallMs },
      defaults: { staticCeilingMs: 5000, toolchainCeilingMs: 60000 },
      steps: {},
      ...(stopWallMs === null
        ? {}
        : {
            stopWall: {
              ceilingMs: 600000,
              warnMs: 450000,
              measuredMs: stopWallMs,
            },
          }),
      ...(coldWallMs === null
        ? {}
        : {
            coldWall: { measuredMs: coldWallMs },
            coldMeasurement: {
              recordedOn: '2026-08-16',
              runner: 'fixture',
              chainSteps: 3,
              stepsMeasured: 3,
              path: 'fixture cold run',
            },
          }),
      // A measured budget carries its provenance, and `chainSteps` must equal the fixture
      // chain's length (3, from FIXTURE_CONFIG) or the staleness half correctly refuses it:
      // a figure measured against a different chain is wrong, not merely old.
      ...(measuredWallMs === null
        ? {}
        : {
            measurement: {
              recordedOn: '2026-08-08',
              runner: 'fixture',
              chainSteps: 3,
              stepsMeasured: 3,
            },
          }),
    }),
    'template/base/tools/harness.config.mjs': config,
    'template/base/.claude/hooks/lib/guard-rules.mjs': FIXTURE_GUARDS,
    'README.md': readme,
    'CHANGELOG.md': changelog,
    ...docs,
  }
  // TWO hooks by default — and `lib/guard-rules.mjs` above is the point of the pair: it sits
  // under the same tree and must NOT count, because nothing wires a module.
  for (const hook of hooks) files[`template/base/.claude/hooks/${hook}`] = ''
  if (registry !== null) files['tests/canary/injections.json'] = registry
  if (contributing !== null) files['CONTRIBUTING.md'] = contributing
  if (lintYml !== null) files['.github/workflows/lint.yml'] = lintYml
  if (e8Register !== null) {
    files['template/base/tools/essential-eight.json'] = e8Register
    files['template/base/tools/lib/essential-eight.mjs'] = E8_LIB_BYTES
  }
  if (cmRegister !== null) {
    files['template/base/tools/conformance-map.json'] = cmRegister
    files['template/base/tools/lib/conformance-map.mjs'] = CM_LIB_BYTES
    files['template/base/tools/lib/standards-claim.mjs'] = CM_CLAIM_LIB_BYTES
  }
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  const r = spawnSync('node', [join(dir, 'scripts/check-claims.mjs')], {
    encoding: 'utf8',
    env: cleanEnv(),
  })
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
      'Two hooks are wired, which is also 2 hooks in digits.\n' +
      'Warm validate ≈ measured cold ≈ 70 s and warm ≈ 5 s.\n',
    changelog:
      '## [0.1.0]\ncold ≈ 70 s, warm ≈ 5 s\n\n' +
      '## [0.0.9]\ncold ≈ 99 s, warm ≈ 9 s (older entry — must be ignored)\n',
    // "Every claim is true" now includes the one the 0.6.0 rule added: a published timing
    // must have a committed measurement behind it. This fixture publishes four figures, so
    // without this it is asserting that an unbacked claim is a true one.
    measuredWallMs: 70123,
    // 1.0.0: the fixture publishes a cold figure too, so it carries the cold record as well.
    coldWallMs: 70123,
  })
  assert.equal(r.code, 0, r.out)
  assert.match(
    r.out,
    /CLAIMS: CLEAN \(chain 3 steps, canary 3 steps, 4 guard-rule ids, \d+ executed canary legs, conformance register absent, conformance map absent, gates-catalog chain count in lockstep; README\/CHANGELOG timings agree\)/,
  )
  // The register is absent here, so the conformance class must announce the skip rather
  // than let a green line imply it looked.
  assert.match(r.out, /conformance-figure class is SKIPPED, not passed/)
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
  assert.match(
    r.out,
    /README claims a 3-step canary registry but tests\/canary\/injections\.json has 2/,
  )
})

// THE HOOK COUNT (0.6.0), and this one is a repair rather than a precaution. 0.5.0 wired six
// hooks; the process layer added a seventh, and "Six hooks" survived in the root README twice
// and in the shipped doctrine — whose hook table had also quietly lost the new row. Every
// other count here was derived releases ago; this one was not, because nobody reads "six
// hooks" as a derived number until it is wrong. The WORD form is what shipped, so the word
// form is what the matcher has to catch.
test('RED (0.6.0): a hook count spelled as a WORD reds against the shipped hooks directory', () => {
  const r = runFixture({
    readme: 'Six hooks are wired, each invoked as `node "<path>"`.\n',
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /claims "Six hooks" but template\/base\/\.claude\/hooks\/ ships 2/)
  assert.match(r.out, /alpha\.mjs, beta\.mjs/, 'it must name what it counted')
  assert.ok(!r.out.includes('guard-rules.mjs'), 'lib/ holds modules, and nothing wires a module')
})

test('RED (DERIVABLE): a drifted guard-rule-id count fails against the exported rule tables', () => {
  const r = runFixture({ readme: 'There are 9 guard-rule ids.\n' })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /README claims 9 guard-rule ids but guard-rules\.mjs exports 4/)
})

// THE SOFT-WRAP CLASS (0.6.0). Every matcher in the script is written against a CONTIGUOUS
// phrase, and markdown wraps prose where the column runs out — a place no author chooses and
// no reviewer sees. The live defect: the README carried "the 26 can-fail\n> canaries (counted
// from the matrix itself, not hand-authored)" against a matrix of 29, and this gate passed,
// because the newline plus the blockquote marker sat between the number and the noun. Both
// directions are pinned, because a normaliser that swallowed the phrase entirely would make
// the RED case pass for the wrong reason.
test('RED (0.6.0): a stale claim SOFT-WRAPPED across a blockquote line break still reds', () => {
  const r = runFixture({
    readme: '> There are 9 guard-rule\n> ids in the table.\n',
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /README claims 9 guard-rule ids but guard-rules\.mjs exports 4/)
})

test('GREEN (0.6.0): a TRUE claim soft-wrapped the same way is still clean', () => {
  const r = runFixture({
    readme: '> There are 4 guard-rule\n> ids in the table.\n',
  })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /CLAIMS: CLEAN/)
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

test('RED (0.4.0): a status line with no package.json to check it against is unverified, not clean', () => {
  // The status-line derivation was added in 0.4.0 because the README read
  // "pre-release (0.1.x)" at version 0.3.0 — three minors stale, on the first line a
  // reader trusts. It reads package.json, which the fixture tree deliberately does not
  // model, so the read must FAIL THE CLAIM rather than crash the script: an unguarded
  // readFileSync here took six unrelated cases red with an ENOENT stack.
  const r = runFixture({
    readme: '**Status: pre-release (0.1.x).** The chain runs all 3 gates.\n',
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /no package\.json to check it against/)
  assert.doesNotMatch(r.out, /ENOENT/, `the script must judge the claim, not crash:\n${r.out}`)
})

test('RED (0.6.0): a published wall-clock figure with no COMMITTED measurement behind it', () => {
  // "Measure, commit the measurement, then publish — in that order." That order is
  // scripts/chain-budget.json's own prescription, and until 0.6.0 it was a sentence about a
  // control nobody had written: `hasCommittedMeasurement` was exported, unit-tested, and
  // imported by no production caller. The CONSISTENT check above compares the two documents
  // to EACH OTHER, so two files agreeing on a number neither of them measured was clean —
  // which is the one shape a consistency check structurally cannot see.
  const r = runFixture({
    readme: 'the chain runs cold ≈ 70 s\n',
    changelog: '## [0.1.0]\ncold ≈ 70 s\n',
    measuredWallMs: null,
  })
  assert.equal(r.code, 1, r.out)
  assert.match(
    r.out,
    /README cold ≈ 70 s is published, but scripts\/chain-budget\.json carries no committed measurement/,
  )
  // Both documents are named, not just the README: publishing the figure in the changelog
  // and omitting it from the README would otherwise be a way around the rule.
  assert.match(r.out, /the latest CHANGELOG entry's cold ≈ 70 s is published/)
})

test('GREEN (0.6.0): the SAME figure is fine once a measurement is committed', () => {
  // The rule is about the ORDER, not about the number. Nothing here asserts 70 s is true —
  // no gate can, on someone else's hardware. What it asserts is that a run happened and was
  // recorded before the prose went out. (1.0.0: the figure is now the WARM one, because the
  // warm measurement is what this fixture commits — see the cold-licence test below.)
  const r = runFixture({
    readme: 'the chain runs warm ≈ 70 s\n',
    changelog: '## [0.1.0]\nwarm ≈ 70 s\n',
    measuredWallMs: 70123,
  })
  assert.equal(r.code, 0, r.out)
})

test('RED/GREEN (1.0.0): "cold ≈" is licensed by the COLD measurement only — a warm re-record unlocks no cold figure', () => {
  // Through 0.11.x the cold figure was refused only because the warm licence happened to be
  // missing too; once a warm re-record landed, "cold ≈ N s" would have been publishable
  // against a run nobody made. The two kinds now carry their own licences.
  const warmOnly = runFixture({
    readme: 'the chain runs cold ≈ 200 s\n',
    changelog: '## [0.1.0]\ncold ≈ 200 s\n',
    measuredWallMs: 70123,
  })
  assert.equal(warmOnly.code, 1, warmOnly.out)
  assert.match(
    warmOnly.out,
    /README cold ≈ 200 s is published, but scripts\/chain-budget\.json carries no committed measurement matching the live chain \(coldWall\.measuredMs is null/,
  )
  const both = runFixture({
    readme: 'the chain runs cold ≈ 200 s and warm ≈ 70 s\n',
    changelog: '## [0.1.0]\ncold ≈ 200 s, warm ≈ 70 s\n',
    measuredWallMs: 70123,
    coldWallMs: 200456,
  })
  assert.equal(both.code, 0, both.out)
  // And the cold licence count-matches the live chain like the warm one: a cold record
  // stamped against a different chain length licenses nothing.
  const staleCold = runFixture({
    readme: 'the chain runs cold ≈ 200 s\n',
    changelog: '## [0.1.0]\ncold ≈ 200 s\n',
    measuredWallMs: 70123,
    coldWallMs: 200456,
    config:
      "export const VALIDATE_STEPS = [['a', 'x'], ['b', 'x'], ['c', 'x'], ['d', 'x']]\nexport const STOP_HOOK_STEPS = []\n",
  })
  assert.equal(staleCold.code, 1, staleCold.out)
})

test('GREEN (0.6.0): an unmeasured budget is silent while nobody publishes a figure', () => {
  // The live repo's state, and it must stay clean: the rule fires on a CLAIM, never on the
  // absence of a measurement. A gate that demanded a measurement nobody had asked for would
  // block every release until someone invented one — which is the failure it exists to stop.
  const r = runFixture({ readme: 'no timings here\n', measuredWallMs: null })
  assert.equal(r.code, 0, r.out)
})

test('RED (0.6.0): a measurement taken against a DIFFERENT chain stops licensing the figure', () => {
  // The staleness half, from the consumer's side. A number measured against a 31-step chain
  // and left in place while two steps landed is not old, it is WRONG — and nothing about a
  // committed integer expires on its own, so it would go on unlocking the published figure
  // forever. The fixture chain is 3 steps; a measurement claiming 2 no longer describes it.
  const dir = mkdtempSync(join(tmpdir(), 'epah-claims-stale-'))
  const files = {
    'scripts/check-claims.mjs': SCRIPT_BYTES,
    'scripts/lib/chain-budget.mjs': BUDGET_LIB_BYTES,
    'scripts/chain-budget.json': JSON.stringify({
      wall: { ceilingMs: 120000, warnMs: 90000, measuredMs: 70123 },
      defaults: { staticCeilingMs: 5000, toolchainCeilingMs: 60000 },
      steps: {},
      measurement: {
        recordedOn: '2026-08-08',
        runner: 'fixture',
        chainSteps: 2,
        stepsMeasured: 2,
      },
    }),
    'template/base/tools/harness.config.mjs': FIXTURE_CONFIG,
    'template/base/.claude/hooks/lib/guard-rules.mjs': FIXTURE_GUARDS,
    'template/base/.claude/hooks/alpha.mjs': '',
    'template/base/.claude/hooks/beta.mjs': '',
    'README.md': 'the chain runs cold ≈ 70 s\n',
    'CHANGELOG.md': '## [0.1.0]\nnothing measured\n',
    'tests/canary/injections.json': FIXTURE_REGISTRY,
  }
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  const r = spawnSync('node', [join(dir, 'scripts/check-claims.mjs')], {
    encoding: 'utf8',
    env: cleanEnv(),
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  assert.equal(r.status, 1, out)
  assert.match(out, /carries no committed measurement/)
})

// ── CONTRIBUTING.md (0.7.0): the one document where a derived number survived unchecked ──
// The live defect this class repairs: CONTRIBUTING told a release-cutter "--report-all runs
// all **31** steps" against a 33-step chain, "the **six** HARNESS_HOOK_VERSION stamps"
// against seven shipped hooks, and its Local-development list — which opens with "this list
// is the whole of what CI blocks on" — omitted check-seeded-migrations, a blocking lint.yml
// step. All three were observed red on the real tree before the prose was fixed.

test('RED (0.7.0): CONTRIBUTING claiming 31 steps against a 33-step chain reds, naming the file', () => {
  const r = runFixture({
    readme: 'nothing claimed here\n',
    config: `export const VALIDATE_STEPS = Array.from({ length: 33 }, (_, i) => [\`s\${i}\`, 'x'])\nexport const STOP_HOOK_STEPS = []\n`,
    contributing: '`--report-all` runs all **31** steps and shows every red at once.\n',
  })
  assert.equal(r.code, 1, r.out)
  assert.match(
    r.out,
    /CONTRIBUTING\.md says `--report-all` runs all \*\*31\*\* steps but VALIDATE_STEPS has 33/,
  )
})

test('RED (0.7.0): CONTRIBUTING claiming six stamps against seven shipped hooks reds — soft-wrapped, as it actually shipped', () => {
  const r = runFixture({
    readme: 'nothing claimed here\n',
    hooks: ['h1.mjs', 'h2.mjs', 'h3.mjs', 'h4.mjs', 'h5.mjs', 'h6.mjs', 'h7.mjs'],
    // The claim is wrapped across the line break exactly as the live CONTRIBUTING wraps it —
    // the soft-wrap class the unwrap normaliser exists for.
    contributing:
      '2. Bump the version everywhere the lockstep gate looks: and the **six**\n' +
      '   `HARNESS_HOOK_VERSION` stamps under `template/base/.claude/hooks/`.\n',
  })
  assert.equal(r.code, 1, r.out)
  assert.match(
    r.out,
    /CONTRIBUTING\.md's release list says "\*\*six\*\* HARNESS_HOOK_VERSION stamps" but template\/base\/\.claude\/hooks\/ ships 7/,
  )
})

test('RED (0.7.0): a blocking lint.yml check script absent from the Local-development list reds — advisory steps do not count, nor do mentions outside the section', () => {
  const r = runFixture({
    readme: 'nothing claimed here\n',
    lintYml: [
      'jobs:',
      '  syntax:',
      '    steps:',
      '      - run: node scripts/check-syntax.mjs',
      '      - name: the blocking step the list omits',
      '        run: node scripts/check-widget.mjs',
      '      - name: advisory, must not impose itself on the list',
      '        continue-on-error: true',
      '        run: node scripts/check-advisory.mjs',
      '',
    ].join('\n'),
    contributing: [
      '## Local development',
      '',
      '```sh',
      'node scripts/check-syntax.mjs',
      '```',
      '',
      '## Releases',
      '',
      'A mention of node scripts/check-widget.mjs OUTSIDE the section must not satisfy the closure.',
      '',
    ].join('\n'),
  })
  assert.equal(r.code, 1, r.out)
  assert.match(
    r.out,
    /lint\.yml blocks on `node scripts\/check-widget\.mjs` but CONTRIBUTING\.md's "Local development" list omits it/,
  )
  assert.ok(
    !r.out.includes('check-advisory.mjs'),
    `continue-on-error steps are advisory, not blocking:\n${r.out}`,
  )
  assert.ok(
    !r.out.includes('check-syntax.mjs'),
    `a script present in the list must not be reported:\n${r.out}`,
  )
})

// ── the CHAIN-LENGTH surface widening (0.9.0) ─────────────────────────────────────────
// The two-file claim surface (the shipped doctrine README + validate.mjs's header) missed
// five live '31-step' sites that round-2 of the 0.9.0 research found still claiming a
// 31-step chain against 34 — every one in a file a reader trusts. ANY file under
// template/base/docs/**, template/base/AGENTS.md, design/**, plus README/CONTRIBUTING,
// claiming "the N gates" / "N-step chain" / "N gates, in order" is now judged against the
// derived count. CHANGELOG.md and template/migrations.json are EXCLUDED: an old entry's
// count is a true statement about an old release, and rewriting history to satisfy a
// present-tense claim is the opposite of what this gate is for.

test('RED (0.9.0): a shipped docs file claiming "the N gates" reds against the derived count, naming the file', () => {
  const r = runFixture({
    readme: 'nothing claimed here\n',
    docs: {
      'template/base/docs/harness/enforcement-tiers.md': 'the 31 gates hold the line.\n',
    },
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /enforcement-tiers\.md claims "the 31 gates".*VALIDATE_STEPS has 3/s)
})

test('RED (0.9.0): a design doc claiming an "N-step chain" reds — soft-wrapped, like real prose', () => {
  const r = runFixture({
    readme: 'nothing claimed here\n',
    docs: {
      'design/PORT-SPEC.md': 'the runner executes the 31-step\nchain before anything else.\n',
    },
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /design\/PORT-SPEC\.md claims "31-step chain"/)
})

test('RED (0.9.0): the shipped AGENTS.md claiming "The N gates, in order" reds factory-side too', () => {
  const r = runFixture({
    readme: 'nothing claimed here\n',
    docs: {
      'template/base/AGENTS.md': 'The 31 gates, in order: `a`, `b`, `c`.\n',
    },
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /AGENTS\.md claims "the 31 gates"/i)
})

test('GREEN (0.9.0): true chain-length claims across the widened surface are clean', () => {
  const r = runFixture({
    readme: 'nothing claimed here\n',
    docs: {
      'template/base/docs/harness/enforcement-tiers.md': 'the 3 gates hold the line.\n',
      'design/PORT-SPEC.md': 'the 3-step chain runs first.\n',
    },
  })
  assert.equal(r.code, 0, r.out)
})

test('GREEN (0.9.0): CHANGELOG stays history — a stale count in an old entry is not a live claim', () => {
  const r = runFixture({
    readme: 'nothing claimed here\n',
    changelog: '## [0.1.0]\nthat release ran the 21-step chain, and the 21 gates held.\n',
  })
  assert.equal(r.code, 0, r.out)
})

// ── the CHAIN-COST class (0.9.0) ─────────────────────────────────────────────────────
// Four shipped config comments claimed the warm validate budget was "~6s" against a
// committed measurement of 24337 ms — a number nobody re-read because it lived in a
// comment. Any "~Ns" chain-cost phrase in the live doc/config surfaces must now be
// consistent with scripts/chain-budget.json's committed measuredMs (wall or stopWall),
// and with NO committed measurement no such figure may be published at all — the same
// measure-commit-publish order the README licence enforces, applied to the whole surface.

test('RED (0.9.0): a "~6s" chain-cost comment against a 24337 ms measurement reds, naming the file', () => {
  const r = runFixture({
    readme: 'nothing claimed here\n',
    config: `${FIXTURE_CONFIG}// the mutation lane runs in CI because this chain has a ~6s budget\n`,
    measuredWallMs: 24337,
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /harness\.config\.mjs claims a chain cost of ~6s.*24\.3/s)
})

test('GREEN (0.9.0): a chain-cost figure consistent with the committed wall measurement is clean', () => {
  const r = runFixture({
    readme: 'nothing claimed here\n',
    config: `${FIXTURE_CONFIG}// the whole warm validate chain measures ~24s\n`,
    measuredWallMs: 24337,
  })
  assert.equal(r.code, 0, r.out)
})

test('GREEN (0.9.0): a Stop-chain figure consistent with the committed stopWall measurement is clean', () => {
  const r = runFixture({
    readme: 'nothing claimed here\n',
    docs: {
      'design/NOTES.md': 'the Stop chain turn-end is ~50s wall on the selftest runner.\n',
    },
    measuredWallMs: 24337,
    stopWallMs: 50531,
  })
  assert.equal(r.code, 0, r.out)
})

test('RED (0.9.0): a "~Ns" chain-cost figure with NO committed measurement is unlicensed, wherever it lives', () => {
  const r = runFixture({
    readme: 'nothing claimed here\n',
    docs: { 'design/NOTES.md': 'warm validate is ~24s on a good day.\n' },
    measuredWallMs: null,
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /design\/NOTES\.md.*~24s.*no committed measurement/s)
})

test('GREEN (0.9.0): a "~Ns" figure with no chain context nearby is not a chain-cost claim', () => {
  const r = runFixture({
    readme: 'nothing claimed here\n',
    docs: {
      'design/NOTES.md': 'the splash animation lasts ~2s before the content lands.\n',
    },
    measuredWallMs: 24337,
  })
  assert.equal(r.code, 0, r.out)
})

test('GREEN (0.7.0): a CONTRIBUTING whose counts are true and whose list covers every blocking check is CLEAN', () => {
  const r = runFixture({
    readme: 'nothing claimed here\n',
    lintYml: 'jobs:\n  syntax:\n    steps:\n      - run: node scripts/check-syntax.mjs\n',
    contributing: [
      '## Local development',
      '',
      '```sh',
      'node scripts/check-syntax.mjs',
      '```',
      '',
      '`--report-all` runs all **3** steps. Bump the **2**',
      '`HARNESS_HOOK_VERSION` stamps.',
      '',
    ].join('\n'),
  })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /CLAIMS: CLEAN/)
})

// ── THE ESSENTIAL EIGHT CONFORMANCE FIGURES (0.9.9) ───────────────────────────────
// A conformance count is the one number in this repository that drifts in a direction
// nobody complains about, so it gets the treatment no other claim here gets: it is
// judged as a whole PARTITION, and it is judged for ABSENCE as well as for drift.
// Deleting the sentence must not be the cheap way past a red — a compliance standing
// that quietly vanishes is not a corrected claim, it is a product nobody can audit.

test('GREEN (0.9.9): a README stating the whole partition, matching the register, is CLEAN', () => {
  const r = runFixture({
    readme: `The standing: ${FIXTURE_E8_SENTENCE}.\n`,
    e8Register: FIXTURE_E8,
  })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /E8 5 rows \/ 1 effective/)
})

test('RED (0.9.9): a generous conformance figure fails, naming the register as the truth', () => {
  // The realistic drift: `effective` alone is inflated, everything else left true. A
  // matcher that read one number at a time would still have caught this one; the reason
  // the whole partition is matched as a single phrase is the drift NEXT to it — quoting
  // only the flattering half, which no per-number check can see.
  const r = runFixture({
    readme: `The standing: ${FIXTURE_E8_SENTENCE.replace('1 effective', '4 effective')}.\n`,
    e8Register: FIXTURE_E8,
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /README\.md publishes "4 effective".*grades 1/s)
})

test('RED (0.9.9): deleting the sentence is not a way past a wrong number', () => {
  const r = runFixture({
    readme: 'nothing claimed here\n',
    e8Register: FIXTURE_E8,
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /README\.md publishes no Essential Eight standing/)
  // The remediation must hand back the whole partition, not just say "add a number".
  assert.match(r.out, /1 effective, 1 alternate-control, 1 not-implemented/)
})

test('RED (0.9.9): the figures are judged on EVERY live prose surface, not only the README', () => {
  const r = runFixture({
    readme: `The standing: ${FIXTURE_E8_SENTENCE}.\n`,
    e8Register: FIXTURE_E8,
    docs: {
      'template/base/docs/compliance/essential-eight.md': `Standing: ${FIXTURE_E8_SENTENCE.replace(
        '1 not-implemented',
        '0 not-implemented',
      )}.\n`,
    },
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /essential-eight\.md publishes "0 not-implemented".*grades 1/s)
})

test('GREEN (0.9.9): the register is judged from the SHIPPED lib, so the live tree is its own proof', () => {
  // The live repo run at the top of this file already covers this, but state it here too:
  // the fixture gets a byte-identical copy of template/base/tools/lib/essential-eight.mjs,
  // so a partition that the shipping `summarise()` computes differently cannot pass here
  // and fail in CI.
  const r = runFixture({
    readme: `The standing: ${FIXTURE_E8_SENTENCE}.\n`,
    e8Register: FIXTURE_E8,
  })
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /conformance-figure class is SKIPPED/)
})

// ── THE CONFORMANCE MAP FIGURES (1.0.0) ───────────────────────────────────────────
// The ASVS/MASVS/CRA twin of the block above, with the identical three properties: one
// PARTITION matched as a single phrase (four outcomes plus the three per-standard totals),
// judged for drift on every live prose surface, and judged for ABSENCE in the README.

test('GREEN (1.0.0): a README stating the whole conformance-map partition, matching the register, is CLEAN', () => {
  const r = runFixture({
    readme: `The standing: ${FIXTURE_CM_SENTENCE}.\n`,
    cmRegister: FIXTURE_CM,
  })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /map 4 rows \/ 1 covered/)
  assert.doesNotMatch(r.out, /conformance-map-figure class is SKIPPED/)
})

test('RED (1.0.0): a generous `covered` figure fails, naming the register as the truth', () => {
  const r = runFixture({
    readme: `The standing: ${FIXTURE_CM_SENTENCE.replace('1 covered', '3 covered')}.\n`,
    cmRegister: FIXTURE_CM,
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /README\.md publishes "3 covered" for the conformance map.*grades 1/s)
})

test('RED (1.0.0): a per-standard total that drifts fails too — the partition is the whole phrase', () => {
  const r = runFixture({
    readme: `The standing: ${FIXTURE_CM_SENTENCE.replace('ASVS 5.0.0 (2)', 'ASVS 5.0.0 (3)')}.\n`,
    cmRegister: FIXTURE_CM,
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /README\.md publishes "3 ASVS 5\.0\.0".*grades 2/s)
})

test('RED (1.0.0): deleting the conformance-map sentence is not a way past a wrong number', () => {
  const r = runFixture({
    readme: 'nothing claimed here\n',
    cmRegister: FIXTURE_CM,
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /README\.md publishes no conformance-map standing/)
  assert.match(r.out, /1 covered, 1 partial, 1 not-covered, 1 not-applicable/)
})

test('RED (1.0.0): the map figures are judged on EVERY live prose surface — the generated crosswalk included', () => {
  const r = runFixture({
    readme: `The standing: ${FIXTURE_CM_SENTENCE}.\n`,
    cmRegister: FIXTURE_CM,
    docs: {
      'template/base/docs/compliance/controls-crosswalk.md': `Standing: ${FIXTURE_CM_SENTENCE.replace(
        '1 not-covered',
        '0 not-covered',
      )}.\n`,
    },
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /controls-crosswalk\.md publishes "0 not-covered".*grades 1/s)
})

test('SKIP (1.0.0): a tree with no conformance map takes a loud NOTE, never a silent pass', () => {
  const r = runFixture({ readme: 'nothing claimed here\n' })
  assert.match(r.out, /conformance-map-figure class is SKIPPED, not passed/)
})
