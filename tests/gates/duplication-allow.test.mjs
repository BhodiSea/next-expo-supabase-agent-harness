// The duplication register's row kinds (template/base/tools/lib/duplication-allow.mjs, #175):
// members-bound `exact` and `near` rows, mirror rows, and wire rows, applied only by a human.
//   - the pure half (no parser): the closed rule set, every shape error, how a class stands
//     against a row, what the rows say about a tree, which rows `--prune` drops;
//   - the sweep half (with the parser): the issue's anti-vacuity table, rebuilt as fixtures.
// The Stop run's half (shape errors red, mirror rows over L0) is in check-duplication.test.mjs.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  isStale,
  judgeClass,
  mirrored,
  nearAccepted,
  parseRegister,
  REASON_MIN,
  ROW_RULES,
  rowFindings,
  rowProblem,
  rowsFor,
} from '../../template/base/tools/lib/duplication-allow.mjs'
import { advisoryRecordOk } from '../../template/base/tools/lib/gate.mjs'
import { extractTree } from '../../template/base/tools/lib/shapes.mjs'
import { explainRecord, sweep } from '../../template/base/tools/lib/sweep.mjs'
import { BODY, inTree, pkg, treeTest, ts } from './helpers/single-home.mjs'

const REASON = 'reviewed: the two halves of one deliberate pattern'
const A = '@app/k#alpha'
const B = '@app/k#beta'
const C = '@app/k#gamma'

// ── the closed rule set ───────────────────────────────────────────────────────────

test('register: the rule set is a constant, and wire-bound is not in it', () => {
  assert.ok(Object.isFrozen(ROW_RULES))
  assert.deepEqual(ROW_RULES, [
    'exact',
    'near',
    'wire-orphan',
    'validation-parity',
    'respelled-guard',
    'parity-truth',
    'twin-schema',
    'twin-args',
    'wire-restate',
    'i18n-key-parity',
  ])
  assert.ok(!ROW_RULES.includes('wire-bound'))
  assert.equal(REASON_MIN, 20)
})

// ── shape errors ──────────────────────────────────────────────────────────────────

test('register: every new-kind shape error is named, and an L0 row keeps the old check', () => {
  const row = (extra) => ({ fingerprint: 'abcdef012345', rule: 'exact', members: [A, B], reason: REASON, ...extra })
  const cases = [
    [row({ reason: '0123456789' }), /at least 20 characters/],
    [row({ reason: undefined }), /at least 20 characters/],
    [row({ rule: 'exakt' }), /unknown rule "exakt"/],
    [row({ rule: 'wire-bound' }), /tools\/dto-bounds-allow\.json/],
    [row({ members: [A, A] }), /names a subject twice/],
    [row({ members: [A] }), /at least 2 subjects/],
    [row({ members: undefined }), /"members" must be an array/],
    [row({ members: [A, 7] }), /"members" must be an array/],
    [row({ rule: 'near', members: [A, B, C] }), /exactly 2 members/],
    [row({ fingerprint: 12 }), /"fingerprint", when present/],
    [{ mirror: ['a', 'b', 'c'], reason: REASON }, /exactly two repository-relative paths/],
    [{ mirror: ['/abs', 'b'], reason: REASON }, /exactly two repository-relative paths/],
    [{ mirror: ['a/../b', 'c'], reason: REASON }, /exactly two repository-relative paths/],
    [{ mirror: ['a\\b', 'c'], reason: REASON }, /exactly two repository-relative paths/],
    [{ mirror: ['a', 'a'], reason: REASON }, /two different paths/],
    [{ mirror: ['a', 'b'], reason: 'short' }, /at least 20 characters/],
    [{ mirror: ['a', 'b'], rule: 'exact', members: [A, B], reason: REASON }, /not both/],
    [{ fingerprint: 'abc' }, /non-empty string/],
    [{ fingerprint: 42, reason: 'x' }, /non-empty string/],
    [null, /must be an object/],
  ]
  for (const [entry, re] of cases) assert.match(rowProblem(entry) ?? 'null', re, JSON.stringify(entry))
  // Today's rows, the nine an install holds, are L0 rows and stay valid at any reason length.
  assert.equal(rowProblem({ fingerprint: '7d4763a23828', reason: 'x' }), null)
  for (const ok of [row({}), row({ rule: 'near' }), row({ rule: 'twin-schema', fingerprint: undefined })]) {
    assert.equal(rowProblem(ok), null, JSON.stringify(ok))
  }
  assert.equal(rowProblem({ mirror: ['packages/a/src', 'packages/b/src'], reason: REASON }), null)
})

test('register: parseRegister names every malformed entry by index and keeps the rest', () => {
  const text = JSON.stringify({
    allow: [
      { fingerprint: 'abcdef012345', reason: 'x' },
      { rule: 'exakt', members: [A, B], reason: REASON },
      { mirror: ['a', 'b'], reason: REASON },
      { rule: 'exact', members: [A, A], reason: REASON },
    ],
  })
  const parsed = parseRegister(text)
  assert.equal(parsed.error, null)
  assert.deepEqual(parsed.rows.map((r) => [r.kind, r.index]), [['l0', 0], ['mirror', 2]])
  assert.equal(parsed.problems.length, 2)
  assert.match(parsed.problems[0], /entry 1: unknown rule/)
  assert.match(parsed.problems[1], /entry 3: "members" names a subject twice/)
  assert.match(parseRegister('{ no').error ?? '', /not valid JSON/)
  assert.match(parseRegister('{"allow": {}}').error ?? '', /"allow" ARRAY/)
  assert.match(parseRegister('[]').error ?? '', /"allow" ARRAY/)
})

test('register: a wire step reads only its own well-formed rows, and never a shape error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-dup-rows-'))
  try {
    const file = join(dir, 'allow.json')
    writeFileSync(
      file,
      JSON.stringify({
        allow: [
          { fingerprint: 'abcdef012345', rule: 'twin-schema', members: [A, B], reason: REASON },
          { fingerprint: 'abcdef012345', rule: 'twin-schema', members: [A], reason: REASON },
          { fingerprint: 'abcdef012345', rule: 'wire-orphan', members: [A, B], reason: REASON },
          { fingerprint: 'abcdef012345', reason: 'an L0 row' },
        ],
      }),
    )
    assert.deepEqual(rowsFor(['twin-schema'], file).map((r) => [r.rule, r.members]), [['twin-schema', [A, B]]])
    assert.deepEqual(rowsFor(['wire-orphan'], file).length, 1)
    assert.deepEqual(rowsFor(['i18n-key-parity'], file), [])
    assert.deepEqual(rowsFor(['exact'], join(dir, 'absent.json')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── mirror rows ───────────────────────────────────────────────────────────────────

test('register: a mirror row pairs one path on each side at one relative path, either order', () => {
  /** @type {any} */
  const dirs = { kind: 'mirror', mirror: ['packages/design-system/src', 'packages/design-system-native/src'], reason: REASON }
  assert.ok(mirrored(dirs, 'packages/design-system/src/Field.tsx', 'packages/design-system-native/src/Field.tsx'))
  assert.ok(mirrored(dirs, 'packages/design-system-native/src/a/b.ts', 'packages/design-system/src/a/b.ts'))
  assert.ok(!mirrored(dirs, 'packages/design-system/src/Field.tsx', 'packages/design-system-native/src/Input.tsx'))
  assert.ok(!mirrored(dirs, 'packages/design-system/src/Field.tsx', 'packages/design-system/src/Field.tsx'))
  // A copy anywhere else is judged normally: the mobile app is not the native design system.
  assert.ok(!mirrored(dirs, 'apps/mobile/src/components/Field.tsx', 'packages/design-system-native/src/Field.tsx'))
  // A sibling directory that only shares the prefix is not under it.
  assert.ok(!mirrored(dirs, 'packages/design-system/srcx/Field.tsx', 'packages/design-system-native/src/Field.tsx'))
  /** @type {any} */
  const files = { kind: 'mirror', mirror: ['apps/mobile/src/i18n/catalog.ts', 'apps/web/lib/i18n/catalog.ts'], reason: REASON }
  assert.ok(mirrored(files, 'apps/web/lib/i18n/catalog.ts', 'apps/mobile/src/i18n/catalog.ts'))
  assert.ok(!mirrored(files, 'apps/web/lib/i18n/catalog.ts', 'apps/web/lib/i18n/other.ts'))
})

// ── a class against a row (v2 §2.5) ───────────────────────────────────────────────

/** @param {string[]} members @returns {any} */
const exactRow = (members, fingerprint = 'aaaaaaaaaaaa') => ({ kind: 'rule', rule: 'exact', members, fingerprint, reason: REASON })

test('register: members equal is accepted, a changed fingerprint says so, an unlisted member is named', () => {
  const rows = [exactRow([A, B])]
  assert.deepEqual(judgeClass(rows, { fp: 'aaaaaaaaaaaa', subjects: [A, B] }), { state: 'accepted', row: rows[0], changed: false, unlisted: [] })
  assert.equal(judgeClass(rows, { fp: 'bbbbbbbbbbbb', subjects: [B, A] }).changed, true)
  // A third copy, or a swap into a file nobody reviewed: the row does not stretch to it.
  assert.deepEqual(judgeClass(rows, { fp: 'aaaaaaaaaaaa', subjects: [A, B, C] }).unlisted, [C])
  assert.deepEqual(judgeClass(rows, { fp: 'aaaaaaaaaaaa', subjects: [B, C] }).unlisted, [C])
  assert.equal(judgeClass(rows, { fp: 'aaaaaaaaaaaa', subjects: ['@app/x#p', '@app/x#q'] }).state, 'none')
  // A near row or a wire row never accepts an exact class.
  /** @type {any[]} */
  const other = [{ ...rows[0], rule: 'near' }, { ...rows[0], rule: 'twin-schema' }]
  assert.equal(judgeClass(other, { fp: 'aaaaaaaaaaaa', subjects: [A, B] }).state, 'none')
  assert.ok(nearAccepted(/** @type {any[]} */ ([{ ...rows[0], rule: 'near' }]), [B, A]))
  assert.ok(!nearAccepted(rows, [A, B]))
})

test('register: the row findings are stale-row, accepted-class-diverged and accepted-class-changed', () => {
  const subjects = (entries) => new Map(entries)
  const row = exactRow([A, B])
  // Edit one side: no class, and the edited side no longer hashes to the row's fingerprint.
  assert.deepEqual(
    rowFindings([row], { subjects: subjects([[A, 'aaaaaaaaaaaa'], [B, 'cccccccccccc']]), classes: [], pairs: [] }).map((f) => [f.rule, f.subject]),
    [['accepted-class-diverged', B]],
  )
  // Edit both sides the same way: still a class, members equal, the fingerprint moved.
  assert.deepEqual(
    rowFindings([row], {
      subjects: subjects([[A, 'dddddddddddd'], [B, 'dddddddddddd']]),
      classes: [{ fp: 'dddddddddddd', subjects: [A, B] }],
      pairs: [],
    }).map((f) => [f.rule, f.subject]),
    [['accepted-class-changed', 'dddddddddddd']],
  )
  // Delete A, add C: A is stale; the class {B, C} carries C unlisted (judgeClass, above).
  assert.deepEqual(
    rowFindings([row], {
      subjects: subjects([[B, 'aaaaaaaaaaaa'], [C, 'aaaaaaaaaaaa']]),
      classes: [{ fp: 'aaaaaaaaaaaa', subjects: [B, C] }],
      pairs: [],
    }).map((f) => [f.rule, f.subject]),
    [['stale-row', A]],
  )
  // A near row that matches no pair is a stale-row NOTE on the pair.
  /** @type {any} */
  const near = { ...row, rule: 'near' }
  assert.deepEqual(
    rowFindings([near], { subjects: subjects([[A, 'x'], [B, 'y']]), classes: [], pairs: [] }).map((f) => [f.rule, f.subject]),
    [['stale-row', `${A} ${B}`]],
  )
  assert.deepEqual(rowFindings([near], { subjects: subjects([[A, 'x'], [B, 'y']]), classes: [], pairs: [[A, B]] }), [])
  // Accepted, unchanged: nothing to say.
  assert.deepEqual(
    rowFindings([row], {
      subjects: subjects([[A, 'aaaaaaaaaaaa'], [B, 'aaaaaaaaaaaa']]),
      classes: [{ fp: 'aaaaaaaaaaaa', subjects: [A, B] }],
      pairs: [],
    }),
    [],
  )
})

test('register: --prune drops a rule row with a missing member and a mirror row with a missing side, never an L0 row', () => {
  const tree = { subjects: new Map([[A, 'aaaaaaaaaaaa'], [B, 'aaaaaaaaaaaa']]), pairs: [] }
  assert.equal(isStale(exactRow([A, B]), tree), false)
  assert.equal(isStale(exactRow([A, C]), tree), true)
  assert.equal(isStale({ ...exactRow([A, B]), rule: 'near' }, tree), true)
  assert.equal(isStale({ ...exactRow([A, B]), rule: 'near' }, { ...tree, pairs: [[A, B]] }), false)
  assert.equal(isStale({ ...exactRow([A, C]), rule: 'twin-schema' }, tree), false, 'a wire row is its own step\'s to judge')
  /** @type {any} */
  const mirror = { kind: 'mirror', mirror: ['p', 'q'], reason: REASON }
  assert.equal(isStale(mirror, tree, (p) => p === 'p'), true)
  assert.equal(isStale(mirror, tree, () => true), false)
  assert.equal(isStale(/** @type {any} */ ({ kind: 'l0', fingerprint: 'abcdef012345', reason: 'x' }), tree), false)
})

// ── the sweep, with the parser: the issue's anti-vacuity table ────────────────────

const GAMMA_BODY = BODY('gamma')
const KPKG = { 'packages/k/package.json': pkg('@app/k') }
const allowJson = (allow) => `${JSON.stringify({ comment: 'test', allow }, null, 2)}\n`

/** The sweep's duplication records, less complexity's, over a tree with a register. */
function sweepOf(files) {
  return inTree(files, () => {
    const doc = sweep(ts)
    assert.equal(doc.complete, true)
    for (const r of doc.records) assert.ok(advisoryRecordOk(r), JSON.stringify(r))
    const subjects = Object.fromEntries(extractTree(ts).callables.map((c) => [c.name, c.subject]))
    return { doc, subjects, rules: doc.records.map((r) => r.rule).filter((r) => r.startsWith('exact') || r.startsWith('accepted') || r === 'stale-row' || r === 'near-miss') }
  })
}

treeTest('register: the subjects the rows name are the extractor\'s', () => {
  const { subjects } = sweepOf({ ...KPKG, 'packages/k/src/a.ts': BODY('alpha'), 'packages/k/src/b.ts': BODY('beta') })
  assert.equal(subjects.alpha, A)
  assert.equal(subjects.beta, B)
})

treeTest('register: an exact row naming both members silences the class', () => {
  const tree = { ...KPKG, 'packages/k/src/a.ts': BODY('alpha'), 'packages/k/src/b.ts': BODY('beta') }
  const before = sweepOf(tree)
  const exact = before.doc.records.find((r) => r.rule === 'exact')
  assert.ok(exact, 'the fixture is a class')
  const after = sweepOf({ ...tree, 'tools/duplication-allow.json': allowJson([{ fingerprint: exact.fp, rule: 'exact', members: [A, B], reason: REASON }]) })
  assert.deepEqual(after.rules, [])
})

treeTest('register: a third copy keeps the class, naming the copy the row does not list', () => {
  const tree = { ...KPKG, 'packages/k/src/a.ts': BODY('alpha'), 'packages/k/src/b.ts': BODY('beta') }
  const fp = sweepOf(tree).doc.records.find((r) => r.rule === 'exact').fp
  const { doc } = sweepOf({
    ...tree,
    'packages/k/src/c.ts': GAMMA_BODY,
    'tools/duplication-allow.json': allowJson([{ fingerprint: fp, rule: 'exact', members: [A, B], reason: REASON }]),
  })
  const exact = doc.records.find((r) => r.rule === 'exact')
  assert.ok(exact)
  assert.equal(exact.counts.unlisted, 1)
  assert.deepEqual(exact.facts.unlisted.map((m) => m.name), ['gamma'])
  assert.match(explainRecord(exact), /^unlisted {3}`packages\/k\/src\/c\.ts:1` `gamma`$/m)
})

treeTest('register: delete one member and add another: the new one is named, the gone one is a stale row', () => {
  const tree = { ...KPKG, 'packages/k/src/a.ts': BODY('alpha'), 'packages/k/src/b.ts': BODY('beta') }
  const fp = sweepOf(tree).doc.records.find((r) => r.rule === 'exact').fp
  const { doc } = sweepOf({
    ...KPKG,
    'packages/k/src/b.ts': BODY('beta'),
    'packages/k/src/c.ts': GAMMA_BODY,
    'tools/duplication-allow.json': allowJson([{ fingerprint: fp, rule: 'exact', members: [A, B], reason: REASON }]),
  })
  assert.deepEqual(doc.records.find((r) => r.rule === 'exact').facts.unlisted.map((m) => m.name), ['gamma'])
  const stale = doc.records.filter((r) => r.rule === 'stale-row')
  assert.deepEqual(stale.map((r) => r.subject), [A])
  assert.equal(stale[0].facts.row, fp)
})

treeTest('register: edit one side and the edited side diverges; edit both the same way and the class changed', () => {
  const tree = { ...KPKG, 'packages/k/src/a.ts': BODY('alpha'), 'packages/k/src/b.ts': BODY('beta') }
  const fp = sweepOf(tree).doc.records.find((r) => r.rule === 'exact').fp
  const register = allowJson([{ fingerprint: fp, rule: 'exact', members: [A, B], reason: REASON }])
  const edit = (src) => src.replace('return { name:', 'const seen = payload.at\n  return { seen, name:')
  const one = sweepOf({ ...tree, 'packages/k/src/b.ts': edit(BODY('beta')), 'tools/duplication-allow.json': register })
  assert.deepEqual(one.rules, ['accepted-class-diverged'])
  const diverged = one.doc.records.find((r) => r.rule === 'accepted-class-diverged')
  assert.equal(diverged.subject, B)
  assert.equal(diverged.facts.member.name, 'beta')
  const both = sweepOf({
    ...KPKG,
    'packages/k/src/a.ts': edit(BODY('alpha')),
    'packages/k/src/b.ts': edit(BODY('beta')),
    'tools/duplication-allow.json': register,
  })
  assert.deepEqual(both.rules, ['accepted-class-changed'])
  assert.equal(both.doc.records[0].facts.row, fp)
})

treeTest('register: a mirror row silences a same-name pair on its two sides, and only that pair', () => {
  const sides = {
    'packages/web-ui/package.json': pkg('@app/web-ui'),
    'packages/web-ui/src/hooks.ts': BODY('useThing'),
    'packages/native-ui/package.json': pkg('@app/native-ui'),
    'packages/native-ui/src/hooks.ts': BODY('useThing'),
  }
  const mirror = allowJson([{ mirror: ['packages/web-ui/src', 'packages/native-ui/src'], reason: REASON }])
  assert.deepEqual(sweepOf(sides).rules.filter((r) => r.startsWith('exact')), ['exact'])
  assert.deepEqual(sweepOf({ ...sides, 'tools/duplication-allow.json': mirror }).rules, [])
  // A third copy elsewhere is judged normally: the class has three members, not one pair.
  const third = sweepOf({ ...sides, ...KPKG, 'packages/k/src/a.ts': BODY('useThing'), 'tools/duplication-allow.json': mirror })
  assert.deepEqual(third.rules.filter((r) => r.startsWith('exact')), ['exact'])
})

treeTest('register: --prune prints a ready-to-stage proposal without the stale rows', () => {
  const live = { fingerprint: 'abcdef012345', rule: 'exact', members: [A, B], reason: REASON }
  const gone = { fingerprint: 'abcdef012345', rule: 'exact', members: [A, C], reason: REASON }
  const l0 = { fingerprint: 'fedcba543210', reason: 'an L0 row stays' }
  const gate = fileURLToPath(new URL('../../template/base/tools/check-duplication.mjs', import.meta.url))
  inTree(
    {
      ...KPKG,
      'packages/k/src/a.ts': BODY('alpha'),
      'packages/k/src/b.ts': BODY('beta'),
      'tools/duplication-allow.json': allowJson([live, gone, l0]),
    },
    (dir) => {
      const r = spawnSync(process.execPath, [gate, '--prune'], { cwd: dir, encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stderr, /harness-proposals\/duplication-prune\.json/)
      const proposal = JSON.parse(r.stdout)
      assert.deepEqual(Object.keys(proposal), ['version', 'target', 'reason', 'base', 'content'])
      assert.equal(proposal.target, 'tools/duplication-allow.json')
      assert.equal(proposal.base, null, 'not in HEAD: there is no git here')
      assert.deepEqual(JSON.parse(proposal.content).allow, [live, l0])
    },
  )
  // Nothing stale: nothing printed. A register with shape errors: nothing proposed, exit 1.
  for (const [allow, code, re] of /** @type {[any[], number, RegExp][]} */ ([
    [[live, l0], 0, /nothing to prune/],
    [[{ ...live, rule: 'exakt' }], 1, /shape errors/],
  ])) {
    inTree(
      { ...KPKG, 'packages/k/src/a.ts': BODY('alpha'), 'packages/k/src/b.ts': BODY('beta'), 'tools/duplication-allow.json': allowJson(allow) },
      (dir) => {
        const r = spawnSync(process.execPath, [gate, '--prune'], { cwd: dir, encoding: 'utf8' })
        assert.equal(r.status, code, r.stderr)
        assert.equal(r.stdout, '')
        assert.match(r.stderr, re)
      },
    )
  }
})
