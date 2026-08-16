// THE FACTORY GATE'S OWN RED-PROOF (0.7.0) — check-release-lockstep had zero test
// references. The class is the one the 0.6.0 changelog states for `hygiene`: factory-gate
// steps carry no canary-registry entry — that registry closes over the shipped chain and
// the Stop chain, and these scripts ship to nobody — so a factory gate can spend releases
// as a gate whose failure nobody has watched.
//
// The gate asserts ONE version everywhere: package.json == plugin.json == every
// HARNESS_HOOK_VERSION stamp == CITATION.cff == the CHANGELOG section == GITHUB_REF_NAME
// (only on a v* tag). Every one of those comparisons is watched failing here, against a
// skewed mini-tree via the gate's [repo-root] positional (the convention
// check-plugin-manifest.mjs documents). The green control is a CLEAN FIXTURE, deliberately
// not the live repo: mid-release a work branch is allowed to sit between versions, and a
// control that reds on somebody else's in-flight bump is a control people stop running.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../../scripts/check-release-lockstep.mjs', import.meta.url))

// The lane-env doctrine, plus GITHUB_REF_NAME: the gate reads it, Actions always sets it
// (branch name on pushes, tag name on tag builds), and a verdict that inherits the
// runner's ref is a verdict about the checkout rather than about the fixture. Cases that
// are ABOUT the tag comparison set it explicitly.
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  for (const k of [
    'CI',
    'HARNESS_REQUIRE_TOOLCHAINS',
    'HARNESS_ALLOW_SELF_EDIT',
    'GITHUB_BASE_REF',
    'GITHUB_REF_NAME',
  ]) {
    if (!(k in extra)) delete env[k]
  }
  return env
}

/** @param {Record<string, string>} files @returns {string} the fixture root */
function writeTree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'nsah-lockstep-'))
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  return dir
}

// One version everywhere — the state the gate promises to hold the repo in.
const clean = () => ({
  'package.json': JSON.stringify({ version: '1.2.3' }),
  '.claude-plugin/plugin.json': JSON.stringify({ version: '1.2.3' }),
  'template/base/.claude/hooks/alpha.mjs':
    "const HARNESS_HOOK_VERSION = '1.2.3'\nexport default HARNESS_HOOK_VERSION\n",
  'template/base/.claude/hooks/beta.mjs':
    "const HARNESS_HOOK_VERSION = '1.2.3'\nexport default HARNESS_HOOK_VERSION\n",
  'CITATION.cff': "title: fixture\nversion: 1.2.3\ndate-released: '2026-08-08'\n",
  'CHANGELOG.md': '# Changelog\n\n## [1.2.3] - 2026-08-08\n\n- everything in lockstep\n',
})

function run(dir, envExtra = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, dir], {
    encoding: 'utf8',
    env: cleanEnv(envExtra),
  })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

test('GREEN: a fixture in lockstep is OK, and the summary names the fixture version', () => {
  const { code, out } = run(writeTree(clean()))
  // The version in the summary is the proof the [repo-root] positional was honoured:
  // without it the gate reads THIS repo and prints this repo's version instead.
  assert.equal(code, 0, out)
  assert.match(out, /release lockstep: OK \(v1\.2\.3 everywhere\)/)
})

test('GREEN: a matching v* tag ref is part of the lockstep, not a special case', () => {
  const { code, out } = run(writeTree(clean()), { GITHUB_REF_NAME: 'v1.2.3' })
  assert.equal(code, 0, out)
})

test('RED: every comparison the gate makes, watched failing at once and each named', () => {
  const dir = writeTree({
    ...clean(),
    // Five skews, one per surface the gate reads. beta.mjs loses its stamp entirely —
    // "no stamp" and "stale stamp" are different findings and both must fire.
    '.claude-plugin/plugin.json': JSON.stringify({ version: '9.9.9' }),
    'template/base/.claude/hooks/alpha.mjs':
      "const HARNESS_HOOK_VERSION = '1.2.2'\nexport default HARNESS_HOOK_VERSION\n",
    'template/base/.claude/hooks/beta.mjs': 'export default 1\n',
    'CITATION.cff': 'title: fixture\nversion: 1.2.2\n',
    'CHANGELOG.md': '# Changelog\n\n## [1.2.2] - 2026-08-01\n\n- a release behind\n',
  })
  const { code, out } = run(dir, { GITHUB_REF_NAME: 'v9.9.9' })
  assert.equal(code, 1, `a fully skewed tree must red:\n${out}`)
  assert.match(out, /release lockstep FAILED:/)
  assert.match(out, /\.claude-plugin\/plugin\.json version 9\.9\.9 != package\.json 1\.2\.3/)
  assert.match(out, /hooks\/alpha\.mjs stamp 1\.2\.2 != package\.json 1\.2\.3/)
  assert.match(out, /hooks\/beta\.mjs carries no HARNESS_HOOK_VERSION stamp/)
  assert.match(out, /git tag v9\.9\.9 != package\.json 1\.2\.3/)
  assert.match(out, /CITATION\.cff carries no "version: 1\.2\.3"/)
  assert.match(out, /CHANGELOG\.md has no "## \[1\.2\.3\]" section/)
})

test('RED: one hook stamp a release behind is enough — the doctor diagnosis this protects', () => {
  // The gate's own header: doctor tells "stale hook from an older harness" from "locally
  // modified" by these stamps, so a single skewed stamp breaks that diagnosis everywhere.
  const dir = writeTree({
    ...clean(),
    'template/base/.claude/hooks/beta.mjs':
      "const HARNESS_HOOK_VERSION = '1.2.2'\nexport default HARNESS_HOOK_VERSION\n",
  })
  const { code, out } = run(dir)
  assert.equal(code, 1, out)
  assert.match(out, /hooks\/beta\.mjs stamp 1\.2\.2 != package\.json 1\.2\.3/)
  assert.ok(!out.includes('hooks/alpha.mjs'), `only the skewed hook is named:\n${out}`)
})

test('RED (1.0.0): the DATE rides the lockstep — a citation date that disagrees with the CHANGELOG heading is named', () => {
  const dir = writeTree({
    ...clean(),
    'CITATION.cff': "title: fixture\nversion: 1.2.3\ndate-released: '2026-08-09'\n",
  })
  const { code, out } = run(dir)
  assert.equal(code, 1, `a drifted date must red:\n${out}`)
  assert.match(
    out,
    /CITATION\.cff date-released 2026-08-09 != CHANGELOG\.md "## \[1\.2\.3\] — 2026-08-08"/,
  )
  // And a citation with no date at all is its own finding, not a silent pass.
  const undated = run(
    writeTree({
      ...clean(),
      'CITATION.cff': 'title: fixture\nversion: 1.2.3\n',
    }),
  )
  assert.equal(undated.code, 1)
  assert.match(undated.out, /CITATION\.cff carries no date-released/)
  // The em-dash heading form the real CHANGELOG uses is read the same as the hyphen form.
  const emdash = run(
    writeTree({
      ...clean(),
      'CHANGELOG.md': '# Changelog\n\n## [1.2.3] — 2026-08-08\n\n- everything in lockstep\n',
    }),
  )
  assert.equal(emdash.code, 0, emdash.out)
})
