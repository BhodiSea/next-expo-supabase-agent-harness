// Unit tests for the REUSE structural mirror's pure core
// (scripts/check-reuse.mjs, repo selftest only — never shipped). CI runs the
// real `reuse lint`; these tests pin the OFFLINE mirror: the fail-closed
// TOML-subset parser, the exact glob semantics it emits (** crosses /, *
// does not), reuse-tool's latest-match-wins annotation resolution, the
// spec-ignored path set, and the license-consistency contract (README +
// CITATION.cff + package.json agree with REUSE.toml — this is the single
// home for that check; check-release-lockstep stays version-only).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  coveringAnnotation,
  globToRegExp,
  licenseIdsFromExpression,
  parseReuseToml,
  reuseProblems,
  specIgnored,
} from '../../scripts/check-reuse.mjs'

const REAL_REUSE_TOML = fileURLToPath(new URL('../../REUSE.toml', import.meta.url))

const VALID = `# comment
version = 1

[[annotations]]
path = "**"
precedence = "aggregate"
SPDX-FileCopyrightText = "2026 Cogvera Labs"
SPDX-License-Identifier = "Apache-2.0"

[[annotations]]
path = "template/**"
precedence = "aggregate"
SPDX-FileCopyrightText = "2026 Cogvera Labs"
SPDX-License-Identifier = "Apache-2.0 OR 0BSD"
`

const parsedValid = () => parseReuseToml(VALID)

// --- parser: the pinned grammar parses; everything else fails CLOSED --------

test('the emitted REUSE.toml shape parses: version, ordered annotations, mapped keys', () => {
  const { version, annotations } = parsedValid()
  assert.equal(version, 1)
  assert.equal(annotations.length, 2)
  assert.deepEqual(annotations[0], {
    path: '**',
    precedence: 'aggregate',
    copyright: '2026 Cogvera Labs',
    license: 'Apache-2.0',
  })
  assert.equal(annotations[1].license, 'Apache-2.0 OR 0BSD')
})

test('the REAL committed REUSE.toml parses under the pinned grammar', () => {
  const { annotations } = parseReuseToml(readFileSync(REAL_REUSE_TOML, 'utf8'))
  assert.ok(annotations.length >= 2)
})

test('parser fails closed on anything outside the pinned subset', () => {
  const cases = [
    ['version = 2 rejected', VALID.replace('version = 1', 'version = 2'), /version = 1/],
    ['missing version rejected', VALID.replace('version = 1\n', ''), /version = 1/],
    ['unknown key rejected', VALID.replace('precedence', 'precedense'), /outside the pinned/],
    ['unknown table rejected', `${VALID}[[other]]\n`, /outside the pinned/],
    ['missing required key rejected', VALID.replace(/precedence = "aggregate"\n/g, ''), /missing required key "precedence"/],
    ['non-aggregate precedence rejected', VALID.replaceAll('"aggregate"', '"override"'), /outside the pinned subset \(only "aggregate"/],
    ['duplicate key rejected', VALID.replace('path = "**"', 'path = "**"\npath = "b"'), /duplicate key "path"/],
    ['empty value rejected', VALID.replace('"template/**"', '""'), /empty value/],
    ['escape sequences rejected', VALID.replace('"template/**"', '"a\\"b"'), /outside the pinned/],
    ['inline comment rejected', VALID.replace('precedence = "aggregate"', 'precedence = "aggregate" # inline'), /outside the pinned/],
    ['single quotes rejected', VALID.replace('"aggregate"', "'aggregate'"), /outside the pinned/],
    ['arrays rejected (subset emits single strings)', VALID.replace('"template/**"', '["template/**"]'), /outside the pinned/],
    ['no annotations at all rejected', 'version = 1\n', /no \[\[annotations\]\]/],
  ]
  for (const [name, text, re] of /** @type {[string, string, RegExp][]} */ (cases)) {
    assert.throws(() => parseReuseToml(text), re, name)
  }
})

// --- glob semantics: exactly reuse-tool's ** and * ---------------------------

test('** crosses path separators (top-level files AND deep files), * does not', () => {
  assert.ok(globToRegExp('**').test('README.md'))
  assert.ok(globToRegExp('template/**').test('template/migrations.json'))
  assert.ok(globToRegExp('template/**').test('template/base/apps/mobile/src/App.tsx'))
  assert.ok(!globToRegExp('template/**').test('installer/cli.mjs'))
  assert.ok(!globToRegExp('template/**').test('template')) // the dir itself is not a file under it
  assert.ok(globToRegExp('template/*').test('template/migrations.json'))
  assert.ok(!globToRegExp('template/*').test('template/base/gitignore'))
  assert.ok(globToRegExp('*.png').test('icon.png'))
  assert.ok(!globToRegExp('*.png').test('icons/icon.png'))
})

test('regex metacharacters in paths stay literal; unpinned glob chars throw', () => {
  assert.ok(globToRegExp('a+b/c.d/**').test('a+b/c.d/e'))
  assert.ok(!globToRegExp('a.b').test('axb'))
  assert.throws(() => globToRegExp('template/[ab]/**'), /outside the pinned subset/)
  assert.throws(() => globToRegExp('file?.txt'), /outside the pinned subset/)
})

test('latest match wins — reuse-tool find_annotations_item semantics', () => {
  const { annotations } = parsedValid()
  assert.equal(coveringAnnotation('installer/cli.mjs', annotations).license, 'Apache-2.0')
  assert.equal(coveringAnnotation('template/base/package.json.tmpl', annotations).license, 'Apache-2.0 OR 0BSD')
  assert.equal(coveringAnnotation('anything', []), null)
  // Order flipped ⇒ the catch-all (now last) would swallow template/** too.
  const flipped = [...annotations].reverse()
  assert.equal(coveringAnnotation('template/base/package.json.tmpl', flipped).license, 'Apache-2.0')
})

test('spec-ignored paths: LICENSE*/COPYING*, LICENSES/, REUSE.toml, *.license — and nothing more', () => {
  for (const p of ['LICENSE', 'LICENSE.md', 'COPYING', 'LICENSES/Apache-2.0.txt', 'REUSE.toml', 'assets/icon.png.license']) {
    assert.ok(specIgnored(p), p)
  }
  for (const p of ['.gitignore', '.gitattributes', 'docs/LICENSE-history.md', 'template/base/gitignore', 'licenses.md']) {
    assert.ok(!specIgnored(p), p)
  }
})

test('license expressions: OR-joined ids split; AND/WITH/parens are outside the pin', () => {
  assert.deepEqual(licenseIdsFromExpression('Apache-2.0'), ['Apache-2.0'])
  assert.deepEqual(licenseIdsFromExpression('Apache-2.0 OR 0BSD'), ['Apache-2.0', '0BSD'])
  assert.throws(() => licenseIdsFromExpression('Apache-2.0 AND 0BSD'), /outside the pinned subset/)
  assert.throws(() => licenseIdsFromExpression('(Apache-2.0 OR 0BSD)'), /outside the pinned subset/)
})

// --- structural problems: each reuse-lint failure class has a red here -------

const HAPPY = {
  reuse: parsedValid(),
  trackedPaths: ['README.md', 'installer/cli.mjs', 'template/base/gitignore', 'LICENSE', 'REUSE.toml', 'LICENSES/Apache-2.0.txt'],
  licenseFiles: ['Apache-2.0.txt', '0BSD.txt'],
  readme: 'Apache-2.0; everything under `template/**` is dual-licensed `Apache-2.0 OR 0BSD`.',
  citation: 'cff-version: 1.2.0\nlicense: Apache-2.0\nversion: 0.1.0\n',
  packageJson: { license: 'Apache-2.0' },
}

test('the happy shape yields zero problems', () => {
  assert.deepEqual(reuseProblems(HAPPY), [])
})

test('an uncovered tracked file is a problem; spec-ignored paths never are', () => {
  const reuse = { version: 1, annotations: [parsedValid().annotations[1]] } // template/** only
  const problems = reuseProblems({ ...HAPPY, reuse, trackedPaths: ['installer/cli.mjs', 'LICENSE', 'template/x.ts'] })
  assert.deepEqual(
    problems.filter((p) => p.includes('covered by no')),
    ['installer/cli.mjs is covered by no REUSE.toml annotation'],
  )
})

test('missing LICENSES text, unused LICENSES text, and unknown ids each red', () => {
  const missing = reuseProblems({ ...HAPPY, licenseFiles: ['Apache-2.0.txt'] })
  assert.ok(missing.some((p) => p.includes('LICENSES/0BSD.txt is missing')))

  const unused = reuseProblems({ ...HAPPY, licenseFiles: ['Apache-2.0.txt', '0BSD.txt', 'MIT.txt'] })
  assert.ok(unused.some((p) => p.includes('LICENSES/MIT.txt is not referenced')))

  const unknown = reuseProblems({
    ...HAPPY,
    reuse: parseReuseToml(VALID.replace('"Apache-2.0"\n', '"Apache-3.0"\n')),
  })
  assert.ok(unknown.some((p) => p.includes('"Apache-3.0" is not on KNOWN_LICENSE_IDS')))
})

test('license-consistency: README, CITATION.cff, and package.json each anchor to REUSE.toml', () => {
  const noDual = reuseProblems({ ...HAPPY, readme: 'Apache-2.0 only, no template split mentioned.' })
  assert.ok(noDual.some((p) => p.includes('README License section does not state `template/**` as "Apache-2.0 OR 0BSD"')))

  const badCff = reuseProblems({ ...HAPPY, citation: 'license: 0BSD\n' })
  assert.ok(badCff.some((p) => p.includes('CITATION.cff license "0BSD" != repo-wide')))
  const noCff = reuseProblems({ ...HAPPY, citation: 'cff-version: 1.2.0\n' })
  assert.ok(noCff.some((p) => p.includes('CITATION.cff license "(absent)"')))

  const badPkg = reuseProblems({ ...HAPPY, packageJson: { license: 'MIT' } })
  assert.ok(badPkg.some((p) => p.includes('package.json license "MIT" != repo-wide')))
})

test('consistency cannot silently detach: losing the template or repo anchor is itself a problem', () => {
  const problems = reuseProblems({ ...HAPPY, reuse: { version: 1, annotations: [parsedValid().annotations[1]] }, trackedPaths: [] })
  assert.ok(problems.some((p) => p.includes('consistency checks cannot anchor')))
})

test('GREEN: the CLI wrapper over the real repo tree is OK', () => {
  // The wrapper hardcodes the repo root (git ls-files + LICENSES/ + README +
  // CITATION.cff + package.json), so this is the live mirror end-to-end.
  const script = fileURLToPath(new URL('../../scripts/check-reuse.mjs', import.meta.url))
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  delete env.GITHUB_BASE_REF
  const r = spawnSync('node', [script], { encoding: 'utf8', env })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  assert.equal(r.status, 0, out)
  assert.match(out, /REUSE: OK/, out)
})
