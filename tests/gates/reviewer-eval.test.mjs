// The factory's reviewer eval (1.1.0, #66): scripts/reviewer-eval.mjs.
//
// Nothing measured the reviewers. A change to a reviewer body, or to the model behind it,
// shipped on judgement. The eval holds a corpus of cases under tests/fixtures/reviewer-eval/,
// each a `case.json` (the reviewer, the verdict it must return, the companion-row ids a
// BLOCK must name) and an `overlay/` of new files (stored with a trailing `.txt`, so neither
// the root lint nor `node --test` reads them as repository code) plus anchored line inserts
// into shared files. `--check` validates the corpus offline, `--score <dir>` scores one
// recorded final message per case, and `--live <dir>` records them on a maintainer's machine.
//
// What this file proves, without git, a shell or a model:
//   - the corpus has the right shape: every kind of change the design record names has one
//     absence case and one complete control twin, and every id a case says its reviewer must
//     name is a row of that reviewer's companion table;
//   - every overlay applies to a fresh core-tier install, and the files it touches make the
//     case owe its reviewer by tools/reviewer-triggers.json (owedByTurn: torvalds-reviewer is
//     owed as a whole-turn reviewer, since 1.1.0 it has no path trigger);
//   - the score cannot be gamed by a constant answer: always-PASS and always-BLOCK each score
//     at most half, a perfect set scores full, a BLOCK that omits a required id is a miss,
//     and a reply with no parsable verdict is a miss;
//   - `--check` and `--score` exit 0 whatever the score and 1 only on a malformed corpus or
//     bad usage;
//   - no test runs `--live`, which spends model calls and stays on a maintainer's machine.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as evalLib from '../../scripts/reviewer-eval.mjs'
import { owedByTurn } from '../../template/base/tools/lib/reviewer-verdicts.mjs'
import { freshInstall } from '../installer/helpers/provenance-fixture.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SCRIPT = join(ROOT, 'scripts/reviewer-eval.mjs')
const CORPUS = join(ROOT, 'tests/fixtures/reviewer-eval')
const TRIGGERS = JSON.parse(readFileSync(join(ROOT, 'template/base/tools/reviewer-triggers.json'), 'utf8'))

const made = []
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})
const scratch = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  made.push(d)
  return d
}
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' })

const corpus = evalLib.loadCorpus(CORPUS)
const cases = corpus.cases

test('the corpus loads and has the right shape', () => {
  assert.deepEqual(corpus.problems, [])
  assert.deepEqual(evalLib.corpusProblems(corpus), [])
  assert.ok(cases.length >= 10, `expected at least ten cases, got ${cases.length}`)
})

test('every kind the design record names has one absence case and one complete control twin', () => {
  for (const kind of evalLib.KINDS) {
    const ofKind = cases.filter((c) => c.kind === kind)
    const absence = ofKind.filter((c) => c.expect === 'BLOCK')
    const control = ofKind.filter((c) => c.expect === 'PASS')
    assert.ok(absence.length >= 1 && control.length >= 1, `${kind}: needs an absence case and a control twin`)
  }
  for (const c of cases) {
    const twin = cases.find((t) => t.name === c.twin)
    assert.ok(twin, `${c.name}: its twin ${c.twin} is not in the corpus`)
    assert.equal(twin.twin, c.name, `${c.name} and ${c.twin} must name each other`)
    assert.equal(twin.reviewer, c.reviewer, `${c.name}: a twin is judged by the same reviewer`)
    assert.notEqual(twin.expect, c.expect, `${c.name}: one twin BLOCKs and the other PASSes`)
  }
  assert.equal(cases.filter((c) => c.expect === 'BLOCK').length, cases.filter((c) => c.expect === 'PASS').length)
})

test('the table absence case is the two-revoke migration behind the 1.0.2 finding', () => {
  const absence = cases.find((c) => c.kind === 'table' && c.expect === 'BLOCK')
  assert.ok(absence)
  assert.equal(absence.reviewer, 'security-reviewer')
  assert.ok(absence.mustName.includes('table-authenticated-revoke'))
  const sql = absence.overlay
    .filter((o) => o.path.startsWith('supabase/migrations/'))
    .map((o) => readFileSync(o.source, 'utf8'))
    .join('\n')
  assert.match(sql, /REVOKE ALL ON TABLE public\.\w+ FROM anon;/)
  assert.match(sql, /REVOKE ALL ON TABLE public\.\w+ FROM service_role;/)
  assert.doesNotMatch(sql, /FROM authenticated/)
})

test('every overlay applies to a fresh core-tier install, and each case owes its reviewer', async () => {
  const pristine = await freshInstall('reviewer-eval-')
  made.push(pristine)
  for (const c of cases) {
    const dir = scratch(`reviewer-eval-${c.name}-`)
    cpSync(pristine, dir, { recursive: true })
    const { changed, problems } = evalLib.applyCase(c, dir)
    assert.deepEqual(problems, [], `${c.name}: the overlay does not apply`)
    assert.deepEqual(changed, evalLib.caseChanges(c), `${c.name}: the overlay touched other paths than it declares`)
    for (const p of changed) assert.ok(existsSync(join(dir, p)), `${c.name}: ${p} was not written`)
    for (const o of c.overlay) {
      assert.ok(!existsSync(join(pristine, o.path)), `${c.name}: ${o.path} must be a NEW file`)
      assert.equal(readFileSync(join(dir, o.path), 'utf8'), readFileSync(o.source, 'utf8'))
    }
    const owed = owedByTurn(changed, TRIGGERS).map((o) => o.agent)
    assert.ok(owed.includes(c.reviewer), `${c.name}: its files do not make ${c.reviewer} owed (owed: ${owed.join(', ')})`)
  }
})

test('an overlay that would overwrite a file, or an anchor that is missing or repeated, does not apply', async () => {
  const dir = await freshInstall('reviewer-eval-bad-')
  made.push(dir)
  const src = join(scratch('reviewer-eval-src-'), 'x.txt')
  writeFileSync(src, 'x\n')
  const bad = {
    name: 'bad',
    overlay: [{ path: 'AGENTS.md', source: src }],
    edits: [
      { path: 'tools/reviewer-triggers.json', after: 'no such line anywhere', lines: ['x'] },
      { path: 'tests/rls/db-context.ts', after: '  {', lines: ['x'] },
    ],
  }
  const { problems } = evalLib.applyCase(bad, dir)
  assert.equal(problems.length, 3, problems.join('\n'))
  assert.match(problems.join('\n'), /AGENTS\.md: already exists/)
  assert.match(problems.join('\n'), /reviewer-triggers\.json: the anchor .* matches 0 lines/)
  assert.match(problems.join('\n'), /db-context\.ts: the anchor .* matches \d+ lines/)
})

// ── scoring ──────────────────────────────────────────────────────────────────────────────

const perfect = (c) =>
  c.expect === 'PASS'
    ? 'Every companion row that applies is present.\n\nVERDICT: PASS'
    : `${c.mustName.map((id) => `${id}: absent`).join('\n')}\n- [HIGH] file:1 — absent companion\n\nVERDICT: BLOCK`
const replySet = (fn) => Object.fromEntries(cases.map((c) => [c.name, fn(c)]))

test('a perfect reply set scores full; always-PASS and always-BLOCK each score at most half', () => {
  const full = evalLib.scoreReplies(cases, replySet(perfect))
  assert.equal(full.hits, cases.length)
  assert.equal(full.total, cases.length)
  const allPass = evalLib.scoreReplies(cases, replySet(() => 'Looks fine.\n\nVERDICT: PASS'))
  assert.ok(allPass.hits * 2 <= allPass.total, `always-PASS scored ${allPass.hits}/${allPass.total}`)
  const everyId = [...new Set(cases.flatMap((c) => c.mustName))].map((id) => `${id}: absent`).join('\n')
  const allBlock = evalLib.scoreReplies(cases, replySet(() => `${everyId}\n\nVERDICT: BLOCK`))
  assert.ok(allBlock.hits * 2 <= allBlock.total, `always-BLOCK scored ${allBlock.hits}/${allBlock.total}`)
})

test('a BLOCK that lacks a mustName id is a miss, and so is a reply with no parsable verdict or none at all', () => {
  const absence = cases.find((c) => c.expect === 'BLOCK')
  const control = cases.find((c) => c.name === absence.twin)
  const [first] = absence.mustName
  const lacking = evalLib.scoreReplies([absence], { [absence.name]: 'Something is missing.\n\nVERDICT: BLOCK' })
  assert.equal(lacking.hits, 0)
  assert.deepEqual(lacking.results[0].missing, absence.mustName)
  // An id inside a LONGER id does not count as naming it.
  const longer = evalLib.scoreReplies([absence], { [absence.name]: `${first}-extended: absent\n\nVERDICT: BLOCK` })
  assert.equal(longer.hits, 0)
  const noVerdict = evalLib.scoreReplies([absence, control], {
    [absence.name]: `${absence.mustName.join('\n')}\nBLOCK, I think.`,
    [control.name]: 'VERDICT: PASS\n\nand one more thing',
  })
  assert.equal(noVerdict.hits, 0)
  assert.deepEqual(
    noVerdict.results.map((r) => r.got),
    [null, null],
  )
  const none = evalLib.scoreReplies([control], {})
  assert.equal(none.hits, 0)
  assert.equal(none.results[0].got, null)
})

// ── the CLI ──────────────────────────────────────────────────────────────────────────────

test('--check exits 0 on the shipped corpus and names the case count', () => {
  const r = run('--check')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, new RegExp(`reviewer-eval: OK — ${cases.length} case\\(s\\)`))
})

test('--check exits 1 on a malformed corpus, naming each problem', () => {
  const dir = scratch('reviewer-eval-corpus-')
  cpSync(CORPUS, dir, { recursive: true })
  const [first] = readdirSync(dir).sort()
  const file = join(dir, first, 'case.json')
  const c = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ ...c, expect: 'MAYBE', mustName: ['no-such-row'] }))
  mkdirSync(join(dir, 'stray'))
  writeFileSync(join(dir, 'stray', 'case.json'), '{ not json')
  const r = run('--check', '--corpus', dir)
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stderr, new RegExp(`${first}: expect must be PASS or BLOCK`))
  assert.match(r.stderr, /stray: case\.json does not parse/)
})

test('--score exits 0 whatever the score, and prints one line per case and the total', () => {
  const dir = scratch('reviewer-eval-replies-')
  for (const c of cases) writeFileSync(join(dir, `${c.name}.txt`), 'VERDICT: PASS\n')
  const r = run('--score', dir)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, new RegExp(`score: ${cases.length / 2}/${cases.length}`))
  for (const c of cases) assert.match(r.stdout, new RegExp(`(HIT|MISS) +${c.name}\\b`))
})

test('bad usage exits 1: no mode, an unknown flag, --score without a readable directory', () => {
  for (const args of [[], ['--nope'], ['--score'], ['--score', join(tmpdir(), 'reviewer-eval-no-such-dir')]]) {
    const r = run(...args)
    assert.equal(r.status, 1, `${JSON.stringify(args)}: ${r.stdout}${r.stderr}`)
    assert.match(r.stderr, /usage: node scripts\/reviewer-eval\.mjs/)
  }
})

test('no test runs --live', () => {
  // The flag is spelled in two halves here so this file does not match its own scan.
  const flag = `--${'live'}`
  const tests = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory() && e.name !== 'fixtures' && e.name !== 'node_modules') walk(p)
      else if (e.isFile() && e.name.endsWith('.test.mjs')) tests.push(p)
    }
  }
  walk(join(ROOT, 'tests'))
  const offenders = tests.filter((p) => readFileSync(p, 'utf8').includes(flag)).map((p) => relative(ROOT, p))
  assert.deepEqual(offenders, [])
})
