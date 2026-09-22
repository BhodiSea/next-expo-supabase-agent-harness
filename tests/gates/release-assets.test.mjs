// THE PROVENANCE HAS TO REACH THE RELEASE PAGE, NOT ONLY THE ATTESTATION STORE (1.0.3).
//
// `actions/attest-build-provenance` does two things: it files the attestation in GitHub's
// attestation store, and it writes the signed bundle to a path on the runner. Uploading only
// the tarball left that bundle on the runner. Verification still worked — `gh attestation
// verify` queries the store — but a verifier holding a mirror of the release assets had
// nothing local to check against, and OpenSSF Scorecard's Signed-Releases check, which reads
// ASSETS and not the store, scored this repository 0 on 2026-09-22 while every 1.0.x release
// was in fact attested. A number that low on a repository whose README claims provenance is
// the kind of contradiction this tree exists to prevent.
//
// The property is a THREE-LINK CHAIN and each link is separately deletable:
//   1. the attest step carries an `id`, or nothing downstream can name its output;
//   2. a later step copies the bundle THAT id names to a `.intoto.jsonl` path;
//   3. `gh release create` uploads that path alongside the tarball.
// Asserting only link 3 passes a workflow that uploads a file nothing ever wrote, and
// asserting only link 1 passes one that signs and then discards. So all three are asserted,
// and the synthetic negatives below delete them one at a time.
//
// YAML-shaped, never YAML-parsed, like every other workflow check in this directory: no
// parser dependency, and the assertion reads the same text a reviewer reads in the diff.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const RELEASE_YML = fileURLToPath(new URL('../../.github/workflows/release.yml', import.meta.url))
const RELEASE = readFileSync(RELEASE_YML, 'utf8')

/** Link 1: the id the attest step answers to, or null when it carries none. */
function attestId(text) {
  const m = /uses:\s*actions\/attest-build-provenance@[^\n]*\n\s*id:\s*(\S+)/.exec(text)
  return m === null ? null : m[1]
}

/** Link 2: a step reads THAT id's bundle-path and lands it on a `.intoto.jsonl` name. */
function copiesBundle(text, id) {
  if (id === null) return false
  return (
    new RegExp(`steps\\.${id}\\.outputs\\.bundle-path`).test(text) &&
    /\.intoto\.jsonl/.test(text)
  )
}

/** Link 3: the assets named on the `gh release create` line, in order. */
function releaseAssets(text) {
  const m = /gh release create\s+"\$GITHUB_REF_NAME"([^\n]*)/.exec(text)
  if (m === null) return []
  return m[1].split(/\s+/).filter((a) => a !== '' && a !== '\\')
}

test('the attest step is addressable, so a later step can name the bundle it wrote', () => {
  assert.notEqual(attestId(RELEASE), null, 'attest-build-provenance carries no `id:`')
})

test('the bundle the attest step wrote is copied to a name Signed-Releases recognises', () => {
  assert.ok(
    copiesBundle(RELEASE, attestId(RELEASE)),
    'no step copies ${{ steps.<attest>.outputs.bundle-path }} to a .intoto.jsonl path',
  )
})

test('the release uploads the tarball AND that bundle beside it', () => {
  const assets = releaseAssets(RELEASE)
  assert.ok(assets.includes('./*.tgz'), `the tarball is not uploaded: ${assets.join(' ')}`)
  assert.ok(
    assets.some((a) => a.endsWith('.intoto.jsonl')),
    `no provenance bundle among the release assets: ${assets.join(' ')}`,
  )
})

test('each link can go red: the synthetic negatives', () => {
  // 1. The id deleted. The step still signs; nothing can refer to what it produced.
  const noId = RELEASE.replace(/(uses:\s*actions\/attest-build-provenance@[^\n]*\n)\s*id:\s*\S+\n/, '$1')
  assert.equal(attestId(noId), null, 'deleting the id did not falsify link 1')
  assert.equal(copiesBundle(noId, attestId(noId)), false, 'link 2 passed with no id to name')

  // 2. The copy deleted. The create line still names a bundle — one nothing wrote.
  const noCopy = RELEASE.replace(/\s*- name: Carry the provenance bundle[\s\S]*?intoto\.jsonl"\n/, '\n')
  assert.equal(copiesBundle(noCopy, attestId(noCopy)), false, 'deleting the copy step did not falsify link 2')

  // 3. The asset dropped from the upload. Signed and copied, then left on the runner —
  //    the exact shape that scored 0, and the one a routine edit to this line reintroduces.
  const noUpload = RELEASE.replace(/ \.\/\*\.tgz\.intoto\.jsonl/, '')
  const assets = releaseAssets(noUpload)
  assert.ok(assets.includes('./*.tgz'), 'the negative removed the wrong asset')
  assert.equal(
    assets.some((a) => a.endsWith('.intoto.jsonl')),
    false,
    'dropping the bundle from `gh release create` did not falsify link 3',
  )
})
