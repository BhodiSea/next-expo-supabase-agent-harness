// THE FACTORY GATE'S OWN RED-PROOF (0.7.0) — check-corpus-fidelity had zero test
// references: the factory-gate class the 0.6.0 changelog names for `hygiene` (no
// canary-registry entry — that registry closes over the shipped chain and the Stop chain,
// and these scripts ship to nobody), so the gate could spend releases with no watched
// failure.
//
// SCOPE, declared: this suite proves the OFFLINE half only — a repo-relative `url` must
// name a file that exists, and a missing `url` is a broken citation either way. The
// http(s) half is NETWORK-DEPENDENT by the gate's own header and stays nightly-only (the
// hygiene.yml corpus-fidelity job is its home); every fixture here carries zero http(s)
// urls, and the green control pins "0 live URL(s)" so a fixture that accidentally grew a
// live url — and with it a network dependency — reds this suite rather than flaking it.
// The [corpus-path] positional is the seam: with it, repo-relative urls ground beside the
// fixture corpus, which is what makes the offline half falsifiable without network.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../../scripts/check-corpus-fidelity.mjs', import.meta.url))

// The lane-env doctrine: the local suite runs CI-shaped, so scrub the vars a leaked
// environment could steer a spawned gate with, even where the gate reads none today.
function cleanEnv() {
  const env = { ...process.env }
  for (const k of ['CI', 'HARNESS_REQUIRE_TOOLCHAINS', 'HARNESS_ALLOW_SELF_EDIT', 'GITHUB_BASE_REF']) {
    delete env[k]
  }
  return env
}

/** @param {Record<string, string>} files @returns {string} the fixture root */
function writeTree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'nsah-corpus-'))
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  return dir
}

function run(corpusPath) {
  const r = spawnSync(process.execPath, [SCRIPT, corpusPath], {
    encoding: 'utf8',
    env: cleanEnv(),
  })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

test('RED: a repo-relative url naming no file, and an entry with no url — both are broken citations', () => {
  const dir = writeTree({
    'corpus.json': JSON.stringify([
      { id: 'fx/good', url: 'docs/note.md' },
      { id: 'fx/dead', url: 'docs/gone.md' },
      { id: 'fx/nourl', title: 'an authority cited by nothing' },
    ]),
    'docs/note.md': '# an authority that exists\n',
  })
  const { code, out } = run(join(dir, 'corpus.json'))
  assert.equal(code, 1, `a corpus citing a missing authority must red:\n${out}`)
  assert.match(out, /CORPUS FIDELITY: 2 problem\(s\):/)
  assert.match(out, /corpus entry fx\/dead: repo-relative url "docs\/gone\.md" names no file that exists/)
  assert.match(out, /corpus entry fx\/nourl: missing url/)
  assert.ok(!out.includes('fx/good'), `an entry whose authority exists must not be named:\n${out}`)
})

test('GREEN: every citation grounds, and the counts prove the fixture (not the real corpus, not the network) was judged', () => {
  const dir = writeTree({
    'corpus.json': JSON.stringify([
      { id: 'fx/one', url: 'docs/one.md' },
      { id: 'fx/two', url: 'guides/two.md' },
    ]),
    'docs/one.md': 'one\n',
    'guides/two.md': 'two\n',
  })
  const { code, out } = run(join(dir, 'corpus.json'))
  assert.equal(code, 0, out)
  // "2 entries" proves the [corpus-path] positional was honoured (the shipped corpus is far
  // larger); "0 live URL(s)" proves the offline half ran offline — no fetch ever happened.
  assert.match(out, /CORPUS FIDELITY: CLEAN \(2 entries — 0 live URL\(s\) resolve, 2 repo-relative authority file\(s\) exist\)/)
})
