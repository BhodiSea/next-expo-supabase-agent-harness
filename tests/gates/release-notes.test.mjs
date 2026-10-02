// scripts/ci/release-notes.mjs (2.0.0): the release job's notes.
//
// `sectionOf` is the CHANGELOG.md section a tag publishes, and `boundNotes` keeps it under
// GitHub's 125000-character limit on a release body: unchanged when it fits, every entry
// shortened to its bold lead and issue references when it does not, and a hard failure when
// even that does not fit. The first v1.1.0 build failed at `gh release create` with HTTP 422
// on a 166000-character section, after packing and attesting, so `publish-npm` never ran.
// These tests pin both verdicts pure, run the CLI on fixtures, and bound the real
// CHANGELOG.md's section for the version in package.json, so a section that cannot be
// published fails here rather than at tag time.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { RELEASE_BODY_LIMIT, boundNotes, sectionOf, shortenEntries } from '../../scripts/ci/release-notes.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = join(ROOT, 'scripts/ci/release-notes.mjs')
const run = promisify(execFile)
const REPO = 'owner/repo'

const CHANGELOG = [
  '# Changelog',
  '',
  '## [2.0.0] — 2026-11-01',
  '',
  'Two-oh opening.',
  '',
  '## [1.1.0] — 2026-10-02',
  '',
  '**A minor, the sharper verdicts release.** Its opening paragraph',
  'runs over two lines (#39).',
  '',
  '### Added',
  '',
  '- **A deferral for the device lanes.** The long explanation',
  // Forty lines of detail, as a real entry carries, so shortening has something to save.
  ...Array.from({ length: 40 }, () => '  continues here, with `code` and a second sentence that runs on,'),
  '  and closes on its issue (#56).',
  '- **Published to npm.** One line of detail (#161, #162).',
  '',
  '### Fixed',
  '',
  '- **No issue reference.** Detail with no closing reference.',
  '- An entry with no bold lead keeps',
  '  every one of its lines (#77).',
  '',
  '  A second paragraph of the same entry,',
  '  indented under it (#77).',
  '',
  '### What stays open, honestly',
  '',
  '- **The walk reads literals.** Detail (#76).',
  '',
  '## [1.0.4] — 2026-10-01',
  '',
  'Last section, which runs to the end of the file.',
  '',
].join('\n')

test('sectionOf: the lines between the heading and the next ## [ heading, without the heading', () => {
  const s = sectionOf(CHANGELOG, '1.1.0')
  assert.ok(s !== null)
  assert.match(s, /^\n\*\*A minor/)
  assert.ok(!s.includes('## [1.1.0]'))
  assert.ok(!s.includes('Two-oh opening'))
  assert.ok(!s.includes('## [1.0.4]'))
  assert.match(s, /The walk reads literals/)
})

test('sectionOf: the last section runs to the end of the file; a missing one is null', () => {
  assert.equal(sectionOf(CHANGELOG, '1.0.4'), '\nLast section, which runs to the end of the file.\n')
  assert.equal(sectionOf(CHANGELOG, '9.9.9'), null)
  // A heading for 1.1.0 does not answer for 1.1 or 1.1.0-rc.1.
  assert.equal(sectionOf(CHANGELOG, '1.1'), null)
  assert.equal(sectionOf(CHANGELOG, '1.1.0-rc.1'), null)
})

test('boundNotes: a section within the limit is the body unchanged', () => {
  const s = /** @type {string} */ (sectionOf(CHANGELOG, '1.1.0'))
  assert.deepEqual(boundNotes(s, { version: '1.1.0', repository: REPO }), { notes: s, shortened: false })
  // The limit is inclusive.
  const exact = boundNotes(s, { version: '1.1.0', repository: REPO, limit: Buffer.byteLength(s) })
  assert.deepEqual(exact, { notes: s, shortened: false })
})

test('shortenEntries: each top-level entry becomes its bold lead and closing references; every other line stays', () => {
  const s = /** @type {string} */ (sectionOf(CHANGELOG, '1.1.0'))
  const out = shortenEntries(s).split('\n')
  // The opening paragraph and every heading are kept as written.
  assert.ok(out.includes('**A minor, the sharper verdicts release.** Its opening paragraph'))
  assert.ok(out.includes('runs over two lines (#39).'))
  for (const h of ['### Added', '### Fixed', '### What stays open, honestly']) assert.ok(out.includes(h), h)
  assert.ok(out.includes('- **A deferral for the device lanes.** (#56)'))
  assert.ok(out.includes('- **Published to npm.** (#161, #162)'))
  assert.ok(out.includes('- **No issue reference.**'))
  assert.ok(out.includes('- **The walk reads literals.** (#76)'))
  assert.ok(!out.some((line) => line.includes('The long explanation') || line.includes('continues here')))
  // An entry with no bold lead has nothing shorter to say, so all of it stays, its
  // indented second paragraph included.
  for (const line of ['- An entry with no bold lead keeps', '  every one of its lines (#77).', '  A second paragraph of the same entry,']) {
    assert.ok(out.includes(line), line)
  }
  // The blank line between an entry and the next heading survives the shortening.
  assert.equal(out[out.indexOf('### Fixed') - 1], '')
})

test('boundNotes: over the limit, the shortened body fits and links the full section at the tag', () => {
  const s = /** @type {string} */ (sectionOf(CHANGELOG, '1.1.0'))
  const limit = Buffer.byteLength(s) - 1
  const bounded = boundNotes(s, { version: '1.1.0', repository: REPO, limit })
  assert.ok('notes' in bounded)
  assert.equal(bounded.shortened, true)
  assert.ok(Buffer.byteLength(bounded.notes) <= limit)
  assert.match(bounded.notes, /- \*\*A deferral for the device lanes\.\*\* \(#56\)\n/)
  assert.match(bounded.notes, /\[CHANGELOG\.md at v1\.1\.0\]\(https:\/\/github\.com\/owner\/repo\/blob\/v1\.1\.0\/CHANGELOG\.md\)/)
  assert.match(bounded.notes, new RegExp(`This section is ${String(Buffer.byteLength(s))} bytes`))
})

test('boundNotes: a section still over the limit once shortened is a hard failure naming both sizes', () => {
  const s = /** @type {string} */ (sectionOf(CHANGELOG, '1.1.0'))
  const bounded = boundNotes(s, { version: '1.1.0', repository: REPO, limit: 100 })
  assert.ok('error' in bounded)
  assert.match(bounded.error, new RegExp(`the 1\\.1\\.0 section is ${String(Buffer.byteLength(s))} bytes and still \\d+`))
  assert.match(bounded.error, /Shorten the section in CHANGELOG\.md/)
})

test('size is UTF-8 bytes, never less than the character count GitHub enforces', () => {
  const s = '- **Ein Eintrag mit Umlauten: äöü.** Detail (#1).\n'
  const chars = [...s].length
  assert.ok(Buffer.byteLength(s) > chars)
  // At a limit equal to the character count the section is judged over it.
  const bounded = boundNotes(s, { version: '1.0.0', repository: REPO, limit: chars })
  assert.ok(!('notes' in bounded && bounded.shortened === false))
})

test('CLI: writes the notes to stdout, shortens over --limit, and fails on a missing section or a bad repository', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-notes-'))
  const file = join(dir, 'CHANGELOG.md')
  writeFileSync(file, CHANGELOG)
  const whole = await run('node', [SCRIPT, '1.1.0', '--repository', REPO, '--changelog', file])
  assert.equal(whole.stdout, sectionOf(CHANGELOG, '1.1.0'))
  const short = await run('node', [SCRIPT, '1.1.0', '--repository', REPO, '--changelog', file, '--limit', '1500'])
  assert.match(short.stdout, /- \*\*Published to npm\.\*\* \(#161, #162\)/)
  assert.match(short.stderr, /each entry is shortened to its lead/)
  await assert.rejects(run('node', [SCRIPT, '9.9.9', '--repository', REPO, '--changelog', file]), (/** @type {any} */ err) => {
    assert.equal(err.code, 1)
    assert.match(err.stderr, /is missing a '## \[9\.9\.9\]' section/)
    return true
  })
  await assert.rejects(run('node', [SCRIPT, '1.1.0', '--changelog', file]), (/** @type {any} */ err) => {
    assert.equal(err.code, 1)
    assert.match(err.stderr, /--repository must be owner\/repo/)
    return true
  })
  await assert.rejects(run('node', [SCRIPT, '1.1.0', '--repository', REPO, '--changelog', file, '--limit', '100']), (/** @type {any} */ err) => {
    assert.equal(err.code, 1)
    assert.match(err.stderr, /Shorten the section in CHANGELOG\.md/)
    return true
  })
})

test("this repository's CHANGELOG.md section for package.json's version can be published", () => {
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const section = sectionOf(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), version)
  assert.ok(section !== null, `CHANGELOG.md has no '## [${String(version)}]' section`)
  const bounded = boundNotes(section, { version, repository: 'BhodiSea/next-expo-supabase-agent-harness' })
  assert.ok('notes' in bounded, 'error' in bounded ? bounded.error : '')
  assert.ok(Buffer.byteLength(bounded.notes) <= RELEASE_BODY_LIMIT)
})
