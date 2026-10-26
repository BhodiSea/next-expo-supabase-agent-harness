// Can-fail proof for the history half of scripts/check-released-shas.mjs (2.0.4, #259).
//
// The documented install command has no tag, so an install can come from any commit `main`
// ever pointed at, and each table must list what EVERY first-parent `main` commit of its
// version shipped. --verify-tags used to look at the tags only, and the committed tables did
// miss untagged commits: an untouched install made from `main` at 8de6d2349 (the merge of
// #95, version 1.0.4) had six owned files parked as forks on `update`, because a merge commit
// can carry bytes no pull request's CI ever checked.
//
// This needs git history (the commit, and a resolvable `main`), unlike its sibling
// check-released-shas.test.mjs, so it SKIPS BY NAME in a shallow or tagless clone
// (installer-unit's checkout, the Windows leg). lint.yml machinery-lint runs the whole
// history check with fetch-depth: 0 on every pull request.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = join(ROOT, 'scripts/check-released-shas.mjs')
const TABLES = join(ROOT, 'template/shas')
// The merge of #95: version 1.0.4, untagged, and its tools/lib/gate.mjs is in no tag.
const UNTAGGED = '8de6d2349'
const VICTIM = 'tools/lib/gate.mjs'

/** @param {string[]} argv */
function gitOk(argv) {
  try {
    return execFileSync('git', argv, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

const history =
  gitOk(['rev-parse', '--is-shallow-repository'])?.trim() === 'false' &&
  (gitOk(['rev-parse', '-q', '--verify', 'main^{commit}']) ?? gitOk(['rev-parse', '-q', '--verify', 'origin/main^{commit}'])) !== null &&
  gitOk(['cat-file', '-e', `${UNTAGGED}^{commit}`]) !== null
const skip = history ? false : `needs full history with main and ${UNTAGGED} (a shallow or tagless clone); lint.yml machinery-lint runs the history check`

/** @type {string[]} */
const made = []
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

/** @param {string[]} args */
function run(args) {
  const res = spawnSync(process.execPath, [SCRIPT, '--verify-tags', '--only-version', '1.0.4', ...args], { encoding: 'utf8' })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('GREEN: the shipped 1.0.4 table lists what every 1.0.4 commit of main shipped, tagged or not', { skip }, () => {
  const res = run([])
  assert.equal(res.code, 0, res.out)
  assert.match(res.out, /main commit\(s\) verified/, res.out)
})

test('RED: a variant only an untagged main commit shipped, missing from its table, names the commit and the file', { skip }, () => {
  const sha = createHash('sha256')
    .update(execFileSync('git', ['show', `${UNTAGGED}:template/base/${VICTIM}`], { cwd: ROOT }))
    .digest('hex')
  const dir = mkdtempSync(join(tmpdir(), 'nsah-shas-history-'))
  made.push(dir)
  cpSync(TABLES, dir, { recursive: true })
  const path = join(dir, '1.0.4.json')
  const table = JSON.parse(readFileSync(path, 'utf8'))
  table.files[VICTIM] = (table.files[VICTIM] ?? []).filter((/** @type {{ sha256: string }} */ v) => v.sha256 !== sha)
  writeFileSync(path, `${JSON.stringify(table, null, 2)}\n`)

  const res = run(['--tables-dir', dir])
  assert.equal(res.code, 1, res.out)
  assert.ok(res.out.includes(`main ${UNTAGGED}`) && res.out.includes(`${VICTIM} ships sha256 ${sha.slice(0, 12)}`), res.out)
  assert.ok(res.out.includes('generate-released-shas.mjs --all'), res.out)
})
