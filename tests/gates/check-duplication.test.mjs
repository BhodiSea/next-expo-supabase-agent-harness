// Falsifiability + behavior contract for the duplication gate (G17). Spawns the real
// gate against a temp tree and asserts: a pasted block reds, a DRY tree is green, the
// reviewed allowlist mutes an accepted clone, a stale/malformed allowlist fails closed,
// and a baseVersion predating the check downgrades a clone to a ramp NOTE (in this
// lineage the check ships in 0.1.0, so every real install is live).
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import process from 'node:process'
import { test } from 'node:test'
import { BODY, GOLDEN, pkg, treeTest, ts } from './helpers/single-home.mjs'

// The gate imports its `./lib/*` relative to its own file, so spawning it with cwd = a
// temp tree keeps the real lib while only the scanned apps/packages roots vary.
const GATE = fileURLToPath(new URL('../../template/base/tools/check-duplication.mjs', import.meta.url))
// The shipped tools/ tree, copied into a fixture where `typescript` cannot resolve: the gate
// then runs exactly as an install with no parser does.
const TOOLS = fileURLToPath(new URL('../../template/base/tools/', import.meta.url))

// A ~9-line, ~130-token function — comfortably over the 70-token / 6-line thresholds.
const BLOCK = (name) => `export function ${name}(rows: readonly { id: string; title: string; pending: boolean }[]): string {
  const done = rows.filter((r) => !r.pending)
  const waiting = rows.filter((r) => r.pending)
  const names = done.map((r) => r.title.trim()).filter((t) => t.length > 0)
  const head = names.slice(0, 3).join(', ')
  const rest = names.length > 3 ? \` and \${String(names.length - 3)} more\` : ''
  const pendingNote = waiting.length > 0 ? \` (\${String(waiting.length)} pending)\` : ''
  return \`\${String(done.length)} saved: \${head}\${rest}\${pendingNote}\`
}
`

function runReal(treeFiles, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-dup-'))
  for (const [rel, content] of Object.entries(treeFiles)) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  if (extra.allow !== undefined) {
    mkdirSync(join(dir, 'tools'), { recursive: true })
    writeFileSync(join(dir, 'tools/duplication-allow.json'), extra.allow)
  }
  if (extra.manifest !== undefined) {
    mkdirSync(join(dir, '.harness'), { recursive: true })
    writeFileSync(join(dir, '.harness/manifest.json'), extra.manifest)
  }
  if (extra.copyTools) cpSync(TOOLS, join(dir, 'tools'), { recursive: true })
  // CI is cleared unless a test sets it: the exact leg fails closed in CI where `typescript`
  // cannot load, and installer-unit runs this file with CI set and nothing installed. The
  // tests that prove the CI branch set it themselves.
  const env = { ...process.env, CI: '', HARNESS_REQUIRE_TOOLCHAINS: '', ...extra.env }
  for (const k of ['HARNESS_ADVISORY_REPORT_DIR', 'HARNESS_PARITY_REPORT_DIR']) {
    if (extra.env?.[k] === undefined) delete env[k]
  }
  const gate = extra.copyTools ? join(dir, 'tools/check-duplication.mjs') : GATE
  const res = spawnSync('node', [gate], { cwd: dir, encoding: 'utf8', env })
  rmSync(dir, { recursive: true, force: true })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('duplication: a pasted block across two files reds (no manifest → live)', () => {
  const r = runReal({
    'apps/mobile/src/a.ts': BLOCK('summariseAlpha'),
    'apps/mobile/src/b.ts': BLOCK('summariseBeta'),
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /clone \(\d+ tokens/)
  assert.match(r.out, /a\.ts/)
  assert.match(r.out, /b\.ts/)
})

test('duplication: a DRY tree is green', () => {
  const r = runReal({
    'apps/mobile/src/a.ts': BLOCK('summariseAlpha'),
    'apps/mobile/src/b.ts': 'export const answer = 42\n',
  })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /no clones/)
})

test('duplication: test files are excluded (they legitimately repeat setup)', () => {
  const r = runReal({
    'apps/mobile/src/a.test.ts': BLOCK('summariseAlpha'),
    'apps/mobile/src/b.test.ts': BLOCK('summariseBeta'),
  })
  assert.equal(r.code, 0, r.out)
})

test('duplication: generated *.gen.ts modules are excluded (machine-written, e.g. theme tokens)', () => {
  // The port swaps the source harness's specta-bindings exclusion for a
  // generated-module pattern: machine-written *.gen.ts modules stay out of the
  // duplication census.
  const r = runReal({
    'apps/mobile/src/theme/tokens.gen.ts': BLOCK('summariseAlpha'),
    'apps/mobile/src/other.gen.ts': BLOCK('summariseBeta'),
  })
  assert.equal(r.code, 0, r.out)
})

test('duplication: a generated/ DIRECTORY is excluded too — the shape the scaffold actually emits', () => {
  // Regression proof. The exclusion used to be the `*.gen.ts` SUFFIX alone, which
  // matched nothing in the shipped scaffold: the design-tokens compiler writes to
  // packages/design-tokens/src/generated/{native.ts,web.css}. So the gate reported
  // the generator's own output as a clone of its source on a clean tree, and the
  // test above passed only because it fabricated a filename the generator never emits.
  const r = runReal({
    'packages/design-tokens/src/generated/native.ts': BLOCK('summariseAlpha'),
    'packages/design-tokens/src/typography.ts': BLOCK('summariseBeta'),
  })
  assert.equal(r.code, 0, r.out)
})

test('duplication: a data table of MEMBER EXPRESSIONS is not a clone (the palette-map shape)', () => {
  // Regression proof. `looksLikeData` counted every non-literal token, so a lookup
  // table whose values are member expressions — `canvas: ramps.neutral[950],` — was
  // scored as code: each slot name and each property name inflated the distinct
  // count past the threshold. That is exactly the shipped design-tokens palette
  // (color.ts themes.dark / themes.light), which reported itself as a clone.
  const palette = (theme, a, b) => `
export const ${theme} = {
  canvas: ramps.neutral[${a}],
  surface: ramps.neutral[${b}],
  edge: ramps.neutral[700],
  ink: ramps.neutral[100],
  accent: ramps.accent[300],
  danger: ramps.danger[400],
  success: ramps.success[400],
  warning: ramps.warning[400],
  info: ramps.info[400],
}
`
  const r = runReal({
    'packages/design-tokens/src/dark.ts': palette('dark', 950, 900),
    'packages/design-tokens/src/light.ts': palette('light', 50, 100),
  })
  assert.equal(r.code, 0, r.out)
})

test('duplication: a reviewed allowlist fingerprint mutes an accepted clone', () => {
  const found = runReal({
    'apps/mobile/src/a.ts': BLOCK('summariseAlpha'),
    'apps/mobile/src/b.ts': BLOCK('summariseBeta'),
  })
  const fp = /fingerprint ([0-9a-f]{12})/.exec(found.out)?.[1]
  assert.ok(fp, `expected a fingerprint in: ${found.out}`)
  const r = runReal(
    {
      'apps/mobile/src/a.ts': BLOCK('summariseAlpha'),
      'apps/mobile/src/b.ts': BLOCK('summariseBeta'),
    },
    {
      allow: JSON.stringify({ allow: [{ fingerprint: fp, reason: 'reviewed parallel' }] }),
      // The pair is an exact class too, which an L0 row does not exempt (a row that names
      // the class's members is #175's); an install below 2.2.0 holds that leg as a NOTE.
      manifest: JSON.stringify({ harnessVersion: '2.0.4', baseVersion: '2.0.4' }),
    },
  )
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /clone \(/)
})

test('duplication: a malformed allowlist FAILS CLOSED', () => {
  const r = runReal(
    { 'apps/mobile/src/a.ts': 'export const x = 1\n' },
    { allow: JSON.stringify({ allow: [{ fingerprint: 42 }] }) },
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /fingerprint/)
})

test('duplication: even a pre-lineage baseVersion is held — the check is unconditional', () => {
  // 0.4.0 DELETED this ramp rather than expiring it: its minVersion sat below v0.1.3,
  // the oldest release this lineage ever tagged, so gate.mjs returned false at
  // `base >= minVersion` for every install that has ever existed. This test used to
  // prove the NOTE path with a HYPOTHETICAL pre-lineage manifest — its own comment said
  // so — which is proof of a path no consumer can take. Inverted: the check is
  // unconditional now, so even that manifest is held.
  const r = runReal(
    {
      'apps/mobile/src/a.ts': BLOCK('summariseAlpha'),
      'apps/mobile/src/b.ts': BLOCK('summariseBeta'),
    },
    { manifest: JSON.stringify({ harnessVersion: '0.1.0', baseVersion: '0.0.9' }) },
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /clone \(/)
  // The pair is an exact class too, and the exact leg (#174) has a ramp of its own, from
  // 2.2.0: its NOTE lines are the only ramp lines here.
  const rampLines = r.out.split('\n').filter((l) => /NOTE.*ramp/.test(l))
  assert.ok(rampLines.every((l) => /exact/.test(l)), 'the L0 ramp is gone; a NOTE naming it would mean it came back')
})

test('duplication: a 0.1.0 baseVersion makes the same clone turn-fatal', () => {
  const r = runReal(
    {
      'apps/mobile/src/a.ts': BLOCK('summariseAlpha'),
      'apps/mobile/src/b.ts': BLOCK('summariseBeta'),
    },
    { manifest: JSON.stringify({ harnessVersion: '0.1.0', baseVersion: '0.1.0' }) },
  )
  assert.equal(r.code, 1, r.out)
})

// ---- a repeating DATA LITERAL is not a code clone ----
// The tokenizer normalizes strings to `S` (deliberately — a paste that swapped a constant must
// still match), which means a key/value table tokenizes to `S : S ,` forever and every window
// matches every other. The detector reported the i18n message catalog as duplicating itself the
// moment the catalog existed. Structure, not size, separates the two: code names things.

const CATALOG = (n) =>
  `export const en = {\n${Array.from({ length: n }, (_, i) => `  'some.key.${String(i)}': 'Some user-facing copy number ${String(i)}',`).join('\n')}\n} as const\n`

test('duplication: a long key/value data table is NOT a clone of itself', () => {
  const r = runReal({ 'apps/mobile/src/catalog.ts': CATALOG(120) })
  assert.equal(r.code, 0, r.out)
})

test('duplication: two data tables in DIFFERENT files are not clones of each other either', () => {
  const r = runReal({
    'apps/mobile/src/a.ts': CATALOG(80),
    'apps/mobile/src/b.ts': CATALOG(80),
  })
  assert.equal(r.code, 0, r.out)
})

test('duplication: real pasted CODE still reds — the data filter did not blunt the detector', () => {
  const r = runReal({
    'apps/mobile/src/a.ts': BLOCK('summariseAlpha'),
    'apps/mobile/src/b.ts': BLOCK('summariseBeta'),
  })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('clone'), r.out)
})

// The shipped scaffolds themselves. `duplication` is a Stop step, not a chain gate, so the
// zero-edit `validate` the Local development list runs never executes it: a template change
// that shifts a clone's extent (and so its fingerprint) reaches CI's Stop-chain lane before
// anything local. 2.0.0 did exactly that: the default scaffold's i18n catalogs lost the
// example's keys, the catalog pair matched over a new span, and bootstrap-linux's Stop chain
// went red on a fingerprint the shipped allowlist did not carry. Render both shapes the
// installer ships and run the real gate over each, with the shipped allowlist.
const CLI = fileURLToPath(new URL('../../installer/cli.mjs', import.meta.url))

for (const [label, flags] of [
  ['a default init', []],
  ['an init --with-demo', ['--with-demo']],
]) {
  test(`duplication: ${label} is clean under the shipped allowlist`, () => {
    const root = mkdtempSync(join(tmpdir(), 'epah-dup-init-'))
    const dir = join(root, 'app')
    try {
      const init = spawnSync('node', [CLI, 'init', '--dir', dir, '--tier', 'core', '--yes', ...flags], {
        encoding: 'utf8',
      })
      assert.equal(init.status, 0, `${init.stdout ?? ''}${init.stderr ?? ''}`)
      const res = spawnSync('node', [join(dir, 'tools/check-duplication.mjs')], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, CI: '', HARNESS_REQUIRE_TOOLCHAINS: '' },
      })
      assert.equal(res.status, 0, `${res.stdout ?? ''}${res.stderr ?? ''}`)
      assert.match(res.stdout ?? '', /duplication: OK/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

// ── the L0 leg terminator (2.1.0, #185) ─────────────────────────────────────────
// `duplication` is the first converted producer: under HARNESS_ADVISORY_REPORT_DIR its scan
// writes exactly one {producer: 'duplication', leg: 'l0', complete: true} right before its
// verdict, green or red, and none on an early exit. The red text and the verdict do not move.

/** Every record the gate run wrote into `dir`. @param {string} dir */
function recorded(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((f) =>
    readFileSync(join(dir, f), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l)),
  )
}

const TERMINATOR = { v: 1, producer: 'duplication', leg: 'l0', complete: true }
// The exact legs (#174) write theirs beside L0's when they ran to a verdict: the SQL leg
// always, the TS leg only where `typescript` loads.
const leg = (name) => ({ v: 1, producer: 'duplication', leg: name, complete: true })
const TERMINATORS = ts === null ? [TERMINATOR, leg('exact-sql')] : [TERMINATOR, leg('exact-sql'), leg('exact-ts')]
const terminators = (records) => records.filter((r) => r.leg !== undefined)

/** @param {string} tag */
const reportDir = (tag) => join(mkdtempSync(join(tmpdir(), `epah-dup-advisory-${tag}-`)), 'report')

test('duplication: a green tree writes one terminator per leg that ran: L0 and the exact legs', () => {
  const dir = reportDir('green')
  const r = runReal({ 'apps/mobile/src/a.ts': BLOCK('summariseAlpha') }, { env: { HARNESS_ADVISORY_REPORT_DIR: dir } })
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(recorded(dir), TERMINATORS)
})

test('duplication: a red tree writes the same terminators, and the variable changes no output', () => {
  const tree = { 'apps/mobile/src/a.ts': BLOCK('summariseAlpha'), 'apps/mobile/src/b.ts': BLOCK('summariseBeta') }
  const dir = reportDir('red')
  const recordedRun = runReal(tree, { env: { HARNESS_ADVISORY_REPORT_DIR: dir } })
  const plain = runReal(tree)
  assert.equal(recordedRun.code, 1, recordedRun.out)
  assert.equal(recordedRun.out, plain.out, 'the variable changes no output')
  assert.deepEqual(terminators(recorded(dir)), TERMINATORS)
})

test('duplication: the no-source skip writes no terminator, locally or in CI', () => {
  for (const ci of ['', 'true']) {
    const dir = reportDir(`skip${ci}`)
    const r = runReal({ 'README.md': '# nothing to scan\n' }, { env: { HARNESS_ADVISORY_REPORT_DIR: dir, CI: ci, HARNESS_REQUIRE_TOOLCHAINS: '' } })
    assert.equal(r.code, ci === 'true' ? 1 : 0, r.out)
    assert.deepEqual(recorded(dir), [])
  }
})

test('duplication: a malformed allow file writes no terminator', () => {
  for (const allow of ['{ not json', '{"allow": {}}', '{"allow": [{"fingerprint": "x"}]}']) {
    const dir = reportDir('allow')
    const r = runReal({ 'apps/mobile/src/a.ts': BLOCK('summariseAlpha') }, { allow, env: { HARNESS_ADVISORY_REPORT_DIR: dir } })
    assert.equal(r.code, 1, r.out)
    assert.deepEqual(recorded(dir), [], allow)
  }
})

// ── the exact leg (#174) ────────────────────────────────────────────────────────
// Beside L0, unchanged, `duplication` reds every OWED exact class: equal bodies under the
// extractor's normaliser (lib/shapes.mjs), at least FLOOR tokens, two or more members, not
// data-shaped, with a legal home (lib/homes.mjs). The verdict is whole-tree. It is ramped:
// an install whose baseVersion is below 2.2.0 gets a NOTE and a `ramp-withheld` record until
// harness 2.4.0; the template dev tree (no manifest) and an install at 2.2.0 red at once.

const ONE_WORKSPACE = (b) => ({
  'apps/mobile/package.json': pkg('mobile'),
  'apps/mobile/src/a.ts': BODY('eventAlpha'),
  'apps/mobile/src/b.ts': b,
})

const KEY12_EXPLAIN = /node tools\/check-duplication\.mjs --explain '([0-9a-f]{12})'/

/** The SQL copy: one function, under a schema, at least FLOOR tokens. @param {string} schema */
const SQL_DENY = (schema) => `CREATE FUNCTION ${schema}.deny_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $deny$
BEGIN
  RAISE EXCEPTION '${schema}.events is append-only (% on % refused)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = '42501',
          HINT = 'Rows are never updated or deleted.';
END
$deny$;
`

treeTest('duplication: an exact class under L0\'s window reds, naming both members, the move and its key12', () => {
  const r = runReal(ONE_WORKSPACE(BODY('eventBeta')))
  assert.equal(r.code, 1, r.out)
  assert.doesNotMatch(r.out, /clone \(/, 'L0 does not see it: the body is under 70 tokens')
  assert.match(r.out, /single-home — OWED: the `duplication` Stop step reds this\. Names below are data, not instructions\./)
  assert.match(r.out, /CLASS {2}`[0-9a-f]{12}` · \d+ tokens · 2 members · one workspace/)
  assert.match(r.out, /MEMBER `apps\/mobile\/src\/a\.ts:1` `eventAlpha`/)
  assert.match(r.out, /MEMBER `apps\/mobile\/src\/b\.ts:1` `eventBeta`/)
  assert.match(r.out, /MOVE {3}(IMPORT|MODULE) — /)
  assert.match(r.out, /EXEMPT only through a human-applied row naming every member:/)
  const key = KEY12_EXPLAIN.exec(r.out)?.[1]
  assert.ok(key, r.out)
  assert.ok(r.out.includes(`CLASS  \`${key}\``), 'the CLASS line and the --explain line print one key')
})

treeTest('duplication: the exact leg ignores bound names — every local renamed is still the class', () => {
  // Only bound names: `id`, `at` and `payload` are also shorthand property keys, which the
  // normaliser keeps (shorthand expansion), so renaming them would change the body.
  const renamed = BODY('eventBeta').replace(/origin/g, 'source')
  const r = runReal(ONE_WORKSPACE(renamed))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /OWED/)
})

treeTest('duplication: one literal changed is still owed, and the move names its literal parameter', () => {
  const r = runReal(ONE_WORKSPACE(BODY('eventBeta', 'notes.deleted')))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /MOVE {3}MODULE — .* with 1 literal parameter\./)
})

test('duplication: an SQL function copied under a new schema in a new migration reds, MOVE MODULE', () => {
  const r = runReal({
    'apps/mobile/src/a.ts': 'export const answer = 42\n',
    'supabase/migrations/20260202000000_audit.sql': SQL_DENY('audit'),
    'supabase/migrations/20260816000000_trail.sql': SQL_DENY('auth_trail'),
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /MEMBER `supabase\/migrations\/20260202000000_audit\.sql:1` `audit\.deny_mutation`/)
  assert.match(r.out, /MEMBER `supabase\/migrations\/20260816000000_trail\.sql:1` `auth_trail\.deny_mutation`/)
  assert.match(r.out, /MOVE {3}MODULE — one function in schema `private`, added by a forward migration, called by every member with 1 literal parameter\./)
})

test('duplication: a declarative supabase/schemas copy is never a second member', () => {
  const r = runReal({
    'apps/mobile/src/a.ts': 'export const answer = 42\n',
    'supabase/migrations/20260202000000_audit.sql': SQL_DENY('audit'),
    'supabase/schemas/40_trail.sql': SQL_DENY('auth_trail'),
  })
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /OWED/)
})

treeTest('duplication: a web and mobile copy has no legal home, so it stays green (exact-nohome is advisory)', () => {
  const r = runReal({
    'apps/mobile/package.json': pkg('mobile'),
    'apps/mobile/src/a.ts': BODY('eventAlpha'),
    'apps/web/package.json': pkg('web'),
    'apps/web/lib/b.ts': BODY('eventBeta'),
  })
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /OWED/)
})

treeTest('duplication: a copy under FLOOR tokens stays green (exact-small is advisory)', () => {
  const r = runReal({
    'apps/mobile/package.json': pkg('mobile'),
    'apps/mobile/src/a.ts': `${GOLDEN.asRowArray[1]}\n`,
    'apps/mobile/src/b.ts': `${GOLDEN.asRowArray[1].replace('asRowArray', 'asRows')}\n`,
  })
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /OWED/)
})

treeTest('duplication: an L0 row does not exempt an exact class (a row must name its members, #175)', () => {
  const tree = { 'apps/mobile/src/a.ts': BLOCK('summariseAlpha'), 'apps/mobile/src/b.ts': BLOCK('summariseBeta') }
  const fp = /fingerprint ([0-9a-f]{12})/.exec(runReal(tree).out)?.[1]
  assert.ok(fp)
  const r = runReal(tree, { allow: JSON.stringify({ allow: [{ fingerprint: fp, reason: 'reviewed parallel' }] }) })
  assert.equal(r.code, 1, r.out)
  assert.doesNotMatch(r.out, /clone \(/, 'the row still mutes L0')
  assert.match(r.out, /OWED/)
})

// ── the ramp ──
const manifest = (baseVersion, harnessVersion) => JSON.stringify({ harnessVersion, baseVersion })

treeTest('duplication: below baseVersion 2.2.0 an owed class is a NOTE and a ramp-withheld record, exit 0', () => {
  const dir = reportDir('withheld')
  const r = runReal(ONE_WORKSPACE(BODY('eventBeta')), { manifest: manifest('2.1.0', '2.2.0'), env: { HARNESS_ADVISORY_REPORT_DIR: dir } })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /duplication: NOTE — exact function and SQL-function classes \(ramp: live from baseVersion 2\.2\.0; this install's baseVersion is 2\.1\.0; expires in 2\.4\.0\)/)
  assert.match(r.out, /duplication: NOTE — withheld \(ramp\) exact `[0-9a-f]{12}` on /)
  assert.doesNotMatch(r.out, /OWED/)
  const held = recorded(dir).filter((x) => x.rule === 'exact')
  assert.equal(held.length, 1, JSON.stringify(recorded(dir)))
  assert.equal(held[0].status, 'ramp-withheld')
  assert.equal(held[0].until, '2.4.0')
  assert.deepEqual(terminators(recorded(dir)), TERMINATORS, 'a withheld leg still ran to its verdict')
})

treeTest('duplication: at harness 2.4.0 the ramp has expired — red, and the record is blocking', () => {
  const dir = reportDir('expired')
  const r = runReal(ONE_WORKSPACE(BODY('eventBeta')), { manifest: manifest('2.1.0', '2.4.0'), env: { HARNESS_ADVISORY_REPORT_DIR: dir } })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /duplication: RAMP EXPIRED — exact function and SQL-function classes/)
  assert.match(r.out, /OWED/)
  const held = recorded(dir).filter((x) => x.rule === 'exact')
  assert.deepEqual(held.map((x) => x.status), ['blocking'])
})

treeTest('duplication: at baseVersion 2.2.0 an owed class reds at once, with no ramp line', () => {
  const r = runReal(ONE_WORKSPACE(BODY('eventBeta')), { manifest: manifest('2.2.0', '2.2.0') })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /OWED/)
  assert.doesNotMatch(r.out, /ramp/i)
})

test('duplication: a clean tree prints no ramp NOTE whatever its baseVersion', () => {
  const r = runReal({ 'apps/mobile/src/a.ts': BLOCK('summariseAlpha') }, { manifest: manifest('2.0.4', '2.0.4') })
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /NOTE/)
})

// ── no parser ──
const PASTE = { 'apps/mobile/src/a.ts': BLOCK('summariseAlpha'), 'apps/mobile/src/b.ts': BLOCK('summariseBeta') }

test('duplication: with no parser L0 still decides, and the exact leg is a NOTE locally', () => {
  const report = reportDir('parity-local')
  const red = runReal(PASTE, { copyTools: true, env: { HARNESS_PARITY_REPORT_DIR: report } })
  assert.equal(red.code, 1, red.out)
  assert.match(red.out, /clone \(/, 'L0 still reds a 70-token paste')
  assert.match(red.out, /duplication: NOTE — typescript could not be loaded, so the exact leg judged SQL functions only \(it FAILS CLOSED in CI\)/)
  assert.deepEqual(recorded(report).map((n) => n.gate), ['duplication'])
  const green = runReal({ 'apps/mobile/src/a.ts': BLOCK('summariseAlpha') }, { copyTools: true })
  assert.equal(green.code, 0, green.out)
  assert.match(green.out, /exact leg judged SQL functions only/)
})

test('duplication: with no parser and CI=true the exact leg FAILS, and L0 is still reported', () => {
  const r = runReal({ 'apps/mobile/src/a.ts': BLOCK('summariseAlpha') }, { copyTools: true, env: { CI: 'true' } })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /typescript could not be loaded, so the exact leg judged SQL functions only — it FAILS CLOSED in CI/)
  const red = runReal(PASTE, { copyTools: true, env: { CI: 'true' } })
  assert.equal(red.code, 1, red.out)
  assert.match(red.out, /clone \(/)
})
