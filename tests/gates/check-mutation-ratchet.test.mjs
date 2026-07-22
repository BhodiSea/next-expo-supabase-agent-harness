// Can-fail proofs for the mutation ratchet (template/base/tools/check-mutation-ratchet.mjs):
// a set-based compare of surviving mutants against a committed, human-reasoned baseline.
// Pure JSON in, exit code out — no Stryker needed to test the machinery.
//
// The two tests that matter most are the ones the PRE-PROMOTION ratchet (in the source
// harness lineage) would have FAILED, because both defects only surface once the lane is
// incremental and blocking:
//   - survivor identity must be POSITION-INDEPENDENT (it was file:line:column, so inserting
//     one line at the top of a file turned every survivor below it into a "new" one);
//   - kill-detection must be scoped to the files THIS REPORT MUTATED (it compared against the
//     whole baseline, so a diff-scoped run reported every unmutated file's survivors as
//     "killed" — and `--write` would then have silently ERASED them).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(
  new URL('../../template/base/tools/check-mutation-ratchet.mjs', import.meta.url),
)
const GATE_LIB_DIR = fileURLToPath(new URL('../../template/base/tools/lib', import.meta.url))

const ERRORS_TS = `import { z } from 'zod'

export function apiError(code, message) {
  if (code === undefined) return null
  return { code, message: message.slice(0, 1024) }
}
`

/** One Survived mutant on the `if` at line 4, plus a Killed one that must never be recorded. */
const reportFor = (source = ERRORS_TS) => ({
  files: {
    'apps/server/src/errors.ts': {
      source,
      mutants: [
        {
          status: 'Survived',
          mutatorName: 'ConditionalExpression',
          replacement: 'true',
          location: { start: { line: 4, column: 7 }, end: { line: 4, column: 25 } },
        },
        {
          status: 'Killed',
          mutatorName: 'StringLiteral',
          replacement: '""',
          location: { start: { line: 1, column: 20 }, end: { line: 1, column: 25 } },
        },
      ],
    },
  },
})

/** @param {{ report?: any, baseline?: any }} [opts] */
function fixture({ report = reportFor(), baseline } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-ratchet-'))
  mkdirSync(join(dir, 'reports/mutation'), { recursive: true })
  mkdirSync(join(dir, 'tools'), { recursive: true })
  mkdirSync(join(dir, 'apps/server/src'), { recursive: true })
  // The gate checks existsSync(entry.file) to spot stale entries — give it a real tree.
  writeFileSync(join(dir, 'apps/server/src/errors.ts'), ERRORS_TS)
  cpSync(GATE_LIB_DIR, join(dir, 'tools/lib'), { recursive: true })
  cpSync(SCRIPT, join(dir, 'tools/check-mutation-ratchet.mjs'))
  if (report !== null) {
    writeFileSync(join(dir, 'reports/mutation/mutation.json'), JSON.stringify(report))
  }
  if (baseline !== undefined) {
    writeFileSync(join(dir, 'tools/mutation-baseline.json'), JSON.stringify(baseline))
  }
  return dir
}

function run(dir, args = []) {
  const env = { ...process.env }
  delete env.CI
  const r = spawnSync('node', ['tools/check-mutation-ratchet.mjs', ...args], {
    cwd: dir,
    encoding: 'utf8',
    env,
  })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** Seed a baseline the way a human must: --write, then write the reasons in. */
function seededBaseline(dir, reason = 'reviewed: genuinely equivalent') {
  run(dir, ['--write'])
  const path = join(dir, 'tools/mutation-baseline.json')
  const data = JSON.parse(readFileSync(path, 'utf8'))
  data.survivors = data.survivors.map((s) => ({ ...s, reason }))
  writeFileSync(path, JSON.stringify(data, null, 2))
  return data
}

test('RED: a survivor the baseline does not accept names the mutant and the change', () => {
  const r = run(fixture({ baseline: { survivors: [] } }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /new surviving mutant/i)
  assert.match(r.out, /apps\/server\/src\/errors\.ts/, r.out)
  assert.match(r.out, /ConditionalExpression/, r.out)
  // The red must show what the machine actually DID to the source.
  assert.match(r.out, /-->\s*true/, r.out)
})

test('GREEN: survivors that match the committed baseline pass', () => {
  const dir = fixture()
  seededBaseline(dir)
  const r = run(dir)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /within the committed baseline/, r.out)
})

test('a NoCoverage mutant is a survivor too — no test even RUNS that code', () => {
  const report = reportFor()
  report.files['apps/server/src/errors.ts'].mutants[0].status = 'NoCoverage'
  const r = run(fixture({ report, baseline: { survivors: [] } }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /NoCoverage/, r.out)
})

test('RED: an accepted survivor with NO REASON fails — acceptance is a reviewed act', () => {
  const dir = fixture()
  run(dir, ['--write']) // --write records the survivor with reason: ''
  const r = run(dir)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /NO REASON/, r.out)
  // and --write must TELL the human that a reason is still owed
  const seeded = run(fixture(), ['--write'])
  assert.match(seeded.out, /still need a reason/, seeded.out)
})

// ---------------------------------------------------------------------------------------
// The defect that made the pre-promotion baseline worthless.
// ---------------------------------------------------------------------------------------
test('a LINE SHIFT does not invalidate the baseline (identity is position-independent)', () => {
  const dir = fixture()
  seededBaseline(dir)

  // Someone adds a two-line header. Every line number in the file moves. Under the old
  // file:line:column identity this alone reported the survivor as brand new.
  // REUSE-IgnoreStart — the tag below is TEST DATA (a header an author might add), not a
  // real license declaration for this file; the reuse tool otherwise parses it as one.
  const shifted = `// (c) 2026\n// SPDX-License-Identifier: 0BSD\n${ERRORS_TS}`
  // REUSE-IgnoreEnd
  const report = reportFor(shifted)
  const m = report.files['apps/server/src/errors.ts'].mutants
  m[0].location = { start: { line: 6, column: 7 }, end: { line: 6, column: 25 } }
  m[1].location = { start: { line: 3, column: 20 }, end: { line: 3, column: 25 } }
  writeFileSync(join(dir, 'reports/mutation/mutation.json'), JSON.stringify(report))

  const r = run(dir)
  assert.equal(r.code, 0, `a line shift must not red the ratchet\n${r.out}`)
})

test('but CHANGING the mutated code DOES invalidate it — re-examine the survivor', () => {
  const dir = fixture()
  seededBaseline(dir)
  const edited = ERRORS_TS.replace('code === undefined', 'code === null')
  writeFileSync(join(dir, 'reports/mutation/mutation.json'), JSON.stringify(reportFor(edited)))
  const r = run(dir)
  assert.equal(r.code, 1, `the guarded code changed — the acceptance is stale\n${r.out}`)
})

// ---------------------------------------------------------------------------------------
// The defect that would have made the INCREMENTAL lane destructive.
// ---------------------------------------------------------------------------------------
const OTHER_FILE = {
  id: 'deadbeef0001',
  file: 'apps/server/src/dal/notes.ts',
  mutator: 'EqualityOperator',
  original: 'a === b',
  replacement: 'a !== b',
  snippet: 'if (a === b)',
  reason: 'reviewed: unreachable guard',
}

test('a DIFF-SCOPED run does not report unmutated files as "killed"', () => {
  const dir = fixture()
  const data = seededBaseline(dir)
  data.survivors.push(OTHER_FILE)
  writeFileSync(join(dir, 'tools/mutation-baseline.json'), JSON.stringify(data, null, 2))
  mkdirSync(join(dir, 'apps/server/src/dal'), { recursive: true })
  writeFileSync(join(dir, 'apps/server/src/dal/notes.ts'), 'export const x = 1\n')

  // This PR only touched errors.ts, so only errors.ts is in the report.
  const r = run(dir)
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /notes\.ts/, `notes.ts was never mutated — it cannot be "killed"\n${r.out}`)
})

test('--write MERGES: a diff-scoped regeneration never erases another file’s entries', () => {
  const dir = fixture()
  const data = seededBaseline(dir)
  data.survivors.push(OTHER_FILE)
  writeFileSync(join(dir, 'tools/mutation-baseline.json'), JSON.stringify(data, null, 2))

  // Regenerate from a report that only covers errors.ts.
  run(dir, ['--write'])
  const after = JSON.parse(readFileSync(join(dir, 'tools/mutation-baseline.json'), 'utf8'))
  assert.ok(
    after.survivors.some((s) => s.file === 'apps/server/src/dal/notes.ts'),
    'the notes.ts entry was ERASED by a run that never mutated it',
  )
  // and the human-written reason on the regenerated errors.ts entry survives
  const errorsEntry = after.survivors.find((s) => s.file === 'apps/server/src/errors.ts')
  assert.equal(errorsEntry.reason, 'reviewed: genuinely equivalent')
})

test('GREEN + tighten hint: a baseline survivor the tests now KILL invites --write', () => {
  const dir = fixture()
  seededBaseline(dir)
  const report = reportFor()
  report.files['apps/server/src/errors.ts'].mutants[0].status = 'Killed'
  writeFileSync(join(dir, 'reports/mutation/mutation.json'), JSON.stringify(report))
  const r = run(dir)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /ratchet out|now KILLED/i, r.out)
})

test('a baseline entry whose file is GONE is a NOTE, not a failure (an un-installed module)', () => {
  const dir = fixture()
  const data = seededBaseline(dir)
  data.survivors.push({
    id: 'deadbeef0002',
    file: 'apps/server/src/crash/redact.ts',
    mutator: 'Regex',
    original: '/x/',
    replacement: '/y/',
    snippet: 'const RE = /x/',
    reason: 'crash-reporting module: not installed at this tier',
  })
  writeFileSync(join(dir, 'tools/mutation-baseline.json'), JSON.stringify(data, null, 2))
  const r = run(dir)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /no longer exists/, r.out)
})

test('an EMPTY diff scope is green — a PR touching no critical file pays nothing', () => {
  const r = run(fixture({ report: { files: {} } }))
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /mutated no files/, r.out)
})

test('RED: a missing report, and a malformed baseline, both fail LOUD', () => {
  const missing = run(fixture({ report: null, baseline: { survivors: [] } }))
  assert.equal(missing.code, 1, missing.out)
  assert.match(missing.out, /missing/, missing.out)

  const badJson = fixture()
  writeFileSync(join(badJson, 'tools/mutation-baseline.json'), '{ not json')
  const broken = run(badJson)
  assert.equal(broken.code, 1, broken.out)
  assert.match(broken.out, /not valid JSON/, broken.out)

  const shape = run(fixture({ baseline: { survivors: 'nope' } }))
  assert.equal(shape.code, 1, shape.out)
  assert.match(shape.out, /must carry a "survivors" ARRAY/, shape.out)
})

test('an ABSENT baseline self-disables locally (adoption) and FAILS CLOSED in CI', () => {
  const dir = fixture() // no baseline written
  const local = run(dir)
  assert.equal(local.code, 0, local.out)
  assert.match(local.out, /SKIPPED/, local.out)
  assert.match(local.out, /--write/, local.out)

  const r = spawnSync('node', ['tools/check-mutation-ratchet.mjs'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
  })
  assert.equal(r.status, 1, `a skip must never look like a pass in CI\n${r.stdout}${r.stderr}`)
})
