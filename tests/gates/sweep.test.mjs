// The duplication sweep (template/base/tools/lib/sweep.mjs, 2.1.0, #186): `check-duplication.mjs
// --sweep --json` and `--explain '<key12>'`. It decides no verdict. Four properties:
//   - the document is complete on the shipped scaffolds, every record passes the closed
//     schema (lib/gate.mjs advisoryRecordOk), and the records are sorted by key;
//   - it is byte-identical however the directory is listed, wherever the tree sits, and
//     whatever the zone and locale;
//   - with no parser the TS legs are incomplete, the run exits 1 and records the missing
//     prerequisite, and the plain run's L0 still reds;
//   - the plan's dogfood rows (SINGLE-HOME, "Dogfood findings"), rebuilt as fixtures, get
//     the rule, tier, home and literal parameters the plan gives them, with two corrections
//     the code measured (rows 4 and 6, below).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { after, before, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { renderDiffersAt } from '../../template/base/tools/lib/closed-text.mjs'
import { differsAt } from '../../template/base/tools/lib/differs.mjs'
import { advisoryKey, advisoryRecordOk } from '../../template/base/tools/lib/gate.mjs'
import { extractTree } from '../../template/base/tools/lib/shapes.mjs'
import {
  byRank,
  explainRecord,
  FLOOR,
  NEAR_MISS,
  SMALL_FLOOR,
  sweep,
  SWEEP_FAMILIES,
  sweepMain,
} from '../../template/base/tools/lib/sweep.mjs'
import { GOLDEN, inTree, pkg, treeTest, ts } from './helpers/single-home.mjs'

const CLI = fileURLToPath(new URL('../../installer/cli.mjs', import.meta.url))
const TYPESCRIPT = fileURLToPath(new URL('../../node_modules/typescript', import.meta.url))
// Read by path, not imported: the rule file is the scaffold's, not the factory's.
const DEPCRUISE = readFileSync(join(fileURLToPath(new URL('../../template/base/', import.meta.url)), 'dependency-cruiser.cjs'), 'utf8')

const NO_CODE_SPANS = (text) => text.replace(/`[^`\n]*`/g, '')
const isSortedByKey = (records) =>
  records.every((r, i) => i === 0 || advisoryKey(records[i - 1]) < advisoryKey(r))

// ── the shipped scaffolds, spawned ────────────────────────────────────────────────

/** @type {string} */
let ROOT = ''
const SCAFFOLDS = { default: '', demo: '', bare: '' }

/** An env with no recorder directory a caller's shell might carry. */
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  for (const k of ['HARNESS_ADVISORY_REPORT_DIR', 'HARNESS_PARITY_REPORT_DIR']) {
    if (extra[k] === undefined) delete env[k]
  }
  return env
}

/** Render one scaffold; `parser` links the factory's typescript into its node_modules. */
function scaffold(name, flags, parser) {
  const dir = join(ROOT, name)
  const init = spawnSync(process.execPath, [CLI, 'init', '--dir', dir, '--tier', 'core', '--yes', ...flags], {
    encoding: 'utf8',
  })
  assert.equal(init.status, 0, `${init.stdout ?? ''}${init.stderr ?? ''}`)
  if (parser && existsSync(TYPESCRIPT)) {
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    symlinkSync(TYPESCRIPT, join(dir, 'node_modules', 'typescript'))
  }
  return dir
}

/** Run the scaffold's own gate. @param {string} dir @param {string[]} args */
function gate(dir, args, { env = {}, node = [] } = {}) {
  const r = spawnSync(process.execPath, [...node, join(dir, 'tools/check-duplication.mjs'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: cleanEnv(env),
  })
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' }
}

before(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'epah-sweep-'))
  SCAFFOLDS.default = scaffold('default', [], true)
  SCAFFOLDS.demo = scaffold('demo', ['--with-demo'], true)
  SCAFFOLDS.bare = scaffold('bare', [], false)
})

after(() => rmSync(ROOT, { recursive: true, force: true }))

/** @type {Map<string, any>} */
const docs = new Map()
/** The parsed sweep document of a scaffold, run once. @param {'default' | 'demo'} name */
function docOf(name) {
  if (!docs.has(name)) {
    const r = gate(SCAFFOLDS[name], ['--sweep', '--json'])
    assert.equal(r.code, 0, r.err)
    docs.set(name, { raw: r.out, doc: JSON.parse(r.out) })
  }
  return docs.get(name)
}

for (const name of /** @type {const} */ (['default', 'demo'])) {
  treeTest(`sweep: the ${name} scaffold sweeps complete, every record closed and sorted by key`, () => {
    const { doc } = docOf(name)
    assert.equal(doc.v, 1)
    assert.match(doc.x, /^[0-9a-f]{12}$/)
    assert.equal(doc.complete, true)
    assert.deepEqual(
      doc.legs.map((l) => `${l.leg}:${String(l.complete)}`),
      ['exact-sql:true', 'exact-ts:true', 'near-miss-sql:true', 'near-miss-ts:true', 'complexity:true'],
    )
    // The document's legs are the registry's, in its order: a family registers in one place.
    assert.deepEqual(
      doc.legs.map((l) => [l.producer, l.leg]),
      SWEEP_FAMILIES.map((f) => [f.producer, f.leg]),
    )
    assert.ok(doc.records.every((r) => SWEEP_FAMILIES.some((f) => f.rules.includes(r.rule))))
    assert.ok(doc.records.length > 0)
    for (const r of doc.records) assert.ok(advisoryRecordOk(r), JSON.stringify(r))
    assert.ok(doc.records.every((r) => r.status === 'advisory'), 'no verdict: every record is advisory')
    assert.ok(isSortedByKey(doc.records))
  })
}

treeTest('sweep: byte-identical under a reversed directory listing, another path, another zone and locale', () => {
  const { raw } = docOf('demo')
  const preload = join(ROOT, 'reverse-readdir.mjs')
  writeFileSync(
    preload,
    `import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const listed = fs.readdirSync
fs.readdirSync = function reversed(...args) {
  const out = listed.apply(this, args)
  return Array.isArray(out) ? [...out].reverse() : out
}
syncBuiltinESMExports()
`,
  )
  const reversed = gate(SCAFFOLDS.demo, ['--sweep', '--json'], { node: ['--import', pathToFileURL(preload).href] })
  assert.equal(reversed.code, 0, reversed.err)
  assert.equal(reversed.out, raw, 'a reversed readdirSync changes nothing')

  const zoned = gate(SCAFFOLDS.demo, ['--sweep', '--json'], {
    env: { TZ: 'Pacific/Kiritimati', LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8' },
  })
  assert.equal(zoned.out, raw, 'the zone and the locale change nothing')

  const moved = join(ROOT, 'elsewhere', 'deeper', 'demo')
  cpSync(SCAFFOLDS.demo, moved, { recursive: true })
  const there = gate(moved, ['--sweep', '--json'])
  assert.equal(there.out, raw, 'the absolute path changes nothing')
})

test('sweep: with no parser the TS legs are incomplete, the run exits 1 and records why', () => {
  const report = join(ROOT, 'parity-report')
  const r = gate(SCAFFOLDS.bare, ['--sweep', '--json'], { env: { HARNESS_PARITY_REPORT_DIR: report } })
  assert.equal(r.code, 1, r.err)
  const doc = JSON.parse(r.out)
  assert.equal(doc.complete, false)
  assert.deepEqual(
    doc.legs.map((l) => `${l.leg}:${String(l.complete)}`),
    ['exact-sql:true', 'exact-ts:false', 'near-miss-sql:true', 'near-miss-ts:false', 'complexity:false'],
  )
  assert.ok(doc.records.every((r) => r.facts.lang === 'sql'), 'the SQL legs still ran')
  const noted = readdirSync(report).flatMap((f) =>
    readFileSync(join(report, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
  )
  assert.deepEqual(noted.map((n) => n.gate), ['duplication'])
})

test('sweep: with no parser the plain run is L0 alone, and L0 still reds a pasted block', () => {
  const dir = join(ROOT, 'bare-red')
  cpSync(SCAFFOLDS.bare, dir, { recursive: true })
  const block = (name) => `export function ${name}(rows: readonly { id: string; title: string; pending: boolean }[]): string {
  const done = rows.filter((r) => !r.pending)
  const waiting = rows.filter((r) => r.pending)
  const names = done.map((r) => r.title.trim()).filter((t) => t.length > 0)
  const head = names.slice(0, 3).join(', ')
  const pendingNote = waiting.length > 0 ? String(waiting.length) : ''
  return String(done.length) + head + pendingNote
}
`
  writeFileSync(join(dir, 'apps/mobile/src/pasted-a.ts'), block('summariseAlpha'))
  writeFileSync(join(dir, 'apps/mobile/src/pasted-b.ts'), block('summariseBeta'))
  const r = gate(dir, [])
  assert.equal(r.code, 1, r.out + r.err)
  assert.match(r.out + r.err, /clone/)
})

test('sweep: --sweep without --json is a usage error', () => {
  const r = gate(SCAFFOLDS.bare, ['--sweep'])
  assert.equal(r.code, 1)
  assert.equal(r.err.trim().split('\n').at(-1), 'duplication: --sweep prints one JSON document; run it as --sweep --json')
})

treeTest('sweep: --explain prints a found record, and nothing outside a code span carries @, # and a digit, or <', () => {
  const { doc } = docOf('demo')
  const [top] = [...doc.records].sort(byRank)
  const key = advisoryKey(top).slice(0, 12)
  const r = gate(SCAFFOLDS.demo, ['--explain', key])
  assert.equal(r.code, 0, r.err)
  assert.ok(r.out.startsWith(`duplication: ${top.rule} \`${key}\` · advisory (no verdict) · tier `), r.out)
  for (const rec of doc.records) {
    const text = NO_CODE_SPANS(explainRecord(rec))
    assert.doesNotMatch(text, /@|#\d|</, explainRecord(rec))
  }
})

test('sweep: --explain on a key no record has, or a malformed key, exits 1 with a fixed line', () => {
  const missing = gate(SCAFFOLDS.bare, ['--explain', '000000000000'])
  assert.equal(missing.code, 1)
  assert.match(missing.err, /duplication: no record has the key `000000000000` \(the sweep was incomplete, so a record may be missing\)\n$/)
  for (const args of [['--explain', 'nothex'], ['--explain', '0123456789AB'], ['--explain']]) {
    const bad = gate(SCAFFOLDS.bare, args)
    assert.equal(bad.code, 1, args.join(' '))
    assert.match(bad.err, /duplication: --explain takes one key12, the 12 hex digits a NOTE or an issue prints\n$/)
  }
})

treeTest('sweep: shorthand expansion leaves the class count of both scaffolds unchanged at every floor', () => {
  for (const name of /** @type {const} */ (['default', 'demo'])) {
    const cwd = process.cwd()
    process.chdir(SCAFFOLDS[name])
    try {
      const counts = (expand) => {
        const pool = extractTree(ts, { expand }).callables.filter((c) => c.lang === 'ts')
        return [12, 20, FLOOR, 40, 70].map((floor) => {
          const by = new Map()
          for (const c of pool.filter((x) => x.tokens >= floor)) by.set(c.alpha, (by.get(c.alpha) ?? 0) + 1)
          return [...by.values()].filter((n) => n >= 2).length
        })
      }
      assert.deepEqual(counts(true), counts(false), name)
    } finally {
      process.chdir(cwd)
    }
  }
})

// ── the dogfood rows, in-process ──────────────────────────────────────────────────
// The plan's rows as fixtures, at their plan paths. Two rows read differently from the plan,
// and the code is right:
//   - Row 4 (`ensure_partitions`) is exact, as the plan says, only once a comment inside a
//     function body ends at its line: the audit copy carries comments the auth_trail copy
//     does not (lib/shapes.mjs tokenises each body from its raw statement).
//   - Row 6 (the cursor codec) is exact-nohome, not LIFT: domain purity
//     (lib/vertical-anatomy.mjs) admits only `zod` and `@app/contracts` into domain/, so no
//     packages/shared home is legal for it under today's laws.

const DENY = (schema) => `CREATE FUNCTION ${schema}.deny_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $deny$
BEGIN
  RAISE EXCEPTION '${schema}.events is append-only (% on % refused)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = '42501',
          HINT = 'Rows are never updated or deleted. Remove history by dropping a partition: ${schema}.drop_partitions_older_than(interval).';
END
$deny$;
`

const ENSURE = (schema, comments) => `CREATE FUNCTION ${schema}.ensure_partitions(_months_ahead int DEFAULT 3)
RETURNS int
LANGUAGE plpgsql
SET search_path = ''
AS $ensure$
DECLARE
  _i int := 0;
  _created int := 0;
  _start date;
  _stop date;
  _name text;
BEGIN
  WHILE _i <= _months_ahead LOOP
    _start := (date_trunc('month', now()) + (_i || ' months')::interval)::date;
    _stop := (_start + interval '1 month')::date;
    _name := 'events_' || to_char(_start, 'YYYY_MM');

    IF to_regclass('${schema}.' || quote_ident(_name)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE ${schema}.%I PARTITION OF ${schema}.events FOR VALUES FROM (%L) TO (%L)',
        _name, _start, _stop
      );
${comments ? "      -- Direct access to a partition is judged by the PARTITION's own RLS, not the\n      -- parent's: verified.\n" : ''}      EXECUTE format('ALTER TABLE ${schema}.%I ENABLE ROW LEVEL SECURITY', _name);
      EXECUTE format('ALTER TABLE ${schema}.%I FORCE ROW LEVEL SECURITY', _name);
${comments ? "      -- Layer 4's per-partition twin. PostgreSQL does not clone TRUNCATE triggers.\n" : ''}      EXECUTE format(
        'CREATE TRIGGER %I BEFORE TRUNCATE ON ${schema}.%I FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.deny_mutation()',
        _name || '_no_truncate', _name
      );
      _created := _created + 1;
    END IF;
    _i := _i + 1;
  END LOOP;
  RETURN _created;
END
$ensure$;
`

const DROP_OLDER = (schema) => `CREATE FUNCTION ${schema}.drop_partitions_older_than(_keep interval DEFAULT interval '24 months')
RETURNS int
LANGUAGE plpgsql
SET search_path = ''
AS $retain$
DECLARE
  _dropped int := 0;
  _rec record;
  _month date;
BEGIN
  FOR _rec IN
    SELECT c.relname
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_inherits i ON i.inhrelid = c.oid
     WHERE i.inhparent = '${schema}.events'::regclass
     ORDER BY c.relname
  LOOP
    _month := to_date(substring(_rec.relname from 'events_([0-9]{4}_[0-9]{2})$'), 'YYYY_MM');
    IF _month IS NOT NULL AND _month < date_trunc('month', now() - _keep) THEN
      EXECUTE format('ALTER TABLE ${schema}.events DETACH PARTITION ${schema}.%I', _rec.relname);
      EXECUTE format('DROP TABLE ${schema}.%I', _rec.relname);
      _dropped := _dropped + 1;
    END IF;
  END LOOP;
  RETURN _dropped;
END
$retain$;
`

const IS_REAL_TIMESTAMP = `const TIMESTAMP_RE = /^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}/
function isRealTimestamp(value: string): boolean {
  if (!TIMESTAMP_RE.test(value)) return false
  const iso = \`\${value.slice(0, 10)}T\${value.slice(11, 19)}\`
  return new Date(\`\${iso}Z\`).toJSON() === \`\${iso}.000Z\`
}
export const isCursorTime = (v: string) => isRealTimestamp(v)
`

const renamed = (src, from, to) => src.replace(`function ${from}(`, `function ${to}(`)
const STORE = (src) => `const listeners = new Set<() => void>()\n${src}\nexport const store = { subscribe }\n`

const DOGFOOD = {
  '.dependency-cruiser.cjs': DEPCRUISE,
  // Row 1: publicCredentials = serverPublicCredentials.
  'packages/platform/supabase/package.json': pkg('@app/supabase'),
  'packages/platform/supabase/src/public-env.ts': `${GOLDEN.publicCredentials[1]}\n`,
  'packages/platform/supabase/src/server-env.ts': `${renamed(GOLDEN.publicCredentials[1], 'publicCredentials', 'serverPublicCredentials')}\n`,
  'packages/platform/supabase/src/browser.ts': "import { publicCredentials } from './public-env.js'\nexport const b = publicCredentials\n",
  'packages/platform/supabase/src/access-token.ts': "import { publicCredentials } from './public-env.js'\nexport const t = publicCredentials\n",
  'packages/platform/supabase/src/cookie-server.ts': "import { serverPublicCredentials } from './server-env.js'\nexport const c = serverPublicCredentials\n",
  // Row 2: the hand-rolled store, copied.
  'apps/mobile/package.json': pkg('mobile'),
  'apps/mobile/src/i18n/index.ts': STORE(GOLDEN.subscribe[1]),
  'apps/mobile/src/theme/theme.ts': STORE(GOLDEN.subscribe[1]),
  // Rows 3 to 5: the two trails' machinery.
  'supabase/migrations/20260202000000_audit.sql': `${DENY('audit')}\n${ENSURE('audit', true)}\n${DROP_OLDER('audit')}`,
  'supabase/migrations/20260816000000_auth_event_trail.sql': `${DENY('auth_trail')}\n${ENSURE('auth_trail', false)}\n${DROP_OLDER('auth_trail')}`,
  // Row 6: the cursor codec, in two verticals' domain/.
  'packages/verticals/notes/package.json': pkg('@app/notes'),
  'packages/verticals/notes/src/domain/cursor.ts': IS_REAL_TIMESTAMP,
  'packages/verticals/push/package.json': pkg('@app/push'),
  'packages/verticals/push/src/domain/cursor.ts': IS_REAL_TIMESTAMP,
  // Row 7: asRowArray.
  'packages/verticals/notes/src/data/rows.ts': `${GOLDEN.asRowArray[1]}\n`,
  'packages/verticals/push/src/data/push-tokens.ts': `${GOLDEN.asRowArray[1]}\n`,
  // Row 8: the invalidCursor mirror.
  'packages/verticals/notes/src/data/errors.ts': `${GOLDEN.invalidCursor[1]}\n`,
  'packages/api/package.json': pkg('@app/api'),
  'packages/api/src/export.ts': `${renamed(GOLDEN.invalidCursor[1], 'invalidCursor', 'invalidExportCursor')}\n`,
  // Row 9: web and native useTheme.
  'packages/design-system/package.json': pkg('@app/design-system'),
  'packages/design-system/src/ThemeProvider.tsx': `${GOLDEN.useTheme[1]}\n`,
  'packages/design-system-native/package.json': pkg('@app/design-system-native'),
  'packages/design-system-native/src/ThemeProvider.tsx': `${GOLDEN.useTheme[1]}\n`,
  // Row 23: noteCreated / noteDeleted.
  'packages/verticals/notes/src/events.ts': `${GOLDEN.noteCreated[1]}\n${renamed(GOLDEN.noteCreated[1], 'noteCreated', 'noteDeleted').replace("'notes.created'", "'notes.deleted'")}\n`,
}

/** [row, a member's name, rule, tier, home, tokens, literal parameters] */
const ROWS = [
  ['1', 'publicCredentials', 'exact', 'owed', 'import', 33, 0],
  ['2', 'subscribe', 'exact', 'owed', 'module', 33, 0],
  ['3', 'audit.deny_mutation', 'exact', 'owed', 'module', 31, 2],
  ['4', 'audit.ensure_partitions', 'exact', 'owed', 'module', 163, 5],
  ['5', 'audit.drop_partitions_older_than', 'exact', 'owed', 'module', 141, 3],
  ['6', 'isRealTimestamp', 'exact-nohome', 'advisory', 'none', 59, 0],
  ['7', 'asRowArray', 'exact-small', 'advisory', undefined, 24, 0],
  ['8', 'invalidCursor', 'exact-small', 'advisory', undefined, 28, 0],
  ['9', 'useTheme', 'exact-small', 'advisory', undefined, 29, 0],
  ['23', 'noteCreated', 'exact', 'owed', 'module', 48, 1],
]

treeTest('sweep: the dogfood rows get the rule, tier, home and literal parameters the plan gives them', () => {
  inTree(DOGFOOD, () => {
    const doc = sweep(ts)
    assert.equal(doc.complete, true)
    for (const r of doc.records) assert.ok(advisoryRecordOk(r), JSON.stringify(r))
    assert.ok(isSortedByKey(doc.records))
    const exact = doc.records.filter((r) => r.rule.startsWith('exact'))
    const got = exact
      .map((r) => {
        const row = ROWS.find(([, name]) => r.facts.members.some((m) => m.name === name))
        return [row?.[0] ?? `unexpected ${r.subject}`, r.rule, r.facts.tier, r.facts.home, r.counts.tokens, r.counts.params]
      })
      .sort((a, b) => Number(a[0]) - Number(b[0]))
    assert.deepEqual(got, ROWS.map(([row, , ...rest]) => [row, ...rest]))
    for (const r of exact) {
      const band = r.rule === 'exact-small' ? [SMALL_FLOOR, FLOOR] : [FLOOR, Infinity]
      assert.ok(r.counts.tokens >= band[0] && r.counts.tokens < band[1], r.subject)
    }
    const one = exact.find((r) => r.facts.home === 'import')
    assert.deepEqual(one?.facts.target, { path: 'packages/platform/supabase/src/public-env.ts', line: 1, name: 'publicCredentials' })
    // Ranked: owed first, the largest owed body (row 4) at the top.
    const ranked = [...doc.records].sort(byRank)
    assert.equal(ranked[0].facts.members[0].name, 'audit.ensure_partitions')
    const firstAdvisory = ranked.findIndex((r) => r.facts.tier !== 'owed')
    assert.ok(ranked.slice(firstAdvisory).every((r) => r.facts.tier !== 'owed'))
  })
})

// Row 10: three error mappers. The notes mapper and the Supabase one share too little to be
// a near-miss pair (Jaccard 0.26 against 0.8), so the sweep never pairs them; their
// "differs at" facts still render the plan's Appendix E golden, byte for byte.
const NOTES_MAPPER = `const INSUFFICIENT_PRIVILEGE = '42501'
const UNIQUE_VIOLATION = '23505'
const FOREIGN_KEY_VIOLATION = '23503'
const CHECK_VIOLATION = '23514'
const PGRST_NO_ROWS = 'PGRST116'
const PGRST_BAD_JWT = 'PGRST301'

export function mapPostgrestFailure(failure: PostgrestFailure, operation: NoteOperation): AppError {
  switch (failure.code) {
    case INSUFFICIENT_PRIVILEGE:
      return appError.rlsDenied({
        relation: NOTES_TABLE,
        message: \`a row-security policy refused the \${operation}\`,
      })
    case PGRST_BAD_JWT:
      return appError.unauthorized({
        code: 'session_expired',
        message: 'the access token was rejected',
      })
    case PGRST_NO_ROWS:
      return missingNote()
    case UNIQUE_VIOLATION:
    case FOREIGN_KEY_VIOLATION:
    case CHECK_VIOLATION:
      return appError.conflict({
        resource: 'note',
        message: \`the \${operation} conflicts with the current state of the note\`,
      })
    default:
      return unclassified(failure, operation)
  }
}
`

const SUPABASE_MAPPER = `const INSUFFICIENT_PRIVILEGE = '42501'
const UNIQUE_VIOLATION = '23505'
const FOREIGN_KEY_VIOLATION = '23503'
const NOT_NULL_VIOLATION = '23502'
const CHECK_VIOLATION = '23514'
const INVALID_TEXT_REPRESENTATION = '22P02'
const QUOTA_EXCEEDED = '53400'
const SERIALIZATION_FAILURE = '40001'
const DEADLOCK_DETECTED = '40P01'
const PGRST_NO_ROWS = 'PGRST116'
const PGRST_BAD_JWT = 'PGRST301'
const PGRST_NO_FUNCTION = 'PGRST202'

export function mapPostgresError(failure: PostgresFailure, context: PostgresErrorContext = {}): AppError {
  switch (failure.code) {
    case INSUFFICIENT_PRIVILEGE:
      return appError.rlsDenied({
        ...(context.relation === undefined ? {} : { relation: context.relation }),
        message: 'a row-security policy refused the write',
      })
    case QUOTA_EXCEEDED:
      return appError.quotaExceeded({ message: 'a per-org quota refused the write' })
    case PGRST_NO_ROWS:
      return readMiss(context.resource)
    case UNIQUE_VIOLATION:
      return appError.conflict({
        ...(context.resource === undefined ? {} : { resource: context.resource }),
        code: 'unique_violation',
        message: 'a row with those values already exists',
      })
    case FOREIGN_KEY_VIOLATION:
      return appError.validation({ code: 'foreign_key_violation', message: 'a referenced record does not exist' })
    case NOT_NULL_VIOLATION:
    case CHECK_VIOLATION:
    case INVALID_TEXT_REPRESENTATION:
      return appError.validation({
        code: 'constraint_violation',
        message: 'the submitted values violate a database constraint',
      })
    case SERIALIZATION_FAILURE:
    case DEADLOCK_DETECTED:
      return appError.conflict({
        ...(context.resource === undefined ? {} : { resource: context.resource }),
        code: 'write_conflict',
        message: 'a concurrent write won the race; re-read and retry',
      })
    case PGRST_BAD_JWT:
      return appError.unauthorized({ code: 'session_expired', message: 'the access token was rejected' })
    case PGRST_NO_FUNCTION:
      return appError.unknown({
        code: 'rpc_not_found',
        message: 'the database function is not exposed by this deployment',
      })
    default:
      return unclassified(failure)
  }
}
`

treeTest("sweep: row 10's differs-at renders the plan's golden, byte for byte", () => {
  inTree(
    {
      'packages/verticals/notes/package.json': pkg('@app/notes'),
      'packages/verticals/notes/src/data/errors.ts': NOTES_MAPPER,
      'packages/platform/supabase/package.json': pkg('@app/supabase'),
      'packages/platform/supabase/src/errors.ts': SUPABASE_MAPPER,
    },
    () => {
      const { callables } = extractTree(ts)
      const a = callables.find((c) => c.name === 'mapPostgrestFailure')
      const b = callables.find((c) => c.name === 'mapPostgresError')
      assert.equal(
        renderDiffersAt(differsAt(ts, a, b)),
        [
          'DIFFERS AT  case `FOREIGN_KEY_VIOLATION`: `appError.conflict` | `appError.validation` · case `CHECK_VIOLATION`: same pair · case `PGRST_NO_ROWS`: `missingNote` | `readMiss`',
          'B ONLY      6 labels in 4 case groups',
        ].join('\n'),
      )
    },
  )
})

treeTest('sweep: --explain names the home and the move in the fixed vocabulary', () => {
  inTree(DOGFOOD, () => {
    const doc = sweep(ts)
    const explain = (name) => explainRecord(doc.records.find((r) => r.rule.startsWith('exact') && r.facts.members.some((m) => m.name === name)))
    const row1 = explain('publicCredentials')
    assert.match(row1, /^duplication: exact `[0-9a-f]{12}` · advisory \(no verdict\) · tier owed$/m)
    assert.match(row1, /^home {7}IMPORT$/m)
    assert.match(
      row1,
      /^move {7}import `publicCredentials` from `packages\/platform\/supabase\/src\/public-env\.ts:1` in every other member's file, and delete their copies$/m,
    )
    assert.match(row1, /^member {5}`packages\/platform\/supabase\/src\/server-env\.ts:1` `serverPublicCredentials`$/m)
    assert.match(
      explain('audit.deny_mutation'),
      /^move {7}one function in schema `private`, added by a forward migration, called by every member with 2 literal parameters$/m,
    )
    assert.match(explain('noteCreated'), /^move {7}one new module in this workspace, called by every member with 1 literal parameter$/m)
    const row6 = explain('isRealTimestamp')
    assert.match(row6, /^home {7}NONE$/m)
    assert.match(row6, /^move {7}none: no module every member may import exists or may be created, so this stays advisory$/m)
    assert.match(explain('asRowArray'), /^facts {6}members 2 · workspaces 2 · tokens 24 · params 0$/m)
  })
  inTree(
    {
      'packages/verticals/notes/package.json': pkg('@app/notes'),
      'packages/verticals/notes/src/data/event.ts': `${GOLDEN.noteCreated[1]}\n`,
      'packages/verticals/tasks/package.json': pkg('@app/tasks'),
      'packages/verticals/tasks/src/data/event.ts': `${GOLDEN.noteCreated[1]}\n`,
    },
    () => {
      const [lift] = sweep(ts).records.filter((r) => r.rule === 'exact')
      assert.match(explainRecord(lift), /^move {7}a new package under `packages\/shared\/` that every member imports$/m)
    },
  )
})

const RAISED = (schema) =>
  DROP_OLDER(schema).replace(
    "      _dropped := _dropped + 1;\n",
    "      RAISE NOTICE 'dropped %', _rec.relname;\n      _dropped := _dropped + 1;\n",
  )
const SUMMARY = (name, extra) => `export function ${name}(rows: readonly { title: string, pending: boolean }[]): string {
  const done = rows.filter((r) => !r.pending)
  const names = done.map((r) => r.title.trim()).filter((t) => t.length > 0)
${extra ? '  const waiting = rows.filter((r) => r.pending).length\n' : ''}  const head = names.slice(0, 3).join(', ')
  return String(done.length) + ' saved: ' + head
}
`

treeTest('sweep: a near-miss pairs two bodies one statement apart, and says which side has it', () => {
  inTree(
    {
      'supabase/migrations/20260101000000_one.sql': DROP_OLDER('one'),
      'supabase/migrations/20260102000000_two.sql': RAISED('two'),
      'packages/k/package.json': pkg('@app/k'),
      'packages/k/src/a.ts': SUMMARY('summariseDone', false),
      'packages/k/src/b.ts': SUMMARY('summariseAll', true),
    },
    () => {
      const near = sweep(ts).records.filter((r) => r.rule === 'near-miss')
      const by = (lang) => near.find((r) => r.facts.lang === lang)
      assert.equal(near.length, 2, JSON.stringify(near.map((r) => r.subject)))
      // The pair is ordered by subject; the extra statement is on whichever side holds it.
      assert.equal(by('ts')?.subject, '@app/k#summariseAll @app/k#summariseDone')
      assert.deepEqual([by('ts')?.facts.aOnly.statements, by('ts')?.facts.bOnly.statements], [1, 0])
      assert.equal(by('sql')?.subject, 'sql:one.drop_partitions_older_than sql:two.drop_partitions_older_than')
      assert.deepEqual([by('sql')?.facts.aOnly.statements, by('sql')?.facts.bOnly.statements], [0, 1])
      for (const r of near) {
        assert.ok(r.facts.jaccard >= NEAR_MISS.jaccard && r.facts.jaccard < 1, String(r.facts.jaccard))
        assert.deepEqual(r.facts.arms, [])
        const text = explainRecord(r)
        assert.match(text, /^DIFFERS AT {2}none$/m)
        assert.match(text, / · aOnly \(labels 0, groups 0, statements [01]\) · bOnly \(labels 0, groups 0, statements [01]\)$/m)
      }
    },
  )
})

treeTest('sweep: a record the closed schema refuses is dropped, and its leg is incomplete', () => {
  // A space is outside the closed path printer, so a class in `odd dir/` cannot be printed.
  inTree(
    {
      'packages/k/package.json': pkg('@app/k'),
      'packages/k/src/odd dir/a.ts': `${GOLDEN.noteCreated[1]}\n`,
      'packages/k/src/odd dir/b.ts': `${renamed(GOLDEN.noteCreated[1], 'noteCreated', 'noteDeleted')}\n`,
    },
    () => {
      const doc = sweep(ts)
      assert.equal(doc.legs.find((l) => l.leg === 'exact-ts')?.complete, false)
      assert.equal(doc.complete, false)
      assert.ok(!JSON.stringify(doc.records).includes('odd dir'))
    },
  )
})

treeTest('sweep: sweepMain prints the document and an explain in-process, and fails closed', (t) => {
  const out = []
  t.mock.method(process.stdout, 'write', (s) => out.push(String(s)) > 0)
  t.mock.method(console, 'log', (s) => out.push(`${String(s)}\n`))
  t.mock.method(console, 'error', () => {})
  const run = (argv, load) => {
    out.length = 0
    return sweepMain(argv, load)
  }
  return inTree(DOGFOOD, async () => {
    assert.equal(await run(['--sweep', '--json'], () => ts), 0)
    const doc = JSON.parse(out.join(''))
    assert.deepEqual(doc, sweep(ts))
    const r = doc.records.find((x) => x.rule === 'exact')
    assert.equal(await run(['--explain', advisoryKey(r).slice(0, 12)], () => ts), 0)
    assert.equal(out.join(''), `${explainRecord(r)}\n`)
    assert.equal(await run(['--explain', 'zz'], () => ts), 1)
    assert.equal(await run(['--sweep'], () => ts), 1)
    const absent = () => {
      throw new Error('no typescript here')
    }
    assert.equal(await run(['--sweep', '--json'], absent), 1)
    assert.equal(JSON.parse(out.join('')).complete, false)
  })
})
