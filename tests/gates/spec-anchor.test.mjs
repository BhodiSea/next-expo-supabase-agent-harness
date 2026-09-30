// Proofs for the spec-anchor resolver (1.1.0, #63): specs gain `##` headings with stable
// ids, and `node tools/spec-anchor.mjs specs/<feature>.md#<id>` prints one section.
//
// The parsing is pure (template/base/tools/lib/spec-anchor.mjs) and is tested IN-PROCESS,
// so the tools/lib coverage floor sees it. The CLI (template/base/tools/spec-anchor.mjs)
// is spawned with process.execPath against a mkdtempSync fixture that is also its working
// directory, because the resolver only reads `.md` files under `<cwd>/specs/`.
//
// What the template promises is pinned here too: its exact id list, in order and with no
// duplicates, and the prompt edits that cite sections instead of whole files. No reviewer
// gains a tool and no `pnpm` script is added, because package.json is seeded and an
// existing install would never receive one.
// SOURCE: template/base/tools/lib/spec-anchor.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  findSection,
  formatIndex,
  headingId,
  parseHeadings,
  specPath,
} from '../../template/base/tools/lib/spec-anchor.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'template', 'base')
const CLI = join(BASE, 'tools', 'spec-anchor.mjs')
const TEMPLATE = join(BASE, 'specs', '_template.md')

const TEMPLATE_IDS = [
  'spec-feature',
  'summary',
  'why-now',
  'goals',
  'non-goals',
  'files-and-interfaces',
  'security-invariants',
  'contract-impact',
  'decisions',
  'out-of-scope',
  'verification',
]

const made = []
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

/** A throwaway working directory with a specs/ folder, holding `files` (path -> text). */
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'spec-anchor-'))
  made.push(dir)
  mkdirSync(join(dir, 'specs'))
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  return dir
}

/** Run the CLI in `cwd` with `args`; returns { status, stdout, stderr }. */
function run(cwd, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

/** Every file under `dir` with its bytes, so a test can prove nothing was written. */
function snapshot(dir) {
  const out = {}
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const p = join(entry.parentPath, entry.name)
    out[p] = readFileSync(p, 'utf8')
  }
  return out
}

/**
 * The section `id` names in `src`, which must resolve.
 * @param {string} src @param {string} id
 */
function sectionOf(src, id) {
  const s = findSection(src, id)
  if (s.kind !== 'ok') assert.fail(`#${id} did not resolve: ${s.kind}`)
  return s
}

const NESTED = [
  '# Spec: nested',
  '',
  '## Decisions',
  '',
  'Intro to the decisions.',
  '',
  '### Keyset cursor, not offset',
  '',
  'Chosen: keyset.',
  '',
  '### One index serves the sort',
  '',
  'Chosen: the owner index.',
  '',
  '## Out of scope',
  '',
  'Nothing else.',
  '',
].join('\n')

// ---------------------------------------------------------------------------------------
// The template

test('the spec template has exactly the documented ids, in order and with no duplicates', () => {
  const ids = parseHeadings(readFileSync(TEMPLATE, 'utf8')).map((h) => h.id)
  assert.deepEqual(ids, TEMPLATE_IDS)
  assert.equal(new Set(ids).size, ids.length, `duplicate ids in the template: ${ids.join(', ')}`)
})

test('the spec template keeps its comment block and SOURCE line, and says "and", never "&", in a heading', () => {
  const text = readFileSync(TEMPLATE, 'utf8')
  assert.match(text, /<!--[\s\S]*SOURCE: docs\/harness\/README\.md[\s\S]*-->/)
  for (const h of parseHeadings(text)) {
    assert.ok(!h.text.includes('&'), `heading "${h.text}" would slug to a double dash`)
  }
  assert.doesNotMatch(text, /^\*\*[^*]+:?\*\*/m, 'no field is a bold label any more')
})

test('the spec template tells an author to give each decision its own ### heading', () => {
  const section = sectionOf(readFileSync(TEMPLATE, 'utf8'), 'decisions')
  assert.match(section.text, /`###`/)
  assert.match(section.text, /specs\/<feature>\.md#/)
})

// ---------------------------------------------------------------------------------------
// Ids: GitHub's heading-anchor form

test('headingId is GitHub\'s anchor form: lowercase, punctuation dropped, each space a dash', () => {
  assert.equal(headingId('Files and interfaces'), 'files-and-interfaces')
  assert.equal(headingId('Files & interfaces'), 'files--interfaces')
  assert.equal(headingId('Keyset cursor, not offset'), 'keyset-cursor-not-offset')
  assert.equal(headingId('Spec: <feature>'), 'spec-feature')
  assert.equal(headingId('The `notes` table (v2)'), 'the-notes-table-v2')
  assert.equal(headingId('Non-goals'), 'non-goals')
  assert.equal(headingId('snake_case stays'), 'snake_case-stays')
  assert.equal(headingId('Café au lait'), 'café-au-lait')
  assert.equal(headingId('Step 2: ship it!'), 'step-2-ship-it')
  // github-slugger keeps what Unicode marks Alphabetic even inside a symbol category (a
  // circled letter is So), and drops other numbers (No) such as a superscript two.
  assert.equal(headingId('\u24B6 plan x\u00B2'), '\u24D0-plan-x')
})

// ---------------------------------------------------------------------------------------
// Parsing

test('a ## section includes its ### children, up to the next heading of its level', () => {
  const s = sectionOf(NESTED, 'decisions')
  assert.equal(s.heading.line, 3)
  assert.match(s.text, /^## Decisions\n/)
  assert.match(s.text, /### Keyset cursor, not offset/)
  assert.match(s.text, /### One index serves the sort\n\nChosen: the owner index\.\n$/)
  assert.doesNotMatch(s.text, /Out of scope/)
})

test('a ### section stops at the next ### and at the next ##', () => {
  const first = sectionOf(NESTED, 'keyset-cursor-not-offset')
  assert.equal(first.text, '### Keyset cursor, not offset\n\nChosen: keyset.\n')
  const last = sectionOf(NESTED, 'one-index-serves-the-sort')
  assert.equal(last.text, '### One index serves the sort\n\nChosen: the owner index.\n')
})

test('the last section runs to the end of the file, and the H1 section is the whole file', () => {
  assert.equal(sectionOf(NESTED, 'out-of-scope').text, '## Out of scope\n\nNothing else.\n')
  assert.equal(sectionOf(NESTED, 'spec-nested').text, `${NESTED.trimEnd()}\n`)
})

test('a heading line inside a code fence is not a heading', () => {
  const src = [
    '## Real',
    '',
    '```sh',
    '## not a heading',
    '```',
    '',
    '~~~~',
    '## nor this',
    '~~~',
    '## still inside the tilde fence',
    '~~~~',
    '',
    '    ## an indented code line',
    '',
    '## After',
  ].join('\n')
  const ids = parseHeadings(src).map((h) => h.id)
  assert.deepEqual(ids, ['real', 'after'])
  const real = sectionOf(src, 'real')
  assert.match(real.text, /## not a heading/, 'the fenced line stays in the body of its section')
  assert.doesNotMatch(real.text, /## After/)
})

test('an unclosed fence runs to the end of the file', () => {
  assert.deepEqual(
    parseHeadings('## A\n```\n## B\n').map((h) => h.id),
    ['a'],
  )
})

test('a heading line inside an HTML comment is not a heading, and a comment and a fence do not open inside each other', () => {
  const src = [
    '## Kept',
    '<!-- a one-line comment -->',
    '## Also kept',
    '<!--',
    '## Decisions',
    '```',
    '-->',
    '## After the comment',
    '```',
    '<!--',
    '## inside the fence',
    '```',
    '## After the fence',
    '  <!-- opens here',
    '## still commented --> closes here',
    '## Last',
  ].join('\n')
  assert.deepEqual(
    parseHeadings(src).map((h) => h.id),
    ['kept', 'also-kept', 'after-the-comment', 'after-the-fence', 'last'],
  )
  assert.match(
    sectionOf(src, 'also-kept').text,
    /^<!--\n## Decisions\n```\n-->\n$/m,
    'a commented-out section stays in the body of the section around it',
  )
  assert.equal(findSection(src, 'decisions').kind, 'unknown', 'a commented-out heading has no id')
})

test('ATX details: closing hashes are dropped, a hash with no space is text, an empty heading or id is skipped', () => {
  const src = ['## Closed ##', '#hashtag', '##', '####### seven', '   ### Indented three', '## ???', ''].join('\n')
  const hs = parseHeadings(src)
  assert.deepEqual(
    hs.map((h) => [h.level, h.text, h.id, h.line]),
    [
      [2, 'Closed', 'closed', 1],
      [3, 'Indented three', 'indented-three', 5],
    ],
  )
})

test('CRLF and a leading BOM parse exactly as LF', () => {
  const crlf = `\uFEFF${NESTED.replace(/\n/g, '\r\n')}`
  assert.deepEqual(parseHeadings(crlf), parseHeadings(NESTED))
  assert.deepEqual(findSection(crlf, 'decisions'), findSection(NESTED, 'decisions'))
})

test('an unknown id and a duplicate id are refused, never guessed', () => {
  assert.equal(findSection(NESTED, 'no-such-id').kind, 'unknown')
  const dup = '## Notes\n\none\n\n## Other\n\n### Notes\n\ntwo\n'
  const s = findSection(dup, 'notes')
  assert.deepEqual(s.kind === 'ambiguous' ? s.lines : s.kind, [1, 7])
})

test('formatIndex prints id, line and heading text, one heading per line', () => {
  assert.equal(
    formatIndex(parseHeadings(NESTED)),
    [
      'spec-nested\t1\t# Spec: nested',
      'decisions\t3\t## Decisions',
      'keyset-cursor-not-offset\t7\t### Keyset cursor, not offset',
      'one-index-serves-the-sort\t11\t### One index serves the sort',
      'out-of-scope\t15\t## Out of scope',
      '',
    ].join('\n'),
  )
  assert.equal(formatIndex([]), '')
})

// ---------------------------------------------------------------------------------------
// Path containment (pure half; the CLI adds the realpath half)

test('specPath accepts a relative .md path under specs/ and refuses everything else', () => {
  assert.deepEqual(specPath('specs/x.md'), { kind: 'ok', rel: 'specs/x.md' })
  assert.deepEqual(specPath('specs/sub/../x.md'), { kind: 'ok', rel: 'specs/x.md' })
  assert.deepEqual(specPath('specs\\sub\\x.md'), { kind: 'ok', rel: 'specs/sub/x.md' })
  assert.deepEqual(specPath('./specs/x.md'), { kind: 'ok', rel: 'specs/x.md' })
  for (const bad of [
    '../package.json',
    '..',
    'specs/../package.json',
    'specs/../../outside/x.md',
    'specs\\..\\..\\x.md',
    '/etc/passwd',
    '/abs/specs/x.md',
    'C:\\repo\\specs\\x.md',
    'C:specs/x.md',
    '\\\\server\\share\\specs\\x.md',
    'package.json',
    'specs/x.txt',
    'specs/',
    'specs',
    'docs/specs/x.md',
    '',
  ]) {
    const r = specPath(bad)
    assert.equal(r.kind, 'refused', `${JSON.stringify(bad)} must be refused`)
    assert.match(r.kind === 'refused' ? r.why : '', /\S/)
  }
})

// ---------------------------------------------------------------------------------------
// The CLI, spawned in a throwaway working directory

test('CLI: an id prints that section and exits 0; the template resolves security-invariants', () => {
  const dir = fixture({ 'specs/nested.md': NESTED })
  copyFileSync(TEMPLATE, join(dir, 'specs', '_template.md'))
  const r = run(dir, 'specs/nested.md#keyset-cursor-not-offset')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, '### Keyset cursor, not offset\n\nChosen: keyset.\n')
  assert.equal(r.stderr, '')
  const t = run(dir, 'specs/_template.md#security-invariants')
  assert.equal(t.status, 0, t.stderr)
  assert.match(t.stdout, /^## Security invariants\n/)
  assert.doesNotMatch(t.stdout, /## Contract impact/)
})

test('CLI: with no #<id> it prints the index', () => {
  const dir = fixture({ 'specs/nested.md': NESTED })
  const r = run(dir, 'specs/nested.md')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, formatIndex(parseHeadings(NESTED)))
  copyFileSync(TEMPLATE, join(dir, 'specs', '_template.md'))
  const t = run(dir, 'specs/_template.md')
  assert.equal(t.status, 0, t.stderr)
  assert.deepEqual(
    t.stdout.trimEnd().split('\n').map((l) => l.split('\t')[0]),
    TEMPLATE_IDS,
  )
})

test('CLI: a CRLF spec gives byte-identical output to the LF spec', () => {
  const dir = fixture({ 'specs/lf.md': NESTED, 'specs/crlf.md': NESTED.replace(/\n/g, '\r\n') })
  for (const id of ['', '#decisions', '#one-index-serves-the-sort']) {
    const lf = run(dir, `specs/lf.md${id}`)
    const crlf = run(dir, `specs/crlf.md${id}`)
    assert.equal(crlf.status, 0, crlf.stderr)
    assert.equal(crlf.stdout, lf.stdout, `CRLF differs for ${id || 'the index'}`)
  }
})

test('CLI: an unknown id exits 1, prints nothing on stdout and lists the ids on stderr', () => {
  const dir = fixture({ 'specs/nested.md': NESTED })
  for (const arg of ['specs/nested.md#no-such-id', 'specs/nested.md#']) {
    const r = run(dir, arg)
    assert.equal(r.status, 1, arg)
    assert.equal(r.stdout, '')
    assert.match(r.stderr, /no heading/)
    for (const id of ['decisions', 'keyset-cursor-not-offset', 'out-of-scope']) {
      assert.ok(r.stderr.includes(id), `stderr must list ${id}:\n${r.stderr}`)
    }
  }
})

test('CLI: a duplicate id exits 1 and names both lines', () => {
  const dir = fixture({ 'specs/dup.md': '# Spec: dup\n\n## Notes\n\none\n\n## Other\n\n### Notes\n\ntwo\n' })
  const r = run(dir, 'specs/dup.md#notes')
  assert.equal(r.status, 1)
  assert.equal(r.stdout, '')
  assert.match(r.stderr, /ambiguous/)
  assert.match(r.stderr, /lines 3 and 9/)
  const other = run(dir, 'specs/dup.md#other')
  assert.equal(other.status, 0, 'an id that is not duplicated still resolves')
})

test('CLI: a path that is not a .md file under specs/ exits 2 with empty stdout', () => {
  const dir = fixture({ 'specs/nested.md': NESTED, 'specs/notes.txt': 'x', 'specs/dir.md/x.md': NESTED })
  writeFileSync(join(dir, 'package.json'), '{"name":"secret"}\n')
  writeFileSync(join(dir, 'outside.md'), '# Outside\n')
  for (const args of [
    ['../package.json'],
    ['package.json'],
    ['specs/../package.json'],
    ['specs/../outside.md#outside'],
    ['specs\\..\\outside.md'],
    [join(dir, 'specs', 'nested.md')],
    [join(dir, 'specs', 'nested.md#decisions')],
    ['specs/notes.txt'],
    ['specs/missing.md'],
    ['specs/dir.md'],
    [],
    ['specs/nested.md', 'specs/nested.md'],
  ]) {
    const r = run(dir, ...args)
    assert.equal(r.status, 2, `${JSON.stringify(args)} must exit 2, got ${String(r.status)}: ${r.stderr}`)
    assert.equal(r.stdout, '', `${JSON.stringify(args)} must print nothing on stdout`)
    assert.match(r.stderr, /spec-anchor/)
  }
})

test(
  'CLI: a symlink inside specs/ that points outside it exits 2',
  { skip: process.platform === 'win32' ? 'symlinks need privileges on Windows; the lexical refusals above run there' : false },
  () => {
    const dir = fixture({ 'specs/nested.md': NESTED })
    writeFileSync(join(dir, 'secret.md'), '# Secret\n\nkey\n')
    symlinkSync(join(dir, 'secret.md'), join(dir, 'specs', 'link.md'))
    const r = run(dir, 'specs/link.md#secret')
    assert.equal(r.status, 2, r.stderr)
    assert.equal(r.stdout, '')
  },
)

test('CLI: a spec written with bold labels has no section ids, and an id request exits 1', () => {
  const old = [
    '# Spec: legacy',
    '',
    '**Summary / one-liner:** keep it short',
    '',
    '**Security invariants implicated** (RLS policies?): none',
    '',
  ].join('\n')
  const dir = fixture({ 'specs/legacy.md': old })
  const index = run(dir, 'specs/legacy.md')
  assert.equal(index.status, 0, index.stderr)
  assert.equal(index.stdout, 'spec-legacy\t1\t# Spec: legacy\n')
  const r = run(dir, 'specs/legacy.md#security-invariants')
  assert.equal(r.status, 1)
  assert.equal(r.stdout, '')
})

test('CLI: a spec with no headings at all prints an empty index and says why on stderr', () => {
  const dir = fixture({ 'specs/bare.md': '**Summary:** x\n' })
  const r = run(dir, 'specs/bare.md')
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
  assert.match(r.stderr, /no headings/)
})

test('CLI: the resolver never writes anything', () => {
  const dir = fixture({ 'specs/nested.md': NESTED, 'specs/dup.md': '## A\n## A\n' })
  const before = snapshot(dir)
  for (const arg of ['specs/nested.md', 'specs/nested.md#decisions', 'specs/nested.md#nope', 'specs/dup.md#a', '../x.md']) {
    run(dir, arg)
  }
  assert.deepEqual(snapshot(dir), before)
})

// ---------------------------------------------------------------------------------------
// The tool's shape and the prompts that cite it

test('the CLI and its lib import only node: built-ins and local files', () => {
  for (const file of [CLI, join(BASE, 'tools', 'lib', 'spec-anchor.mjs')]) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)) {
      assert.match(m[1], /^(node:|\.\.?\/)/, `${file} imports ${m[1]}`)
    }
  }
})

test('the CLI carries no deferral sentence docs-sync would demand a ledger row for', () => {
  const src = readFileSync(CLI, 'utf8')
  assert.doesNotMatch(src, /deferred to \d|out of scope for \d/i)
})

test('/new-feature has the main thread resolve the cited sections into the reviewer brief', () => {
  const text = readFileSync(join(BASE, '.claude', 'commands', 'new-feature.md'), 'utf8')
  assert.ok(text.includes('`node tools/spec-anchor.mjs specs/$1.md#<id>`'), 'new-feature.md must name the resolver')
  const reviewer = text.indexOf('torvalds-reviewer')
  const anchor = text.indexOf('node tools/spec-anchor.mjs')
  assert.ok(reviewer !== -1 && anchor > reviewer, 'the resolver step sits at the reviewer step')
  assert.match(text, /^allowed-tools: Read, Grep, Glob, Edit, Write, Bash$/m, 'frontmatter unchanged')
})

test('torvalds-reviewer judges against cited sections, falls back to the whole spec, and gains no tool', () => {
  const text = readFileSync(join(BASE, '.claude', 'agents', 'torvalds-reviewer.md'), 'utf8')
  assert.match(text, /^tools: Read, Grep, Glob$/m)
  assert.match(text, /^disallowedTools: Write, Edit$/m)
  const rubricA = text.slice(text.indexOf('(a) Spec'), text.indexOf('(b) Correctness'))
  assert.match(rubricA, /cited/)
  assert.match(rubricA, /specs\/<feature>\.md#<id>/)
  assert.match(rubricA, /Grep/)
  assert.match(rubricA, /whole spec/)
})

test('/adr and the ADR template cite a requirement as specs/<slice>.md#<id>', () => {
  const adr = readFileSync(join(BASE, '.claude', 'commands', 'adr.md'), 'utf8')
  assert.ok(adr.includes('specs/<slice>.md#<id>'), 'adr.md Traceability must cite a spec section')
  const tmpl = readFileSync(join(BASE, 'docs', 'adr', '0000-adr-template.md'), 'utf8')
  const trace = tmpl.slice(tmpl.indexOf('## Traceability'))
  assert.match(trace, /\| R1: [^|]*`specs\/<feature>\.md#[a-z-]+`/)
})

test('the Spec-first SOP names the resolver command', () => {
  const text = readFileSync(join(BASE, 'docs', 'harness', 'README.md'), 'utf8')
  const start = text.indexOf('### Spec-first SOP')
  const sop = text.slice(start, text.indexOf('\n## ', start))
  assert.ok(sop.includes('`node tools/spec-anchor.mjs specs/<feature>.md#<id>`'), sop)
})

test('no package.json script is added for the resolver', () => {
  const pkg = readFileSync(join(BASE, 'package.json.tmpl'), 'utf8')
  assert.doesNotMatch(pkg, /spec-anchor/)
})

test('the two conformance-map notes name the new heading, and no note quotes the old label', () => {
  const map = JSON.parse(readFileSync(join(BASE, 'tools', 'conformance-map.json'), 'utf8'))
  const notes = JSON.stringify(map)
  assert.doesNotMatch(notes, /Security invariants implicated/)
  const rows = map.requirements.filter((r) => typeof r.note === 'string' && r.note.includes("'## Security invariants'"))
  assert.deepEqual(
    rows.map((r) => r.id),
    ['CRA-I.1', 'CRA-I.2'],
  )
})
