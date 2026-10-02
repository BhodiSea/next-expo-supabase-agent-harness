// In-process proofs for tools/lib/corpus.mjs (1.0.4), the one reader of the citation
// corpus. The provenance gate, docs-sync and the corpus_search MCP server all read the
// owned upstream index (tools/mcp/corpus/index.json) and the optional seeded project
// corpus (tools/mcp/corpus/project.json) through it.
//
// In-process on purpose: only tests/gates/*.test.mjs count toward the
// template/base/tools/lib/** coverage floor in selftest.yml, and the gates that call the
// helper run as child processes, which line coverage cannot see. The server imports
// @modelcontextprotocol/sdk, which resolves only inside a scaffold, so the helper is what
// is tested here, not the server. No bash and no git: installer-unit runs this file on
// windows-latest too.
// SOURCE: template/base/tools/lib/corpus.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  PROJECT_CORPUS,
  UPSTREAM_CORPUS,
  corpusById,
  loadCorpus,
} from '../../template/base/tools/lib/corpus.mjs'

const TEMPLATE = fileURLToPath(new URL('../../template/base/', import.meta.url))
const HELPER = fileURLToPath(new URL('../../template/base/tools/lib/corpus.mjs', import.meta.url))
const SHIPPED_INDEX = JSON.parse(readFileSync(join(TEMPLATE, UPSTREAM_CORPUS), 'utf8'))
// Every decision-group key a scaffold rendered from this template knows: the built-in
// groups of tools/lib/provenance-rules.mjs plus the seeded tools/decision-groups.json.
// Read from provenance-rules.mjs itself, so a group added there cannot drift past this
// suite, but in a CHILD process: that module resolves tools/decision-groups.json against
// CLAUDE_PROJECT_DIR or the cwd at import time, so the child runs from the template with
// both pointing at it, and this suite does not depend on where it runs.
const RULES = fileURLToPath(
  new URL('../../template/base/tools/lib/provenance-rules.mjs', import.meta.url),
)
const groupKeysRun = spawnSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `const m = await import(${JSON.stringify(pathToFileURL(RULES).href)})\nprocess.stdout.write(JSON.stringify(m.DECISION_GROUPS.map((g) => g.key)))`,
  ],
  { cwd: TEMPLATE, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: TEMPLATE } },
)
assert.equal(groupKeysRun.status, 0, `${groupKeysRun.stdout ?? ''}${groupKeysRun.stderr ?? ''}`)
/** @type {string[]} */
const GROUP_KEYS = JSON.parse(groupKeysRun.stdout)

const sha = (/** @type {string} */ text) => createHash('sha256').update(text, 'utf8').digest('hex')

/** @param {Record<string, unknown>} overrides */
function entry(overrides = {}) {
  const text = typeof overrides.text === 'string' ? overrides.text : 'A pinned authority.'
  return {
    id: 'project/authority',
    title: 'Fixture authority',
    url: 'https://example.com/authority',
    version: '1',
    text,
    sha256: sha(text),
    groups: ['token-verification'],
    ...overrides,
  }
}

/**
 * A root holding the given files (strings are written verbatim, anything else as JSON).
 * @param {Record<string, unknown>} files
 */
function root(files) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-corpus-'))
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), typeof content === 'string' ? content : JSON.stringify(content))
  }
  return dir
}

const upstreamOnly = [entry({ id: 'upstream/a', groups: ['rls-policy'] })]
const project = (/** @type {unknown[]} */ entries, extra = {}) => ({
  comment: 'fixture',
  entries,
  ...extra,
})

// ── the shipped files ────────────────────────────────────────────────────────
test('the shipped corpus loads clean: no problems, every entry tagged with index.json, every group covered', () => {
  const r = loadCorpus({ root: TEMPLATE, groupKeys: GROUP_KEYS })
  assert.deepEqual(r.problems, [])
  assert.equal(r.upstream, 'ok')
  assert.equal(r.project, 'ok')
  assert.equal(r.entries.length, SHIPPED_INDEX.length)
  assert.ok(r.entries.every((e) => e.file === UPSTREAM_CORPUS))
  assert.deepEqual([...r.coveredGroups].sort(), [...GROUP_KEYS].sort())
})

test('no shipped upstream id starts with project/ — that prefix is left to projects', () => {
  const clashing = SHIPPED_INDEX.map((/** @type {{ id: string }} */ e) => e.id).filter(
    (/** @type {string} */ id) => id.startsWith('project/'),
  )
  assert.deepEqual(clashing, [])
})

test('the seeded project.json is { comment, entries: [] } and pins no concrete corpus reference', () => {
  const raw = readFileSync(join(TEMPLATE, PROJECT_CORPUS), 'utf8')
  const seeded = JSON.parse(raw)
  assert.deepEqual(Object.keys(seeded).sort(), ['comment', 'entries'])
  assert.equal(typeof seeded.comment, 'string')
  assert.deepEqual(seeded.entries, [])
  // The provenance gate resolves every `[corpus: …]` in the tracked tree; a concrete id
  // in the seeded comment would red every scaffold.
  assert.doesNotMatch(raw, /\[corpus:\s*[A-Za-z0-9]/)
})

// ── absence and merging ──────────────────────────────────────────────────────
test('an absent project.json counts as empty', () => {
  const r = loadCorpus({ root: root({ [UPSTREAM_CORPUS]: upstreamOnly }), groupKeys: GROUP_KEYS })
  assert.equal(r.project, 'absent')
  assert.deepEqual(r.problems, [])
  assert.deepEqual(
    r.entries.map((e) => [e.id, e.file]),
    [['upstream/a', UPSTREAM_CORPUS]],
  )
})

test('project entries follow the upstream ones, tagged with project.json, and cover their groups', () => {
  const r = loadCorpus({
    root: root({
      [UPSTREAM_CORPUS]: upstreamOnly,
      [PROJECT_CORPUS]: project([entry({ groups: ['mobile-security'] })]),
    }),
    groupKeys: GROUP_KEYS,
  })
  assert.deepEqual(r.problems, [])
  assert.deepEqual(
    r.entries.map((e) => [e.id, e.file]),
    [
      ['upstream/a', UPSTREAM_CORPUS],
      ['project/authority', PROJECT_CORPUS],
    ],
  )
  assert.equal(r.entries[1].entry.url, 'https://example.com/authority')
  assert.ok(r.coveredGroups.has('mobile-security'))
})

test('without groupKeys nothing is linted, and an entry that would fail the lint is still returned', () => {
  // docs-sync and the server take ids only; the lint is the provenance gate's subject.
  const r = loadCorpus({
    root: root({
      [UPSTREAM_CORPUS]: [{ id: 'upstream/bare' }],
      [PROJECT_CORPUS]: project([{ id: 'project/bare' }, { title: 'no id' }]),
    }),
  })
  assert.deepEqual(r.problems, [])
  assert.deepEqual(
    r.entries.map((e) => e.id),
    ['upstream/bare', 'project/bare'],
  )
  assert.equal(r.coveredGroups.size, 0)
})

// ── the per-entry lint, the same rules on both files ─────────────────────────
test('the lint runs on project entries, and every message names project.json', () => {
  const noGroups = entry({ id: 'project/no-groups' })
  delete noGroups.groups
  const r = loadCorpus({
    root: root({
      [UPSTREAM_CORPUS]: upstreamOnly,
      [PROJECT_CORPUS]: project([
        { title: 'no id at all' },
        entry({ id: 'project/no-title', title: ' ' }),
        entry({ id: 'project/no-text', text: '' }),
        entry({ id: 'project/tampered', sha256: '0'.repeat(64) }),
        noGroups,
        entry({ id: 'project/odd-group', groups: ['not-a-group'] }),
      ]),
    }),
    groupKeys: GROUP_KEYS,
  })
  const expected = [
    `${PROJECT_CORPUS}: entry with missing/empty id: {"title":"no id at all"}`,
    `${PROJECT_CORPUS}: corpus entry project/no-title: missing/empty title`,
    `${PROJECT_CORPUS}: corpus entry project/no-text: missing/empty text`,
    `${PROJECT_CORPUS}: corpus entry project/tampered text/hash mismatch`,
    `${PROJECT_CORPUS}: corpus entry project/no-groups: missing/invalid \`groups\``,
    `${PROJECT_CORPUS}: corpus entry project/odd-group: unknown decision group "not-a-group"`,
  ]
  for (const want of expected) {
    assert.ok(
      r.problems.some((p) => p.startsWith(want)),
      `${want}\n  in: ${r.problems.join('\n  ')}`,
    )
  }
  assert.equal(r.problems.length, expected.length, r.problems.join('\n'))
  // Every entry with an id comes back, lint failures included.
  assert.deepEqual(
    r.entries.map((e) => e.id),
    [
      'upstream/a',
      'project/no-title',
      'project/no-text',
      'project/tampered',
      'project/no-groups',
      'project/odd-group',
    ],
  )
  // Coverage follows the unchanged rules: an entry with no text is skipped before its
  // groups are read, a known group covers even beside a title or hash red (each is its own
  // red), and a missing or unknown group covers nothing.
  assert.deepEqual([...r.coveredGroups].sort(), ['rls-policy', 'token-verification'])
})

test('the same lint judges upstream entries, naming index.json', () => {
  const r = loadCorpus({
    root: root({ [UPSTREAM_CORPUS]: [entry({ id: 'upstream/tampered', sha256: 'x' })] }),
    groupKeys: GROUP_KEYS,
  })
  assert.deepEqual(r.problems, [
    `${UPSTREAM_CORPUS}: corpus entry upstream/tampered text/hash mismatch — the corpus is tamper-evident data`,
  ])
})

// ── the project file's shape: each red names project.json, and fails closed ─
for (const [label, content, want] of [
  ['invalid JSON', 'not json {', `${PROJECT_CORPUS}: invalid JSON (`],
  ['an array top level', [entry()], `${PROJECT_CORPUS}: expected { comment: string, entries: array }`],
  ['a null top level', 'null', `${PROJECT_CORPUS}: expected { comment: string, entries: array }`],
  [
    'a missing comment',
    { entries: [] },
    `${PROJECT_CORPUS}: expected { comment: string, entries: array }`,
  ],
  ['a non-array entries', { comment: 'x', entries: {} }, `${PROJECT_CORPUS}: \`entries\` is not an array`],
  [
    'an unknown top-level key',
    project([entry()], { groups: [] }),
    `${PROJECT_CORPUS}: unknown top-level key "groups"`,
  ],
]) {
  test(`a project.json with ${String(label)} is malformed: one red naming project.json, and none of its entries load`, () => {
    const r = loadCorpus({
      root: root({ [UPSTREAM_CORPUS]: upstreamOnly, [PROJECT_CORPUS]: content }),
      groupKeys: GROUP_KEYS,
    })
    assert.equal(r.project, 'malformed')
    assert.equal(r.problems.length, 1, r.problems.join('\n'))
    assert.ok(r.problems[0].startsWith(String(want)), r.problems[0])
    assert.deepEqual(
      r.entries.map((e) => e.file),
      [UPSTREAM_CORPUS],
    )
  })
}

// ── collisions: a project adds authorities, never replaces one ───────────────
test('a project id equal to an upstream id reds naming both files; the upstream entry wins', () => {
  const r = loadCorpus({
    root: root({
      [UPSTREAM_CORPUS]: [entry({ id: 'shared/id', groups: ['llm-sampling'] })],
      [PROJECT_CORPUS]: project([entry({ id: 'shared/id', groups: ['token-verification'] })]),
    }),
    groupKeys: GROUP_KEYS,
  })
  assert.equal(r.problems.length, 1, r.problems.join('\n'))
  assert.ok(
    r.problems[0].startsWith(
      `${PROJECT_CORPUS}: corpus id "shared/id" is already pinned in ${UPSTREAM_CORPUS}`,
    ),
    r.problems[0],
  )
  // Both come back tagged; corpusById keeps the first, which is always the upstream one.
  assert.deepEqual(
    r.entries.map((e) => e.file),
    [UPSTREAM_CORPUS, PROJECT_CORPUS],
  )
  const byId = corpusById(r.entries)
  assert.equal(byId.size, 1)
  assert.equal(byId.get('shared/id')?.file, UPSTREAM_CORPUS)
  // The rejected copy covers nothing: a colliding project entry cannot widen coverage.
  assert.deepEqual([...r.coveredGroups], ['llm-sampling'])
})

// ── the upstream index stays mandatory ───────────────────────────────────────
test('a missing upstream index is a red naming index.json, and the project file still loads', () => {
  const r = loadCorpus({
    root: root({ [PROJECT_CORPUS]: project([entry()]) }),
    groupKeys: GROUP_KEYS,
  })
  assert.equal(r.upstream, 'missing')
  assert.deepEqual(r.problems, [
    `${UPSTREAM_CORPUS}: missing — the pinned corpus is part of the provenance surface`,
  ])
  assert.deepEqual(
    r.entries.map((e) => e.file),
    [PROJECT_CORPUS],
  )
})

test('an upstream index that is not JSON, or not an array, is malformed and names index.json', () => {
  const bad = loadCorpus({ root: root({ [UPSTREAM_CORPUS]: '{ nope' }) })
  assert.equal(bad.upstream, 'malformed')
  assert.ok(bad.problems[0].startsWith(`${UPSTREAM_CORPUS}: invalid JSON (`), bad.problems[0])

  const obj = loadCorpus({ root: root({ [UPSTREAM_CORPUS]: { entries: [] } }) })
  assert.equal(obj.upstream, 'malformed')
  assert.deepEqual(obj.problems, [`${UPSTREAM_CORPUS}: expected an ARRAY of entries`])
  assert.deepEqual(obj.entries, [])
})

test('upstreamPath overrides the upstream index only, and its messages name that path', () => {
  const elsewhere = root({ 'other/index.json': [entry({ id: 'override/a' })] })
  const overridePath = join(elsewhere, 'other/index.json')
  const dir = root({
    [UPSTREAM_CORPUS]: upstreamOnly,
    [PROJECT_CORPUS]: project([entry({ id: 'override/a' })]),
  })
  const r = loadCorpus({ root: dir, upstreamPath: overridePath, groupKeys: GROUP_KEYS })
  assert.deepEqual(
    r.entries.map((e) => [e.id, e.file]),
    [
      ['override/a', overridePath],
      ['override/a', PROJECT_CORPUS],
    ],
  )
  assert.ok(r.problems[0].includes(`already pinned in ${overridePath}`), r.problems[0])

  const missing = loadCorpus({ root: dir, upstreamPath: join(elsewhere, 'absent.json') })
  assert.equal(missing.upstream, 'missing')
  assert.ok(missing.problems[0].startsWith(join(elsewhere, 'absent.json')), missing.problems[0])
})

// ── independence from provenance-rules.mjs ───────────────────────────────────
test('the helper loads in a child process whose cwd and CLAUDE_PROJECT_DIR hold an invalid decision-groups.json', () => {
  // provenance-rules.mjs throws at import on a malformed tools/decision-groups.json. The
  // corpus_search server must keep answering then, so the helper must never import it,
  // nor read the cwd or the environment.
  const broken = root({
    'tools/decision-groups.json': '{ not json',
    [UPSTREAM_CORPUS]: upstreamOnly,
    [PROJECT_CORPUS]: project([entry()]),
  })
  const script = [
    `const m = await import(${JSON.stringify(pathToFileURL(HELPER).href)})`,
    `const r = m.loadCorpus({ root: ${JSON.stringify(broken)} })`,
    'process.stdout.write(JSON.stringify(r.entries.map((e) => e.id)))',
  ].join('\n')
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: broken,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: broken },
  })
  assert.equal(res.status, 0, `${res.stdout ?? ''}${res.stderr ?? ''}`)
  assert.deepEqual(JSON.parse(res.stdout), ['upstream/a', 'project/authority'])
})
