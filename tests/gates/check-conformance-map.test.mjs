// Can-fail proofs for the conformance MAP's closures (OWASP ASVS 5.0.0 · MASVS 2.1 · CRA
// Annex I). The judgements live in template/base/tools/lib/conformance-map.mjs and are
// tested here as pure functions; both consumers (the `docs-sync` third script and the
// factory-side evidence check) share them, so a hole here is a hole in both.
//
// WHAT THESE PROOFS ARE ACTUALLY ABOUT. Like the Essential Eight suite next door, this one
// judges a CLAIM rather than code: 392 rows stating which live control bears on each
// requirement and how far it reaches. The cheapest way to fake conformance is not to weaken
// a control — it is to regrade a row, or to publish the flattering half of a partition. So
// the injections below are the regrade attempts: a covered row resting on prose alone, a
// control nobody runs, a conditional lane that hides that it is conditional, a module row
// naming a module nobody can enable, a not-applicable with no negative proof, a chain step
// the map forgot, a sentence that claims a level, a proof cited from another gate, and an
// empty register reading as a clean bill of health.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { STOP_HOOK_STEPS, VALIDATE_STEPS } from '../../template/base/tools/harness.config.mjs'
import {
  canaryProblems,
  censusProblems,
  claimProblems,
  guardRuleIds,
  installedModules,
  rowProblems,
  summarise,
  unmappedControlProblems,
} from '../../template/base/tools/lib/conformance-map.mjs'
import { hashInputs } from '../../template/base/tools/lib/gate.mjs'
import { liveControls } from '../../template/base/tools/lib/live-controls.mjs'
// A namespace import: a named import of an entry the register lacks would fail this whole
// file at link time instead of failing the stamp cases that need it.
import * as stampRegister from '../../template/base/tools/lib/stamp-inputs.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BASE = join(ROOT, 'template/base')
const SHIPPED = JSON.parse(readFileSync(join(BASE, 'tools/conformance-map.json'), 'utf8'))
const clone = () => JSON.parse(JSON.stringify(SHIPPED))
const find = (reg, id) => reg.requirements.find((r) => r.id === id)

/**
 * What actually runs, DERIVED — the same calls the gate makes, over the shipped chain,
 * the shipped workflows and the shipped guard-rule tables. A hand-written control set
 * drifts the first time a row names a control the list was not told about (the E8 suite
 * learned that with `auth-posture`); a derived one cannot.
 */
const STEPS = [...VALIDATE_STEPS, ...STOP_HOOK_STEPS].map(([name]) => name)
const CONTROLS = liveControls({
  steps: STEPS,
  workflowDir: join(BASE, 'github/workflows'),
})
const GUARD_RULES = guardRuleIds(
  readFileSync(join(BASE, '.claude/hooks/lib/guard-rules.mjs'), 'utf8'),
)
for (const id of GUARD_RULES.keys()) CONTROLS.live.add(id)
const KNOWN_MODULES = new Set(
  JSON.parse(readFileSync(join(BASE, 'tools/modules.json'), 'utf8')).modules,
)
/** The template tree installs no module — every module row is CONDITIONAL here. */
const INSTALLED = installedModules({ root: BASE, modules: KNOWN_MODULES })
const TREE = { installedModules: INSTALLED, knownModules: KNOWN_MODULES }
/** The real registry, all three halves — the union the factory closure resolves against. */
const realKeys = () => {
  const c = JSON.parse(readFileSync(join(ROOT, 'tests/canary/injections.json'), 'utf8'))
  return new Set([...Object.keys(c.steps), ...Object.keys(c.lanes), ...Object.keys(c.hookRules)])
}

// ---- the shipped register is the clean case -----------------------------------------
test('the SHIPPED register passes every consumer-side closure — the clean case is a real tree, not a fixture', () => {
  const reg = clone()
  assert.deepEqual(censusProblems(reg), [])
  assert.deepEqual(rowProblems(reg, CONTROLS, TREE), [])
  assert.deepEqual(unmappedControlProblems(reg, STEPS), [])
  assert.deepEqual(claimProblems(reg), [])
})

test('the shipped register carries 392 requirements: 345 ASVS at tag v5.0.0, 24 MASVS, 23 CRA Annex I', () => {
  assert.equal(SHIPPED.requirements.length, 392)
  assert.equal(SHIPPED.expectedCounts.total, 392)
  assert.equal(SHIPPED.expectedCounts.asvs.total, 345)
  assert.equal(SHIPPED.expectedCounts.masvs.total, 24)
  assert.equal(SHIPPED.expectedCounts.cra.total, 23)
  assert.equal(INSTALLED.size, 0, 'the template tree installs no module')
})

// ---- census -------------------------------------------------------------------------
test('a DELETED row reds naming the count — on the total, the standard, the chapter AND the level', () => {
  const reg = clone()
  reg.requirements = reg.requirements.filter((r) => r.id !== '8.2.2')
  const problems = censusProblems(reg)
  assert.ok(problems.some((p) => /391 requirement\(s\) present, expected 392/.test(p)))
  assert.ok(problems.some((p) => /standard 'asvs' has 344 row\(s\), expected 345/.test(p)))
  assert.ok(problems.some((p) => /asvs\.byChapter 'V8' has 12 row\(s\), expected 13/.test(p)))
  assert.ok(problems.some((p) => /asvs\.byLevel '1' has 69 row\(s\), expected 70/.test(p)))
})

test('a row that changes LEVEL but not chapter is caught — the two ASVS axes are asserted independently', () => {
  const reg = clone()
  const row = find(reg, '8.2.2')
  assert.equal(row.level, 1)
  row.level = 2
  const problems = censusProblems(reg)
  assert.ok(problems.some((p) => /asvs\.byLevel '1' has 69/.test(p)))
  assert.ok(problems.some((p) => /asvs\.byLevel '2' has 184/.test(p)))
  assert.ok(!problems.some((p) => /byChapter/.test(p)), 'chapter counts are unchanged')
})

test('a MASVS group or CRA part that drifts reds naming it', () => {
  const reg = clone()
  find(reg, 'MASVS-NETWORK-1').chapter = 'MASVS-NETWORK-X'
  assert.ok(
    censusProblems(reg).some((p) =>
      /masvs\.byGroup 'MASVS-NETWORK-X' is not in expectedCounts/.test(p),
    ),
  )
  const reg2 = clone()
  find(reg2, 'CRA-II.1').chapter = 'Part I'
  assert.ok(
    censusProblems(reg2).some((p) => /cra\.byPart 'Part II' has 7 row\(s\), expected 8/.test(p)),
  )
})

test('a duplicated id and a non-verbatim text are census defects', () => {
  const reg = clone()
  reg.requirements.push({ ...find(reg, '1.1.1') })
  assert.ok(censusProblems(reg).some((p) => /id '1\.1\.1' appears more than once/.test(p)))
  const reg2 = clone()
  find(reg2, '1.1.1').text = 'short'
  assert.ok(censusProblems(reg2).some((p) => /VERBATIM requirement wording/.test(p)))
})

test('an EMPTY register reds the census rather than passing vacuously', () => {
  const problems = censusProblems({
    requirements: [],
    expectedCounts: SHIPPED.expectedCounts,
  })
  assert.ok(problems.length >= 5, problems.join('\n'))
  assert.ok(problems.some((p) => /0 requirement\(s\) present, expected 392/.test(p)))
})

// ---- the grades themselves ----------------------------------------------------------
test('a `covered` row at the documentation tier reds — a control whose subject IS the requirement leaves an artefact', () => {
  const reg = clone()
  const row = find(reg, '8.2.2')
  assert.equal(row.outcome, 'covered')
  row.evidenceTier = 'documentation'
  assert.ok(
    rowProblems(reg, CONTROLS, TREE).some((p) =>
      /'covered' may not rest on evidenceTier 'documentation'/.test(p),
    ),
  )
})

test('a row naming a control nothing runs reds — a control nobody runs is not a control', () => {
  const reg = clone()
  find(reg, '8.4.1').control = 'no-such-gate'
  assert.ok(rowProblems(reg, CONTROLS, TREE).some((p) => /8\.4\.1.*is not a LIVE control/.test(p)))
})

test('a write-guard rule id IS a live control — the shipped rule-backed rows resolve, and an unknown rule id does not', () => {
  const reg = clone()
  const row =
    find(reg, '1.2.1') ?? reg.requirements.find((r) => r.control === 'dangerously-set-inner-html')
  assert.equal(row.control, 'dangerously-set-inner-html')
  assert.deepEqual(
    rowProblems(reg, CONTROLS, TREE).filter((p) => p.includes(`'${row.id}'`)),
    [],
  )
  row.control = 'no-such-rule'
  assert.ok(
    rowProblems(reg, CONTROLS, TREE).some(
      (p) => /is not a LIVE control/.test(p) && p.includes(row.id),
    ),
  )
})

test('a CONDITIONAL control must disclose which kind it is — existing and running are different claims', () => {
  const reg = clone()
  const row = find(reg, '7.4.1')
  assert.equal(row.control, 'web-e2e')
  assert.ok(CONTROLS.conditional.has('web-e2e'), 'fixture assumes a conditional lane')
  row.note = 'a note that hides the conditionality'
  assert.ok(
    rowProblems(reg, CONTROLS, TREE).some((p) =>
      /7\.4\.1.*CONDITIONAL.*path-filtered.*schedule-gated.*event-gated/s.test(p),
    ),
  )
})

test('the event-gated marker: the diff-aware OSV scan runs per PR, never on a push — and the row says so', () => {
  // liveControls flags a job whose `if:` names github.event_name as conditional, and neither
  // (path-filtered) nor (schedule-gated) describes the PR-only OSV scan honestly — so a third
  // marker exists, and the shipped row carries it. Deleting it must red.
  const reg = clone()
  const row = find(reg, 'CRA-I.2.a')
  assert.equal(row.control, 'scan-pr')
  assert.match(row.note, /\(event-gated\)/)
  row.note = row.note.replace('(event-gated)', '')
  assert.ok(rowProblems(reg, CONTROLS, TREE).some((p) => /CRA-I\.2\.a.*CONDITIONAL/.test(p)))
})

test('a module row naming an UNKNOWN module reds — conditional on a module nobody can enable is conditional on nothing', () => {
  const reg = clone()
  find(reg, '11.2.2').module = 'no-such-module'
  assert.ok(
    rowProblems(reg, CONTROLS, TREE).some((p) =>
      /11\.2\.2.*module 'no-such-module' is not in tools\/modules\.json/.test(p),
    ),
  )
})

test("a module row whose note never says 'module' reds — the reader of the grade alone cannot see the condition", () => {
  const reg = clone()
  const row = find(reg, '11.2.2')
  row.note = row.note.replace(/module/gi, 'add-on')
  assert.ok(rowProblems(reg, CONTROLS, TREE).some((p) => /11\.2\.2.*note never says so/.test(p)))
})

test('an UNINSTALLED module row is skipped for liveness with no finding; the same row is judged where the module is installed', () => {
  // CRA-I.2.c rests on the eas-update module's `publish` workflow job, which no base
  // workflow carries. On the template tree the module is absent → conditional → silent.
  const reg = clone()
  const row = find(reg, 'CRA-I.2.c')
  assert.equal(row.module, 'eas-update')
  assert.equal(row.control, 'publish')
  assert.ok(!CONTROLS.live.has('publish'), 'fixture assumes the base tree does not run `publish`')
  assert.deepEqual(
    rowProblems(reg, CONTROLS, TREE).filter((p) => p.includes('CRA-I.2.c')),
    [],
  )
  // ...and on a tree that HAS the module (but, in this fixture, still no `publish` job) the
  // row is decidable and reds — proving the skip is the module's, not the row's.
  const withModule = { ...TREE, installedModules: new Set(['eas-update']) }
  assert.ok(
    rowProblems(reg, CONTROLS, withModule).some((p) =>
      /CRA-I\.2\.c.*'publish' is not a LIVE control/.test(p),
    ),
  )
})

test('`not-applicable` with no negative proof reds — silence is not a proof', () => {
  const reg = clone()
  find(reg, '5.2.1').negativeProof = ''
  assert.ok(rowProblems(reg, CONTROLS, TREE).some((p) => /5\.2\.1.*Silence is not a proof/.test(p)))
})

test('`not-applicable` above the documentation floor must name a negativeCanary', () => {
  const reg = clone()
  const row = find(reg, '5.2.1')
  assert.equal(row.evidenceTier, 'system-generated-artefact')
  row.negativeCanary = null
  assert.ok(
    rowProblems(reg, CONTROLS, TREE).some((p) => /5\.2\.1.*names no 'negativeCanary'/.test(p)),
  )
})

test('a `not-covered` row carrying a control, canary or proof reds — a row that grades nothing may cite nothing', () => {
  const reg = clone()
  const row = find(reg, '1.1.1')
  assert.equal(row.outcome, 'not-covered')
  row.control = 'lint'
  assert.ok(rowProblems(reg, CONTROLS, TREE).some((p) => /1\.1\.1.*may not name 'control'/.test(p)))
  const reg2 = clone()
  find(reg2, '1.1.1').proof = 'tests/gates/somewhere.test.mjs'
  assert.ok(rowProblems(reg2, CONTROLS, TREE).some((p) => /1\.1\.1.*may not name 'proof'/.test(p)))
})

test('a `not-covered` row with a note under 40 characters reds — an unexplained gap is a gap nobody can close', () => {
  const reg = clone()
  find(reg, '1.1.1').note = 'unbuilt.'
  assert.ok(
    rowProblems(reg, CONTROLS, TREE).some((p) =>
      /1\.1\.1.*'not-covered' must carry a note of at least 40/.test(p),
    ),
  )
})

test('an organisation-boundary row may not be graded covered or partial', () => {
  const reg = clone()
  const row = reg.requirements.find((r) => r.boundary === 'organisation')
  row.outcome = 'covered'
  row.control = 'lint'
  row.proof = 'tools/eslint-rules/index.mjs'
  row.canary = 'lint'
  row.evidenceTier = 'simulated-activity'
  assert.ok(
    rowProblems(reg, CONTROLS, TREE).some(
      (p) =>
        p.includes(row.id) &&
        /boundary 'organisation' means the requirement is the OPERATOR/.test(p),
    ),
  )
})

test('a `covered`/`partial` row without a proof artefact reds', () => {
  const reg = clone()
  find(reg, '8.2.2').proof = ''
  assert.ok(rowProblems(reg, CONTROLS, TREE).some((p) => /8\.2\.2.*must name the 'proof'/.test(p)))
})

test('simulated-activity may not be claimed without a canary, nor by a row that claims no control', () => {
  const reg = clone()
  find(reg, '8.2.2').canary = null
  assert.ok(
    rowProblems(reg, CONTROLS, TREE).some((p) =>
      /8\.2\.2.*'simulated-activity' must name a 'canary'/.test(p),
    ),
  )
  const reg2 = clone()
  find(reg2, '1.1.1').evidenceTier = 'simulated-activity'
  assert.ok(
    rowProblems(reg2, CONTROLS, TREE).some((p) =>
      /1\.1\.1.*cannot be evidenced by simulated activity/.test(p),
    ),
  )
})

test('vocabulary: an ASVS row carries its OWN level 1|2|3, a MASVS/CRA row carries null, and a bad boundary/outcome/tier reds', () => {
  const reg = clone()
  find(reg, '1.1.1').level = null
  find(reg, 'MASVS-NETWORK-1').level = 2
  find(reg, 'CRA-I.1').boundary = 'vendor'
  find(reg, 'CRA-I.2.a').outcome = 'effective'
  find(reg, '8.2.2').evidenceTier = 'excellent'
  const problems = rowProblems(reg, CONTROLS, TREE)
  assert.ok(problems.some((p) => /1\.1\.1.*'level' is null/.test(p)))
  assert.ok(problems.some((p) => /MASVS-NETWORK-1.*'level' is 2/.test(p)))
  assert.ok(problems.some((p) => /CRA-I\.1.*boundary 'vendor'/.test(p)))
  assert.ok(problems.some((p) => /CRA-I\.2\.a.*outcome 'effective'/.test(p)))
  assert.ok(problems.some((p) => /8\.2\.2.*evidenceTier 'excellent'/.test(p)))
})

// ---- unmappedControls: every step placed exactly once ----------------------------------
test('the shipped map places every chain step exactly once — named as a control or keyed as unmapped', () => {
  const named = new Set(SHIPPED.requirements.map((r) => r.control).filter(Boolean))
  const unmapped = new Set(Object.keys(SHIPPED.unmappedControls))
  for (const step of STEPS) {
    assert.ok(
      named.has(step) !== unmapped.has(step),
      `${step} must be exactly one of named | unmapped`,
    )
  }
  // 47 since 1.1.0 (#77): web-compile joined the validate chain, keyed as unmapped.
  assert.equal(STEPS.length, 47, '37 validate + 10 Stop steps')
  assert.ok(unmapped.has('web-compile'), 'web-compile is keyed as unmapped, with its reason')
})

test('a chain step that is neither named nor listed reds', () => {
  const reg = clone()
  delete reg.unmappedControls.format
  assert.ok(
    unmappedControlProblems(reg, STEPS).some((p) =>
      /chain step 'format' is named as no row's control and is not keyed/.test(p),
    ),
  )
})

test("a listed step that is ALSO a row's control reds — the reason and the grade contradict each other", () => {
  const reg = clone()
  reg.unmappedControls.tenancy =
    'a forty-character-plus reason that contradicts the eleven rows naming tenancy'
  assert.ok(
    unmappedControlProblems(reg, STEPS).some((p) =>
      /'tenancy' is keyed as unmapped AND named as a row's control/.test(p),
    ),
  )
})

test('an unmapped key naming no step reds as a stale record, and a short reason reds as not-a-review', () => {
  const reg = clone()
  reg.unmappedControls['no-such-step'] =
    'a reason of adequate length for a step that does not exist here'
  reg.unmappedControls.format = 'too short'
  const problems = unmappedControlProblems(reg, STEPS)
  assert.ok(problems.some((p) => /'no-such-step' is not a step/.test(p)))
  assert.ok(problems.some((p) => /'format' carries a reason under 40 characters/.test(p)))
})

// ---- the claim-sentence ban ------------------------------------------------------------
test('a claim-shaped sentence in a note or the header reds — the map states controls, never a level', () => {
  const reg = clone()
  find(reg, '8.2.2').note += ' With this control the application is ASVS Level 2 compliant.'
  const problems = claimProblems(reg)
  assert.ok(problems.some((p) => /row '8\.2\.2' note: claims "is ASVS Level 2 compliant"/.test(p)))
  const reg2 = clone()
  reg2.comment.push('The generated scaffold is CRA-compliant.')
  assert.ok(claimProblems(reg2).some((p) => /comment\[\d+\]: claims "is CRA-compliant"/.test(p)))
  const reg3 = clone()
  find(reg3, '5.2.1').negativeProof += ' This makes the app MASVS-certified.'
  assert.ok(claimProblems(reg3).some((p) => /negativeProof: claims "MASVS-certified"/.test(p)))
})

test('the DENIAL stays legal — the shipped header says what it never claims, and passes', () => {
  assert.match(
    SHIPPED.comment.join('\n'),
    /never says the generated application is ASVS Level 1, 2 or 3/,
  )
  assert.deepEqual(claimProblems(clone()), [])
})

// ---- the factory-side evidence closure -------------------------------------------------
test('a claiming row naming an UNREGISTERED canary reds', () => {
  const reg = clone()
  find(reg, '8.2.2').canary = 'no-such-proof'
  assert.ok(
    canaryProblems(reg, realKeys(), GUARD_RULES).some((p) =>
      /8\.2\.2.*has no entry in tests\/canary\/injections\.json/.test(p),
    ),
  )
})

test('a simulated-activity claim with NO canary reds — a gate that cannot go red is decoration', () => {
  const reg = clone()
  find(reg, '8.2.2').canary = null
  const problems = canaryProblems(reg, realKeys(), GUARD_RULES)
  assert.ok(problems.some((p) => /8\.2\.2.*must name the 'canary'/.test(p)))
  assert.ok(
    problems.some((p) => /8\.2\.2.*'simulated-activity' must name a REGISTERED canary/.test(p)),
  )
})

test("ANTI-INFLATION: citing another gate's real proof reds — the field is not a duplicate of `control`", () => {
  const reg = clone()
  find(reg, '8.4.1').canary = 'schema-rls'
  const problems = canaryProblems(reg, realKeys(), GUARD_RULES)
  assert.equal(problems.length, 1, problems.join('\n'))
  assert.match(
    problems[0],
    /8\.4\.1.*does not name the red-proof of the control this row claims \('tenancy'/,
  )
})

test('a guard-rule-backed row must cite the HOOK that runs the rule — and only that hook', () => {
  const reg = clone()
  const row = reg.requirements.find((r) => r.control === 'weak-crypto-algorithm')
  assert.equal(row.canary, 'pretool-write-guard.mjs')
  assert.equal(GUARD_RULES.get('weak-crypto-algorithm'), 'pretool-write-guard.mjs')
  row.canary = 'pretool-bash-guard.mjs'
  assert.ok(
    canaryProblems(reg, realKeys(), GUARD_RULES).some(
      (p) => p.includes(row.id) && /does not name the red-proof/.test(p),
    ),
  )
  // the .env read ban IS a bash rule, and its shipped row cites the bash guard
  const bash = reg.requirements.find((r) => r.control === 'read-env-file')
  assert.equal(bash.canary, 'pretool-bash-guard.mjs')
  assert.equal(GUARD_RULES.get('read-env-file'), 'pretool-bash-guard.mjs')
})

test('a name that is BOTH a chain step and a guard-rule id accepts either proof as its own', () => {
  // `db-limits` and `data-flow` are a step and the rule protecting the step's policy file.
  assert.ok(GUARD_RULES.has('db-limits') && STEPS.includes('db-limits'))
  const reg = clone()
  const row = reg.requirements.find((r) => r.control === 'db-limits')
  assert.equal(row.canary, 'db-limits')
  assert.deepEqual(
    canaryProblems(reg, realKeys(), GUARD_RULES).filter((p) => p.includes(`'${row.id}'`)),
    [],
  )
  row.canary = 'pretool-write-guard.mjs'
  assert.deepEqual(
    canaryProblems(reg, realKeys(), GUARD_RULES).filter((p) => p.includes(`'${row.id}'`)),
    [],
  )
  row.canary = 'tenancy'
  assert.ok(canaryProblems(reg, realKeys(), GUARD_RULES).some((p) => p.includes(`'${row.id}'`)))
})

test('a row that grades NOTHING may not cite a red-proof', () => {
  const reg = clone()
  find(reg, '1.1.1').canary = 'lint'
  assert.ok(
    canaryProblems(reg, realKeys(), GUARD_RULES).some((p) => /1\.1\.1.*claims no control/.test(p)),
  )
})

test('a negativeCanary that resolves nowhere reds, and one on a row that claims no absence reds', () => {
  const reg = clone()
  find(reg, '5.2.1').negativeCanary = 'no-such-proof'
  assert.ok(
    canaryProblems(reg, realKeys(), GUARD_RULES).some((p) =>
      /5\.2\.1.*negativeCanary 'no-such-proof' has no entry/.test(p),
    ),
  )
  const reg2 = clone()
  find(reg2, '8.2.2').negativeCanary = 'docs-sync'
  assert.ok(
    canaryProblems(reg2, realKeys(), GUARD_RULES).some((p) => /8\.2\.2.*claims no absence/.test(p)),
  )
})

test('a MODULE row may leave canary null (conditional); a BASE row may not', () => {
  const reg = clone()
  const mod = find(reg, 'CRA-I.2.c')
  assert.equal(mod.module, 'eas-update')
  assert.equal(mod.canary, null)
  assert.deepEqual(
    canaryProblems(reg, realKeys(), GUARD_RULES).filter((p) => p.includes('CRA-I.2.c')),
    [],
  )
  const base = find(reg, '13.3.1')
  assert.equal(base.module, null)
  base.canary = null
  assert.ok(
    canaryProblems(reg, realKeys(), GUARD_RULES).some((p) =>
      /13\.3\.1.*must name the 'canary'/.test(p),
    ),
  )
})

test('steps{} alone is NOT enough — lane- and hook-backed rows resolve only against the three-registry union', () => {
  const c = JSON.parse(readFileSync(join(ROOT, 'tests/canary/injections.json'), 'utf8'))
  const stepsOnly = new Set(Object.keys(c.steps))
  const problems = canaryProblems(clone(), stepsOnly, GUARD_RULES)
  for (const id of ['7.4.1', 'CRA-I.2.a', 'CRA-II.1']) {
    assert.ok(
      problems.some((p) => p.includes(`'${id}'`)),
      `${id} must red against steps{} alone`,
    )
  }
  assert.ok(
    problems.some((p) => /pretool-write-guard\.mjs' has no entry/.test(p)),
    'hook-backed rows must red without hookRules{}',
  )
  assert.deepEqual(canaryProblems(clone(), realKeys(), GUARD_RULES), [])
})

test('every shipped POSITIVE claim resolves against the real registry — subject set PINNED', () => {
  const reg = clone()
  const positive = reg.requirements.filter(
    (r) => r.outcome === 'covered' || r.outcome === 'partial',
  )
  assert.equal(positive.length, 160, 'the closure is worthless if its subject set silently shrinks')
  assert.equal(positive.filter((r) => r.canary).length, 159)
  assert.equal(
    positive.filter((r) => !r.canary && r.module).length,
    1,
    'exactly one module-conditional row carries no canary',
  )
  const above = reg.requirements.filter(
    (r) => r.outcome === 'not-applicable' && r.evidenceTier !== 'documentation',
  )
  assert.equal(above.length, 16, 'the negative subject set is pinned too')
  assert.deepEqual(canaryProblems(reg, realKeys(), GUARD_RULES), [])
})

// ---- guardRuleIds: the source read that makes a rule a control --------------------------
test('guardRuleIds attributes every id to the hook that runs its table, and agrees with the imported tables', async () => {
  // The SOURCE read (what the gate uses inside a consumer tree) must count exactly what
  // importing the module counts (what scripts/check-claims.mjs derives the README figure
  // from) — two derivations of "the guard-rule ids", held equal so neither can drift.
  const tables = await import('../../template/base/.claude/hooks/lib/guard-rules.mjs')
  const imported = Object.values(tables)
    .filter((v) => Array.isArray(v) && v.length > 0 && typeof v[0]?.id === 'string')
    .flatMap((t) => t.map((r) => r.id))
  assert.equal(GUARD_RULES.size, imported.length)
  assert.deepEqual([...GUARD_RULES.keys()].sort(), [...imported].sort())
  assert.equal(GUARD_RULES.get('rm-rf'), 'pretool-bash-guard.mjs')
  assert.equal(GUARD_RULES.get('mcp-write-on-readonly'), 'pretool-mcp-guard.mjs')
  assert.equal(GUARD_RULES.get('conformance-map-register'), 'pretool-write-guard.mjs')
  assert.equal(GUARD_RULES.get('policy-using-true'), 'pretool-write-guard.mjs')
  assert.deepEqual(
    [...guardRuleIds("export const BASH_RULES = [\n  { id: 'x-y' },\n]\n")],
    [['x-y', 'pretool-bash-guard.mjs']],
  )
})

// ---- the summary the published figures derive from ------------------------------------
test('summarise() partitions every row exactly once, on every axis — published figures are DERIVED', () => {
  const s = summarise(SHIPPED)
  assert.equal(s.covered + s.partial + s.notCovered + s.notApplicable, s.total)
  assert.equal(s.byStandard.asvs + s.byStandard.masvs + s.byStandard.cra, s.total)
  assert.equal(s.asvsByLevel[1] + s.asvsByLevel[2] + s.asvsByLevel[3], s.byStandard.asvs)
  assert.equal(
    s.byBoundary.harness + s.byBoundary.consumer + s.byBoundary.organisation + s.byBoundary.shared,
    s.total,
  )
  assert.equal(s.total, 392)
  assert.equal(s.byStandard.asvs, 345)
  assert.equal(s.moduleConditional, 8)
})

// ---- the generated documents ------------------------------------------------------------
test('the two GENERATED documents are byte-identical to a fresh generation — the regen-diff the gate runs', () => {
  const r = spawnSync(process.execPath, ['tools/gen-conformance-docs.mjs', '--check'], {
    cwd: BASE,
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
  assert.match(r.stdout, /in sync \(392 row\(s\)\)/)
  // The anti-claim paragraph is written by the generator into BOTH files, so a later
  // hand-edit cannot drop it without redding the regen-diff.
  for (const f of ['docs/compliance/controls-crosswalk.md', 'docs/security/threat-model.md']) {
    const text = readFileSync(join(BASE, f), 'utf8')
    assert.match(text, /GENERATED by tools\/gen-conformance-docs\.mjs/)
    assert.match(text, /A mapping is not a verification, and this document claims no level/)
    assert.match(text, /The CRA rows carry a shelf life/)
    assert.match(text, /Module rows are conditional/)
    assert.match(text, /Organisation-boundary rows are enumerated/)
  }
  const crosswalk = readFileSync(join(BASE, 'docs/compliance/controls-crosswalk.md'), 'utf8')
  // every chain step appears once — mapped, or under Unmapped with its reason
  for (const step of STEPS) {
    assert.ok(
      new RegExp(`^(### |- )\`${step}\``, 'm').test(crosswalk),
      `${step} must appear in the crosswalk`,
    )
  }
  assert.match(crosswalk, /## Unmapped chain steps/)
  assert.match(crosswalk, /## Write-guard rule controls/)
  assert.match(crosswalk, /## Workflow-lane controls/)
  const threat = readFileSync(join(BASE, 'docs/security/threat-model.md'), 'utf8')
  assert.match(threat, /### `WRITE_SQL_CHECKS` \(pretool-write-guard\.mjs\)/)
  assert.match(threat, /## Uncovered and residual/)
  assert.match(threat, /## Stated limits/)
  assert.match(
    threat,
    /- \*\*MASVS-NETWORK-1\*\* \(MASVS 2\.1, `expo-policy`\) — What this does not reach:/,
  )
})

test('the shipped GATE fails CLOSED on an empty register — an empty map is a missing one, never a clean one', () => {
  // The template stores workflows dotless (github/), so the gate's green path is exercised
  // in the rendered scaffold (selftest); what a fixture can prove without a render is the
  // anti-vacuity path: an empty requirements[] is a hard red naming the file.
  const dir = mkdtempSync(join(tmpdir(), 'epah-conformance-'))
  try {
    mkdirSync(join(dir, 'tools', 'lib'), { recursive: true })
    for (const f of ['check-conformance-map.mjs', 'harness.config.mjs', 'modules.json']) {
      cpSync(join(BASE, 'tools', f), join(dir, 'tools', f))
    }
    cpSync(join(BASE, 'tools', 'lib'), join(dir, 'tools', 'lib'), {
      recursive: true,
    })
    writeFileSync(join(dir, 'tools', 'conformance-map.json'), JSON.stringify({ requirements: [] }))
    const r = spawnSync(process.execPath, ['tools/check-conformance-map.mjs'], {
      cwd: dir,
      encoding: 'utf8',
    })
    assert.equal(r.status, 1)
    assert.match(
      r.stderr,
      /declares no requirements\. An empty conformance map is not a clean bill of health/,
    )
    // ...and a MISSING register is the same verdict with the refresh remedy named.
    rmSync(join(dir, 'tools', 'conformance-map.json'))
    const r2 = spawnSync(process.execPath, ['tools/check-conformance-map.mjs'], {
      cwd: dir,
      encoding: 'utf8',
    })
    assert.equal(r2.status, 1)
    assert.match(r2.stderr, /tools\/conformance-map\.json is missing/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- the stamp (1.1.0, #68) -------------------------------------------------------------
// The script is stamped like the other register-reading gates: a warm run over unchanged
// inputs prints `conformance-map: STAMPED — inputs unchanged since last green run` and exits
// 0 without judging the map or spawning the generator. The stamp is keyed on what the
// verdict reads (the register, the chain config, the workflows, the guard rules, the module
// list and markers, the generator and its two documents, and each imported library), never
// on the evidence paths the rows cite, which neither script opens. CI (CI=true or
// HARNESS_REQUIRE_TOOLCHAINS=1) always judges in full.
//
// The fixture is the anti-vacuity one plus a stub of every other input, so each case below
// EDITS an input that exists rather than creating one: the script, harness.config.mjs,
// modules.json and tools/lib/**, an EMPTY register (judged in full it reds, so exit 0 can
// only be the stamp), one workflow, the guard rules, the generator and both generated
// documents. The child environment drops CI and HARNESS_REQUIRE_TOOLCHAINS, so the cases
// pass under the CI-shaped command on both selftest legs; only the CI case sets CI=true.
const STAMP_GATE = 'conformance-map'
const STAMP_SCRIPT = 'tools/check-conformance-map.mjs'
const STAMP_LINE = `${STAMP_GATE}: STAMPED — inputs unchanged since last green run`
const made = []
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

/** @param {string} dir @param {string} rel @param {string} text */
function put(dir, rel, text) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true })
  writeFileSync(join(dir, rel), text)
}

function stampFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'epah-cmapstamp-'))
  made.push(dir)
  mkdirSync(join(dir, 'tools'), { recursive: true })
  for (const f of ['check-conformance-map.mjs', 'harness.config.mjs', 'modules.json']) {
    cpSync(join(BASE, 'tools', f), join(dir, 'tools', f))
  }
  cpSync(join(BASE, 'tools', 'lib'), join(dir, 'tools', 'lib'), { recursive: true })
  put(dir, 'tools/conformance-map.json', JSON.stringify({ requirements: [] }))
  put(
    dir,
    '.github/workflows/ci.yml',
    'name: ci\non: push\njobs:\n  static:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n',
  )
  put(dir, '.claude/hooks/lib/guard-rules.mjs', '// stub\n')
  put(dir, 'tools/gen-conformance-docs.mjs', '// stub\n')
  put(dir, 'docs/compliance/controls-crosswalk.md', 'stub\n')
  put(dir, 'docs/security/threat-model.md', 'stub\n')
  return dir
}

/** @param {string} dir @param {{ ci?: boolean }} [opts] */
function runStamped(dir, { ci = false } = {}) {
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  delete env.GITHUB_BASE_REF
  if (ci) env.CI = 'true'
  const res = spawnSync(process.execPath, [STAMP_SCRIPT], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

// Write the digest a green run would record, from inside the fixture: hashInputs is
// cwd-relative. The check-e2e.test.mjs pattern, copied (its helpers are local to that file).
function seedStamp(dir) {
  const prev = process.cwd()
  process.chdir(dir)
  try {
    mkdirSync(join(dir, '.harness'), { recursive: true })
    writeFileSync(
      join(dir, '.harness', `${STAMP_GATE}.ok`),
      hashInputs(stampRegister.STAMP_INPUTS[STAMP_GATE] ?? []),
    )
  } finally {
    process.chdir(prev)
  }
}

/** A fixture with a seeded stamp, asserted to ride it before the case changes anything. */
function warmFixture() {
  const dir = stampFixture()
  seedStamp(dir)
  const warm = runStamped(dir)
  assert.equal(warm.code, 0, `precondition: the seeded stamp must hold\n${warm.out}`)
  assert.ok(warm.out.includes(STAMP_LINE), warm.out)
  return dir
}

/** @param {{ code: number | null, out: string }} r */
function assertJudged(r) {
  assert.equal(r.code, 1, r.out)
  assert.ok(!r.out.includes('inputs unchanged'), `no stamp line may print once the script judges:\n${r.out}`)
  assert.ok(!r.out.includes('STAMPED'), r.out)
}

test('STAMP (1.1.0): a seeded stamp over unchanged inputs exits 0 and prints the stamp line', () => {
  const dir = stampFixture()
  seedStamp(dir)
  const r = runStamped(dir)
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes(STAMP_LINE), r.out)
  // Proof the map was never judged: judged in full, this fixture reds on anti-vacuity.
  assert.ok(!r.out.includes('declares no requirements'), r.out)
})

test('STAMP: CI=true ignores a seeded stamp and judges the map in full', () => {
  const dir = stampFixture()
  seedStamp(dir)
  const r = runStamped(dir, { ci: true })
  assertJudged(r)
  assert.ok(r.out.includes('declares no requirements'), r.out)
})

// Each input the verdict reads. The libraries are the import closure of the script and of
// the generator it spawns (the membership test in gate-helpers.test.mjs derives it from the
// source; here it is written out, so a lib that silently left the entry fails this list too).
const edit = (rel) => (dir) => appendFileSync(join(dir, rel), '\n// edited\n')
const CMAP_EDITS = {
  'the register': (dir) => put(dir, 'tools/conformance-map.json', JSON.stringify({ requirements: [], edited: true })),
  'tools/harness.config.mjs': edit('tools/harness.config.mjs'),
  'a workflow': (dir) => appendFileSync(join(dir, '.github/workflows/ci.yml'), '# edited\n'),
  'the workflow set (a new file)': (dir) => put(dir, '.github/workflows/new.yml', 'name: new\n'),
  '.claude/hooks/lib/guard-rules.mjs': edit('.claude/hooks/lib/guard-rules.mjs'),
  'tools/modules.json': (dir) => appendFileSync(join(dir, 'tools/modules.json'), '\n'),
  'the module markers (a new docs/modules/<name>/README.md)': (dir) => put(dir, 'docs/modules/e2ee/README.md', '# e2ee\n'),
  'docs/compliance/controls-crosswalk.md': (dir) => appendFileSync(join(dir, 'docs/compliance/controls-crosswalk.md'), 'edited\n'),
  'docs/security/threat-model.md': (dir) => appendFileSync(join(dir, 'docs/security/threat-model.md'), 'edited\n'),
  'the generator': edit('tools/gen-conformance-docs.mjs'),
}
for (const lib of ['conformance-map.mjs', 'standards-claim.mjs', 'live-controls.mjs', 'fs-walk.mjs', 'gate.mjs', 'stamp-inputs.mjs']) {
  CMAP_EDITS[`tools/lib/${lib}`] = edit(`tools/lib/${lib}`)
}

for (const [input, change] of Object.entries(CMAP_EDITS)) {
  test(`STAMP: changing ${input} after a green stamp makes the script judge again`, () => {
    const dir = warmFixture()
    change(dir)
    assertJudged(runStamped(dir))
  })
}

test('STAMP: a green run over the shipped map records the stamp, and the next run rides it', () => {
  // The whole loop, not a seeded digest: the shipped map, chain, workflows, guard rules,
  // generator and documents are green together, so recordGreen() writes
  // .harness/conformance-map.ok and the warm run hits it without spawning the generator.
  const dir = stampFixture()
  cpSync(join(BASE, 'tools/conformance-map.json'), join(dir, 'tools/conformance-map.json'))
  cpSync(join(BASE, 'github/workflows'), join(dir, '.github/workflows'), { recursive: true })
  for (const f of [
    '.claude/hooks/lib/guard-rules.mjs',
    'tools/gen-conformance-docs.mjs',
    'docs/compliance/controls-crosswalk.md',
    'docs/security/threat-model.md',
  ]) {
    cpSync(join(BASE, f), join(dir, f))
  }
  const cold = runStamped(dir)
  assert.equal(cold.code, 0, cold.out)
  assert.match(cold.out, /^conformance-map: OK — 392 requirement/m)
  assert.ok(existsSync(join(dir, '.harness', `${STAMP_GATE}.ok`)), 'a green run must record the stamp')
  // With the generator gone, a real run would red naming it; the warm run never reaches it.
  rmSync(join(dir, 'tools/gen-conformance-docs.mjs'))
  const gone = runStamped(dir)
  assertJudged(gone)
  assert.ok(gone.out.includes('tools/gen-conformance-docs.mjs is missing'), gone.out)
  cpSync(join(BASE, 'tools/gen-conformance-docs.mjs'), join(dir, 'tools/gen-conformance-docs.mjs'))
  // Restored byte-for-byte, the digest is the recorded one again: the red run recorded nothing.
  const warm = runStamped(dir)
  assert.equal(warm.code, 0, warm.out)
  assert.ok(warm.out.includes(STAMP_LINE), warm.out)
})

test('STAMP: a stamp register with no list for this gate judges in full, and never throws', () => {
  // `update` keeps a forked tools/lib/stamp-inputs.mjs and parks the new one, so the 1.1.0
  // script can meet a register that predates its entry. It must judge as it did through
  // 1.0.4, not crash on hashInputs(undefined).
  const dir = stampFixture()
  writeFileSync(join(dir, 'tools', 'lib', 'stamp-inputs.mjs'), 'export const STAMP_INPUTS = {}\n')
  mkdirSync(join(dir, '.harness'), { recursive: true })
  writeFileSync(join(dir, '.harness', 'conformance-map.ok'), 'stale')
  const r = runStamped(dir)
  assertJudged(r)
  assert.ok(r.out.includes('declares no requirements'), r.out)
  assert.ok(!r.out.includes('TypeError'), r.out)
})
