// Proof for scripts/check-escape-registry.mjs — the four-list reconciliation (the fourth,
// installer/lib/proposals.mjs#PROPOSABLE, joined in 1.1.0 with `apply-proposal`, #65).
//
// It lives here rather than in tests/canary/injections.json deliberately: that registry
// has exactly two keyed sections — `steps`, keyed on VALIDATE_STEPS ∪ STOP_HOOK_STEPS, and
// `lanes`, keyed on job ids parsed out of template/base/github/workflows/*.yml — and
// check-canary-coverage.mjs reds a key matching neither. A factory-side control has no
// chain step and no shipped job, so registering it there would red the registry itself.
// The precedent is tests/gates/check-rule-integrity.test.mjs and ramp-ledger.test.mjs.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deriveRegistry, reconcileProposable } from '../../scripts/lib/escape-registry.mjs'

const guard = (id, re) => ({ id, re })
// An exact-match guard for one path. Every regex metacharacter is escaped, backslash
// included (the same escaper as installer/lib/migrations.mjs), not just the first dot.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const exact = (f) => new RegExp(`^${escapeRe(f)}$`)

// A population large enough to clear MIN_POPULATION, so the per-member rules are what is
// under test rather than the floor. Built from a real prefix of the shipped lists.
function bulk(n, { guardAll = true } = {}) {
  const files = Array.from({ length: n }, (_, i) => `tools/bulk-${String(i)}.json`)
  return {
    seeded: files,
    escapes: files,
    guards: guardAll ? files.map((f) => guard(f, exact(f))) : [],
  }
}

test('the anti-vacuity floor reds on an empty derivation rather than reporting clean', () => {
  const { population, problems } = deriveRegistry({ seeded: [], escapes: [], guards: [] })
  assert.equal(population.length, 0)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /below the floor/)
  // And it must SHORT-CIRCUIT: reporting 33 per-member problems over an empty population
  // would bury the one finding that matters.
  assert.doesNotMatch(problems[0], /write-guard/)
})

test('a scanner that half-works still reds — the floor is not just the zero case', () => {
  const { problems } = deriveRegistry(bulk(5))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /only 5 member\(s\) derived/)
})

test('a member with no write-guard rule reds — the live 0.5.0 finding', () => {
  const base = bulk(32)
  const input = {
    seeded: [...base.seeded, 'tools/security-headers.json'],
    escapes: [...base.escapes, 'tools/security-headers.json'],
    guards: base.guards, // deliberately no rule for it
  }
  const { problems } = deriveRegistry(input)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /tools\/security-headers\.json has NO write-guard rule/)
  assert.match(problems[0], /RULE_CANARIES/)
})

test('a seeded reviewed-data file absent from ESCAPE_LISTS reds — the decision-groups finding', () => {
  const base = bulk(32)
  const f = 'tools/decision-groups.json'
  const { problems } = deriveRegistry({
    seeded: [...base.seeded, f],
    escapes: base.escapes,
    guards: [...base.guards, guard('decision-groups', /^tools\/decision-groups\.json$/)],
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /absent from ESCAPE_LISTS/)
})

test('an escape that update would CLOBBER reds — in ESCAPE_LISTS but not seeded', () => {
  const base = bulk(32)
  const f = 'tools/invented-allow.json'
  const { problems } = deriveRegistry({
    seeded: base.seeded,
    escapes: [...base.escapes, f],
    guards: [...base.guards, guard('invented', /^tools\/invented-allow\.json$/)],
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /will CLOBBER the consumer's reviewed edits/)
})

test('the three tolerated-absent escapes are exempt from the seed rule, not from the guard rule', () => {
  const base = bulk(31)
  const tolerated = ['tools/retrofit-accept.json', 'tools/secret-scan-allow.json']
  // Guarded and unseeded: clean.
  const ok = deriveRegistry({
    seeded: base.seeded,
    escapes: [...base.escapes, ...tolerated],
    guards: [...base.guards, ...tolerated.map((f) => guard(f, exact(f)))],
  })
  assert.deepEqual(ok.problems, [])
  // Unguarded: still reds. Tolerated-absent excuses the SEED layer only.
  const bad = deriveRegistry({
    seeded: base.seeded,
    escapes: [...base.escapes, ...tolerated],
    guards: base.guards,
  })
  assert.equal(bad.problems.length, 2)
  for (const p of bad.problems) assert.match(p, /NO write-guard rule/)
})

test('a declared pin/hash/generated member is not asked for an ESCAPE_LISTS entry', () => {
  const base = bulk(32)
  const { problems } = deriveRegistry({
    seeded: [...base.seeded, 'tools/identity.lock.json'],
    escapes: base.escapes,
    guards: [...base.guards, guard('lock-json', /^tools\/(identity|prompts)\.lock\.json$/)],
  })
  assert.deepEqual(problems, [])
})

test('but a declared pin that ALSO sits in ESCAPE_LISTS reds — the two controls contradict', () => {
  const base = bulk(32)
  const f = 'tools/identity.lock.json'
  const { problems } = deriveRegistry({
    seeded: [...base.seeded, f],
    escapes: [...base.escapes, f],
    guards: [...base.guards, guard('lock-json', /^tools\/(identity|prompts)\.lock\.json$/)],
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /declared `pin`/)
  assert.match(problems[0], /contradictory advice/)
})

// ── the fourth list: the installer's own copy of the proposable set (1.1.0, #65) ──────
// `apply-proposal` never imports a template module, so it keeps its own copy of which
// registers a proposal may target. The copy is ESCAPE_LISTS, plus the `advisory` members of
// KINDS, minus NOT_PROPOSABLE (the two baselines only their generators write). Drift in
// either direction is the invisible kind: a register missing from the copy cannot be
// proposed, and a path in the copy that is no reviewed escape can be written by the verb.
const realLists = async () => {
  const { ESCAPE_LISTS } = await import('../../template/base/tools/lib/enforcement-surface.mjs')
  const { PROPOSABLE } = await import('../../installer/lib/proposals.mjs')
  return { escapes: [...ESCAPE_LISTS], proposable: [...PROPOSABLE] }
}

test('an escape the installer copy omits reds: it could not be proposed', async () => {
  const { escapes, proposable } = await realLists()
  const problems = reconcileProposable({
    escapes,
    proposable: proposable.filter((f) => f !== 'tools/i18n-allow.json'),
  })
  assert.equal(problems.length, 1, problems.join('\n'))
  assert.match(problems[0], /tools\/i18n-allow\.json .*absent from installer\/lib\/proposals\.mjs#PROPOSABLE/)
})

test('a new escape added to ESCAPE_LISTS alone reds until the installer copy has it', async () => {
  const { escapes, proposable } = await realLists()
  const problems = reconcileProposable({ escapes: [...escapes, 'tools/invented-allow.json'], proposable })
  assert.equal(problems.length, 1, problems.join('\n'))
  assert.match(problems[0], /tools\/invented-allow\.json/)
})

test('a proposable path that is no escape reds: the verb would write an owned or unreviewed file', async () => {
  const { escapes, proposable } = await realLists()
  const problems = reconcileProposable({ escapes, proposable: [...proposable, 'tools/harness.config.mjs'] })
  assert.equal(problems.length, 1, problems.join('\n'))
  assert.match(problems[0], /tools\/harness\.config\.mjs is in installer\/lib\/proposals\.mjs#PROPOSABLE but is not/)
})

test('a generator-written baseline in the installer copy reds, naming why it is excluded', async () => {
  const { escapes, proposable } = await realLists()
  const problems = reconcileProposable({ escapes, proposable: [...proposable, 'tools/perf-baseline.json'] })
  assert.equal(problems.length, 1, problems.join('\n'))
  assert.match(problems[0], /tools\/perf-baseline\.json .*NOT_PROPOSABLE/)
  assert.match(problems[0], /perf-baseline\.mjs/)
})

test('the advisory field notes are proposable, and dropping them from the copy reds', async () => {
  const { escapes, proposable } = await realLists()
  assert.ok(proposable.includes('tools/field-notes.json'))
  const problems = reconcileProposable({
    escapes,
    proposable: proposable.filter((f) => f !== 'tools/field-notes.json'),
  })
  assert.equal(problems.length, 1, problems.join('\n'))
  assert.match(problems[0], /tools\/field-notes\.json/)
})

test('a NOT_PROPOSABLE entry that has left ESCAPE_LISTS reds as stale', async () => {
  const { escapes, proposable } = await realLists()
  const problems = reconcileProposable({
    escapes: escapes.filter((f) => f !== 'tools/mutation-baseline.json'),
    proposable,
  })
  assert.equal(problems.length, 1, problems.join('\n'))
  assert.match(problems[0], /NOT_PROPOSABLE names tools\/mutation-baseline\.json.*stale/)
})

test('the shipped four lists reconcile — the check passes on the real tree', async () => {
  const { SEEDED_FILES } = await import('../../installer/lib/layout.mjs')
  const { ESCAPE_LISTS } = await import(
    '../../template/base/tools/lib/enforcement-surface.mjs'
  )
  const { WRITE_PROTECTED } = await import(
    '../../template/base/.claude/hooks/lib/guard-rules.mjs'
  )
  const { PROPOSABLE } = await import('../../installer/lib/proposals.mjs')
  const { population, problems } = deriveRegistry({
    seeded: SEEDED_FILES,
    escapes: ESCAPE_LISTS,
    guards: WRITE_PROTECTED,
  })
  assert.deepEqual(problems, [])
  assert.deepEqual(reconcileProposable({ escapes: ESCAPE_LISTS, proposable: PROPOSABLE }), [])
  // Every proposable register is write-guarded: the flow exists because the agent cannot
  // write the file itself, so a proposable path without a guard would be a hole, not a flow.
  for (const file of PROPOSABLE) {
    assert.ok(
      WRITE_PROTECTED.some((r) => r.re.test(file)),
      `${file} is proposable but has no write-guard rule`,
    )
  }
  // The measured population, pinned so a silent collapse in either list is visible here
  // as well as through the floor.
  assert.ok(
    population.length >= 33,
    `expected >= 33 registry members, derived ${String(population.length)}`,
  )
})
