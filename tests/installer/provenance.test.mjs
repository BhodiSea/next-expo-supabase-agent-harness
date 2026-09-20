// PROVENANCE (1.0.2): "the bytes match the manifest" is not "the harness wrote them".
//
// A consumer who forks an OWNED file has to re-record its sha in .harness/manifest.json —
// it is the only way to keep their own `gate-integrity` green — and from then on the fork
// is byte-for-byte indistinguishable from a pristine file to anything that only compares
// the file with the record. These are the pure judgements that tell the two apart: the
// released-sha tables say what a release SHIPPED for a path, and `derender` rebuilds the
// template source from an installed, placeholder-rendered file so the two can be compared
// without shipping a single historical blob.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { walkTemplate } from '../../installer/lib/copy.mjs'
import { fileMode } from '../../installer/lib/manifest.mjs'
import { render, tokenSites } from '../../installer/lib/placeholders.mjs'
import {
  DERIVED_AT_INSTALL,
  classifyProvenance,
  derender,
  explains,
  upstreamUnchanged,
} from '../../installer/lib/provenance.mjs'

/** @param {string | Buffer} text */
const sha = (text) => createHash('sha256').update(text).digest('hex')

const TEMPLATE = fileURLToPath(new URL('../../template/', import.meta.url))

// Every OWNED template file that carries at least one {{TOKEN}} — the population `sites`
// exists for. Derived from the real template, so the round-trip below is a statement about
// the files that actually ship, and the floor keeps it from passing over an empty set.
function ownedPlaceholderSources() {
  const trees = [
    'base',
    ...readdirSync(`${TEMPLATE}modules`)
      .sort()
      .map((m) => `modules/${m}`),
    'stack',
  ]
  const out = []
  for (const tree of trees) {
    for (const entry of walkTemplate(tree)) {
      if (fileMode(entry.installPath) !== 'owned') continue
      const source = readFileSync(entry.sourcePath, 'utf8')
      const sites = tokenSites(source)
      if (sites.length > 0) out.push({ installPath: entry.installPath, source, sites })
    }
  }
  return out
}

const ANSWERS = {
  PROJECT_NAME: 'Fixture App',
  PROJECT_SLUG: 'fixture-app',
  APP_IDENTIFIER: 'com.example.fixture',
  APP_SCHEME: 'fixture',
  WEB_ORIGIN: 'http://127.0.0.1:3000',
  DESIGN_TOKENS: 'default',
  SUPABASE_PROJECT_REF: 'TBD',
  GITHUB_OWNER: 'fixture-owner',
  SECURITY_OWNERS: '@fixture-owner/security',
  SECURITY_TXT_EXPIRES: '2027-03-19',
  DEFAULT_BRANCH: 'main',
  EAS_PROJECT_ID: 'TBD',
  ASC_APP_ID: 'TBD',
  APPLE_TEAM_ID: 'TBD',
}

// Values chosen to break a derender that SEARCHES instead of walking offsets: an empty
// value, a value carrying the token opener, a two-handle owners list, a non-default branch.
const ADVERSARIAL = {
  ...ANSWERS,
  PROJECT_NAME: '',
  GITHUB_OWNER: 'a{{b',
  SECURITY_OWNERS: '@one/sec @two/sec',
  DEFAULT_BRANCH: 'trunk',
  WEB_ORIGIN: 'https://x.example:8443',
}

test('tokenSites: offsets index the SOURCE, in ascending order, by bare token name', () => {
  const source = 'a {{ONE}} b {{TWO}}{{ONE}} c'
  assert.deepEqual(tokenSites(source), [
    [2, 'ONE'],
    [12, 'TWO'],
    [19, 'ONE'],
  ])
  assert.deepEqual(tokenSites('no tokens here'), [])
})

test('derender inverts the real render for EVERY owned placeholder file, over three answer sets', () => {
  const files = ownedPlaceholderSources()
  assert.ok(files.length >= 20, `only ${String(files.length)} owned placeholder file(s) found — the walk is broken`)
  for (const { installPath, source, sites } of files) {
    for (const answers of [ANSWERS, ADVERSARIAL, {}]) {
      const installed = render(source, answers)
      assert.equal(derender(installed, sites, answers), source, `${installPath} did not round-trip`)
    }
  }
})

test('derender walks offsets, never searches: a value equal to the text that FOLLOWS its token still round-trips', () => {
  for (const { installPath, source, sites } of ownedPlaceholderSources()) {
    const [offset, token] = sites[0]
    const after = source.slice(offset + token.length + 4, offset + token.length + 9)
    if (after.length === 0 || after.includes('{')) continue
    const answers = { ...ANSWERS, [token]: after }
    assert.equal(derender(render(source, answers), sites, answers), source, installPath)
  }
})

test('derender accepts the LITERAL token when the answer is absent — or was backfilled after install', () => {
  // SECURITY_TXT_EXPIRES first shipped at 1.0.0 inside owned files: an install upgraded
  // from an older release had no answer to render it with, so the literal is on disk.
  const source = 'Expires: {{SECURITY_TXT_EXPIRES}}T23:59:59.000Z\nowner {{GITHUB_OWNER}}\n'
  const sites = tokenSites(source)
  const installedThen = render(source, { GITHUB_OWNER: 'o' })
  assert.ok(installedThen.includes('{{SECURITY_TXT_EXPIRES}}'))
  assert.equal(derender(installedThen, sites, { GITHUB_OWNER: 'o' }), source)
  assert.equal(derender(installedThen, sites, { GITHUB_OWNER: 'o', SECURITY_TXT_EXPIRES: '2027-01-01' }), source)
})

test('derender returns null — never a guess — when a site does not hold', () => {
  const source = 'branches: [{{DEFAULT_BRANCH}}]\n'
  const sites = tokenSites(source)
  // A hand-edited rendered value: the text at the site is neither the literal nor the answer.
  assert.equal(derender('branches: [develop]\n', sites, { DEFAULT_BRANCH: 'main' }), null)
  // Sites that are not strictly ascending are a corrupt table, not a fork verdict.
  assert.equal(derender('xy', [[1, 'A'], [0, 'B']], {}), null)
  assert.equal(derender('xy', [[0, 'A'], [0, 'A']], {}), null)
  // A site past the end of the installed text.
  assert.equal(derender('short', [[40, 'A']], { A: 'v' }), null)
})

test('derender: an edit OUTSIDE a site survives into the rebuilt text, so the sha moves', () => {
  const source = 'on:\n  push:\n    branches: [{{DEFAULT_BRANCH}}]\njobs: {}\n'
  const sites = tokenSites(source)
  const answers = { DEFAULT_BRANCH: 'main' }
  const forked = render(source, answers).replace('jobs: {}', 'jobs: { mine: {} }')
  const rebuilt = derender(forked, sites, answers)
  assert.notEqual(rebuilt, null)
  assert.notEqual(sha(/** @type {string} */ (rebuilt)), sha(source))
})

test('explains: ANY variant vouches; a rendered file is judged through its sites', () => {
  const source = 'owner: {{GITHUB_OWNER}}\n'
  const installed = render(source, { GITHUB_OWNER: 'acme' })
  const variants = [{ sha256: sha('an older variant of this version\n') }, { sha256: sha(source), sites: tokenSites(source) }]
  assert.equal(
    explains(variants, { recordedSha: sha(installed), current: Buffer.from(installed), answers: { GITHUB_OWNER: 'acme' } }),
    true,
  )
  // Token-free variant: the recorded sha itself is the evidence.
  assert.equal(explains([{ sha256: sha('plain\n') }], { recordedSha: sha('plain\n'), current: null, answers: {} }), true)
  assert.equal(explains([{ sha256: sha('plain\n') }], { recordedSha: sha('forked\n'), current: null, answers: {} }), false)
  // A sites variant with no bytes to derender cannot vouch for anything.
  assert.equal(
    explains([{ sha256: sha(source), sites: tokenSites(source) }], { recordedSha: sha(installed), current: null, answers: {} }),
    false,
  )
})

const TABLES = {
  '1.0.0': {
    'tools/a.mjs': [{ sha256: sha('a@1.0.0') }],
    'tools/gone.mjs': [{ sha256: sha('gone@1.0.0') }],
  },
  '1.0.1': {
    'tools/a.mjs': [{ sha256: sha('a@1.0.1') }, { sha256: sha('a@1.0.1 (a later main commit)') }],
  },
  '1.0.2': {
    'tools/a.mjs': [{ sha256: sha('a@1.0.2') }],
    'tools/b.mjs': [{ sha256: sha('b@1.0.2') }],
  },
}

/** @param {Partial<Parameters<typeof classifyProvenance>[0]>} over */
const judge = (over) =>
  classifyProvenance({
    tables: TABLES,
    fromVersion: '1.0.1',
    toVersion: '1.0.2',
    installPath: 'tools/a.mjs',
    recordedSha: sha('a@1.0.1'),
    current: null,
    answers: {},
    ...over,
  })

test('classifyProvenance — the decision table', () => {
  assert.deepEqual(judge({}), { kind: 'released', version: '1.0.1' })
  assert.deepEqual(judge({ recordedSha: sha('a@1.0.1 (a later main commit)') }), { kind: 'released', version: '1.0.1' })
  // `enable` and `--refresh-seeded` write the RUNNING installer's bytes without advancing
  // harnessVersion: a sha from a release newer than the install is still a released one.
  assert.deepEqual(judge({ fromVersion: '1.0.0', recordedSha: sha('a@1.0.2') }), { kind: 'released', version: '1.0.2' })
  // …but never from a table newer than the installer that is running.
  assert.deepEqual(judge({ fromVersion: '1.0.0', toVersion: '1.0.1', recordedSha: sha('a@1.0.2') }), { kind: 'fork' })
  // A pin back to an older release is a fork — reported as what it IS.
  assert.deepEqual(judge({ recordedSha: sha('a@1.0.0') }), { kind: 'older-release', version: '1.0.0' })
  assert.deepEqual(judge({ recordedSha: sha('a consumer edit') }), { kind: 'fork' })
  // Another path's release sha vouches for nothing here.
  assert.deepEqual(judge({ recordedSha: sha('gone@1.0.0') }), { kind: 'fork' })
})

test('classifyProvenance degrades to UNVERIFIABLE — never to a mass park — when it cannot know', () => {
  // No table for the install's own version (a vintage without one, or a manifest NEWER
  // than the installer).
  assert.deepEqual(judge({ fromVersion: '0.9.0' }), { kind: 'unverifiable' })
  assert.deepEqual(judge({ fromVersion: '9.9.9' }), { kind: 'unverifiable' })
  // A path no table in range knows.
  assert.deepEqual(judge({ installPath: 'tools/never-shipped.mjs', recordedSha: sha('x') }), { kind: 'unverifiable' })
  // A removed file: known at the install's version, absent later — still judged.
  assert.deepEqual(judge({ fromVersion: '1.0.0', installPath: 'tools/gone.mjs', recordedSha: sha('gone@1.0.0') }), {
    kind: 'released',
    version: '1.0.0',
  })
  assert.deepEqual(judge({ fromVersion: '1.0.0', installPath: 'tools/gone.mjs', recordedSha: sha('their edit') }), { kind: 'fork' })
})

test('classifyProvenance: a file whose installed bytes are DERIVED at plan time is never judged', () => {
  assert.ok(DERIVED_AT_INSTALL.has('tsconfig.json'))
  assert.deepEqual(judge({ installPath: 'tsconfig.json', recordedSha: sha('references injected or pruned') }), {
    kind: 'derived',
  })
})

test('upstreamUnchanged: true only when EVERY variant in range is the incoming source', () => {
  const base = { tables: TABLES, fromVersion: '1.0.2', toVersion: '1.0.2', installPath: 'tools/a.mjs' }
  assert.equal(upstreamUnchanged({ ...base, incomingSourceSha: sha('a@1.0.2') }), true)
  assert.equal(upstreamUnchanged({ ...base, incomingSourceSha: sha('a@1.0.3-dev') }), false)
  // Two variants in range: which one the fork was based on is unknowable, so it parks.
  assert.equal(upstreamUnchanged({ ...base, fromVersion: '1.0.1', incomingSourceSha: sha('a@1.0.2') }), false)
  // No variant in range at all proves nothing.
  assert.equal(
    upstreamUnchanged({ ...base, installPath: 'tools/never-shipped.mjs', incomingSourceSha: sha('x') }),
    false,
  )
})
