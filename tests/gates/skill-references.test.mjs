// Proofs for scripts/generate-skill-references.mjs (1.1.0, N09): the regen-diff that ties the
// authoring-vertical-slice skill's reference code blocks to the example they are copied from.
//
// The generator resolves the repository root from its own location, so every red case runs a
// COPY of it inside a MIRROR (the floor-lockstep pattern): the script, its helper library, the
// three installer modules they import, and the four files the two shipped regions span. Each
// case plants one defect, runs `--check`, and asserts the exit code AND that the output names
// the file and the region id, so a red for the wrong reason cannot pass. The drift cases then
// run `--write` and prove it makes the mirror green; the structural cases prove `--write`
// refuses and leaves every reference byte as it was. The live case runs the real script over
// this checkout, as the factory Stop hook's `skill-references` step does.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SCRIPT = 'scripts/generate-skill-references.mjs'
const REFS = 'template/base/.claude/skills/authoring-vertical-slice/references'
const DAL = `${REFS}/dal-dto.md`
const RLS = `${REFS}/migration-rls.md`
const ROUTER = 'template/stack/packages/api/src/routers/notes.ts'
const SCHEMA = 'template/stack/supabase/schemas/20_notes.sql'
const MIRRORED = [
  SCRIPT,
  'scripts/lib/skill-regions.mjs',
  'installer/lib/fs-walk.mjs',
  'installer/lib/layout.mjs',
  'installer/lib/placeholders.mjs',
  ROUTER,
  SCHEMA,
  DAL,
  RLS,
]

// The four marker pairs the shipped tree carries. A case that cannot find the text it edits
// throws (replaceOnce), so a renamed marker fails these tests loudly instead of vacuously.
const ROUTER_BEGIN = '  // skill-region:begin create-procedure\n'
const ROUTER_END = '  // skill-region:end create-procedure\n'
const SCHEMA_BEGIN = '-- skill-region:begin org-policies\n'
const SCHEMA_END = '-- skill-region:end org-policies\n'
const DAL_BEGIN = '  <!-- skill-region:begin create-procedure source=packages/api/src/routers/notes.ts -->\n'
const DAL_END = '  <!-- skill-region:end create-procedure -->\n'
const RLS_BEGIN = '<!-- skill-region:begin org-policies source=supabase/schemas/20_notes.sql -->\n'
const RLS_END = '<!-- skill-region:end org-policies -->\n'

const made = []
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

function mirror() {
  const dir = mkdtempSync(join(tmpdir(), 'epah-skill-refs-'))
  made.push(dir)
  for (const rel of MIRRORED) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    copyFileSync(join(ROOT, rel), join(dir, rel))
  }
  return dir
}

function cleanEnv() {
  const env = { ...process.env }
  delete env.CI
  delete env.GITHUB_BASE_REF
  return env
}

/** @param {string} root @param {string[]} args */
function run(root, args) {
  const r = spawnSync(process.execPath, [join(root, SCRIPT), ...args], {
    encoding: 'utf8',
    env: cleanEnv(),
  })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8')

/** Replace exactly one occurrence, or throw: an edit that finds nothing proves nothing. */
function replaceOnce(dir, rel, needle, replacement) {
  const text = read(dir, rel)
  const at = text.indexOf(needle)
  assert.notEqual(at, -1, `${rel} no longer contains ${JSON.stringify(needle)}`)
  assert.equal(text.indexOf(needle, at + 1), -1, `${rel} contains ${JSON.stringify(needle)} twice`)
  writeFileSync(join(dir, rel), text.slice(0, at) + replacement + text.slice(at + needle.length))
}

/** Assert a red `--check`, naming every fragment; return the output for further asserts. */
function assertRed(dir, fragments) {
  const r = run(dir, ['--check'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /generate-skill-references --check: FAILED/, r.out)
  for (const f of fragments) assert.ok(r.out.includes(f), `expected ${JSON.stringify(f)} in:\n${r.out}`)
  return r.out
}

/** A structural red must survive --write, and --write must leave both references untouched. */
function assertWriteRefuses(dir) {
  const before = [read(dir, DAL), read(dir, RLS)]
  const w = run(dir, ['--write'])
  assert.equal(w.code, 1, w.out)
  assert.deepEqual([read(dir, DAL), read(dir, RLS)], before, '--write must not touch a reference while a region is broken')
}

test('LIVE: --check is green over this checkout, and counts both shipped regions', () => {
  const r = run(ROOT, ['--check'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /generate-skill-references --check: OK \(2 regions in 2 references match their sources\)/, r.out)
})

test('the mirror starts green, so every red below is the planted defect', () => {
  const dir = mirror()
  const r = run(dir, ['--check'])
  assert.equal(r.code, 0, r.out)
})

test('an edited source span reds, naming the reference and the region; --write makes it green', () => {
  const dir = mirror()
  replaceOnce(dir, ROUTER, 'return createNote(ctx.db, writeContext(ctx, gate.data.id), input)', 'return createNote(ctx.db, writeContext(ctx, input.orgId), input)')
  assertRed(dir, [DAL, "'create-procedure'", 'packages/api/src/routers/notes.ts'])
  const w = run(dir, ['--write'])
  assert.equal(w.code, 0, w.out)
  assert.ok(w.out.includes(DAL), w.out)
  assert.ok(read(dir, DAL).includes('    return createNote(ctx.db, writeContext(ctx, input.orgId), input)\n'), read(dir, DAL))
  assert.equal(read(dir, RLS), read(ROOT, RLS), '--write rewrote a reference whose region had not drifted')
  const c = run(dir, ['--check'])
  assert.equal(c.code, 0, c.out)
})

test('a hand-edited region reds, naming the reference and the region; --write restores the source', () => {
  const dir = mirror()
  replaceOnce(dir, RLS, 'CREATE POLICY notes_select_org ON public.notes\n  AS PERMISSIVE FOR SELECT TO authenticated\n  USING (org_id = ANY((SELECT private.member_org_ids())::uuid[]));', 'CREATE POLICY notes_select_org ON public.notes\n  AS PERMISSIVE FOR SELECT TO authenticated\n  USING (true);')
  assertRed(dir, [RLS, "'org-policies'", 'supabase/schemas/20_notes.sql'])
  const w = run(dir, ['--write'])
  assert.equal(w.code, 0, w.out)
  assert.equal(read(dir, RLS), read(ROOT, RLS))
  assert.equal(run(dir, ['--check']).code, 0)
})

test('an orphan on the source side reds: a source region no reference renders', () => {
  const dir = mirror()
  replaceOnce(dir, DAL, DAL_BEGIN, '')
  replaceOnce(dir, DAL, DAL_END, '')
  assertRed(dir, ['orphan', "'create-procedure'", ROUTER])
  assertWriteRefuses(dir)
})

test('an orphan on the reference side reds: a reference region its source does not carry', () => {
  const dir = mirror()
  replaceOnce(dir, ROUTER, ROUTER_BEGIN, '')
  replaceOnce(dir, ROUTER, ROUTER_END, '')
  assertRed(dir, ['orphan', "'create-procedure'", DAL])
  assertWriteRefuses(dir)
})

test('a reference naming a source file that does not exist reds', () => {
  const dir = mirror()
  replaceOnce(dir, RLS, RLS_BEGIN, RLS_BEGIN.replace('20_notes.sql', '21_notes.sql'))
  assertRed(dir, ['supabase/schemas/21_notes.sql', "'org-policies'", RLS])
  assertWriteRefuses(dir)
})

test('an unknown id reds, even when both sides agree on it', () => {
  const dir = mirror()
  replaceOnce(dir, ROUTER, ROUTER_BEGIN, ROUTER_BEGIN.replace('create-procedure', 'create-procedures'))
  replaceOnce(dir, ROUTER, ROUTER_END, ROUTER_END.replace('create-procedure', 'create-procedures'))
  replaceOnce(dir, DAL, DAL_BEGIN, DAL_BEGIN.replace('create-procedure', 'create-procedures'))
  replaceOnce(dir, DAL, DAL_END, DAL_END.replace('create-procedure', 'create-procedures'))
  assertRed(dir, ['unknown region id', "'create-procedures'", ROUTER, DAL])
  assertWriteRefuses(dir)
})

test('a duplicate id reds', () => {
  const dir = mirror()
  replaceOnce(dir, ROUTER, '  get: orgProcedure', `${ROUTER_BEGIN}  get: orgProcedure`)
  replaceOnce(dir, ROUTER, '  list: orgProcedure', `${ROUTER_END}\n  list: orgProcedure`)
  assertRed(dir, ['duplicate', "'create-procedure'", ROUTER])
  assertWriteRefuses(dir)
})

test('unbalanced markers red, on either side', () => {
  const src = mirror()
  replaceOnce(src, SCHEMA, SCHEMA_END, '')
  assertRed(src, ['unbalanced', "'org-policies'", SCHEMA])
  assertWriteRefuses(src)

  const ref = mirror()
  replaceOnce(ref, DAL, DAL_END, '')
  assertRed(ref, ['unbalanced', "'create-procedure'", DAL])
  assertWriteRefuses(ref)

  // An end that closes a region other than the open one is unbalanced too, not a pair.
  const crossed = mirror()
  replaceOnce(crossed, SCHEMA, SCHEMA_END, SCHEMA_END.replace('org-policies', 'create-procedure'))
  assertRed(crossed, ['unbalanced', "'org-policies'", SCHEMA])
})

test('a malformed marker reds rather than being read as prose', () => {
  const dir = mirror()
  replaceOnce(dir, SCHEMA, SCHEMA_BEGIN, '-- skill-region:begin\n')
  assertRed(dir, ['malformed', SCHEMA])
  assertWriteRefuses(dir)
})

test('an installer placeholder token inside a source span reds', () => {
  const dir = mirror()
  replaceOnce(dir, ROUTER, '    const gate = ctx.org\n    if (!gate.ok) return gate\n    return createNote', '    const gate = ctx.org // {{APP_SLUG}}\n    if (!gate.ok) return gate\n    return createNote')
  assertRed(dir, ['placeholder', '{{APP_SLUG}}', "'create-procedure'", ROUTER])
  assertWriteRefuses(dir)
})

test('zero regions red: the check cannot pass on nothing', () => {
  const dir = mirror()
  for (const [rel, markers] of [
    [ROUTER, [ROUTER_BEGIN, ROUTER_END]],
    [SCHEMA, [SCHEMA_BEGIN, SCHEMA_END]],
    [DAL, [DAL_BEGIN, DAL_END]],
    [RLS, [RLS_BEGIN, RLS_END]],
  ]) {
    for (const m of markers) replaceOnce(dir, rel, m, '')
  }
  assertRed(dir, ['zero regions'])
  assertWriteRefuses(dir)
})

test('CRLF checkouts compare equal: line endings are normalised before the diff', () => {
  const dir = mirror()
  for (const rel of [ROUTER, DAL]) writeFileSync(join(dir, rel), read(dir, rel).replace(/\n/g, '\r\n'))
  const r = run(dir, ['--check'])
  assert.equal(r.code, 0, r.out)
})

test('an unknown flag is refused rather than read as --check', () => {
  const r = run(ROOT, ['--wrte'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /usage: node scripts\/generate-skill-references\.mjs \[--check \| --write\]/, r.out)
})
