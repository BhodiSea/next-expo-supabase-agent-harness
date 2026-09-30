// Proofs for the pgTAP fixture regions (1.1.0, N08). The three behavioural suites
// (rls_isolation, mfa_aal2, audit_immutability) prove the security rails on a table they
// build inside their own transaction, public.pgtap_fixture, rather than on the worked
// example. A fixture whose DDL drifts from the taught shape proves nothing about the
// shape a project copies, so this file ties each fixture region to the RLS skeleton in
// the authoring-vertical-slice skill (migration-rls.md, whose policy half is generated
// from 20_notes.sql) and each suite's one addition to the source it copies.
//
// The rules run as ONE PURE FUNCTION over file text (judgeFixtures): no database, no
// spawn. They are:
//   1. each suite carries exactly one `-- fixture:begin` / `-- fixture:end` region, and it
//      opens before the suite's first role switch (the fixture is the migration role's);
//   2. the region matches the skeleton once `<t>` and the policy half's `notes` read
//      pgtap_fixture and comments, whitespace and CRLF are normalised: every skeleton
//      statement but CREATE TABLE is present; the CREATE TABLE keeps every skeleton
//      column line and adds only the slice columns title and body of 20_notes.sql; and
//      nothing else is in the region except the suite's one addition;
//   3. that addition equals its source after the same renaming: the MFA rail of
//      20_notes.sql in mfa_aal2, the notes audit trigger of the audit migration in
//      audit_immutability; rls_isolation has none;
//   4. no suite creates, replaces, alters or drops a function in the private or audit
//      schema, so the fixture runs on the real member_org_ids(), member_ranks(),
//      mfa_satisfied() and write_row();
//   5. public.notes appears only in the recursion probe (the statement whose description
//      reads "no policy recurses"), comments included.
// Every rule has its own failing input below, built by planting one defect in the
// shipped text and asserting the unplanted text is green first.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const STACK_SUPABASE = fileURLToPath(new URL('../../template/stack/supabase', import.meta.url))
const SKELETON_MD = fileURLToPath(
  new URL(
    '../../template/base/.claude/skills/authoring-vertical-slice/references/migration-rls.md',
    import.meta.url,
  ),
)
const NOTES_SCHEMA = join(STACK_SUPABASE, 'schemas', '20_notes.sql')
const AUDIT_MIGRATION = join(STACK_SUPABASE, 'migrations', '20260202000000_audit.sql')

const FIXTURE = 'pgtap_fixture'
const BEGIN = '-- fixture:begin'
const END = '-- fixture:end'
const SLICE_COLUMNS = ['title', 'body']

/** @typedef {'mfaRail' | 'auditTrigger' | null} AdditionKey */
/** @typedef {{ name: string, addition: AdditionKey, text: string }} Suite */

/** @type {{ name: string, addition: AdditionKey }[]} */
const SUITES = [
  { name: 'rls_isolation.test.sql', addition: null },
  { name: 'mfa_aal2.test.sql', addition: 'mfaRail' },
  { name: 'audit_immutability.test.sql', addition: 'auditTrigger' },
]

const ADDITIONS = {
  mfaRail: {
    label: 'the MFA rail',
    file: 'supabase/schemas/20_notes.sql',
    head: 'CREATE POLICY notes_mfa_aal2 ',
  },
  auditTrigger: {
    label: 'the audit trigger',
    file: 'supabase/migrations/20260202000000_audit.sql',
    head: 'CREATE TRIGGER notes_audit ',
  },
}

// ─── text normalisation ──────────────────────────────────────────────────────

/** @param {string} text */
const lf = (text) => text.replace(/\r\n?/g, '\n')
/** @param {string} s */
const squash = (s) => s.replace(/\s+/g, ' ').trim()

const DOLLAR_TAG = /\$[A-Za-z_]*\$/y

/**
 * The index just past a quoted run ('…', "…" or $tag$…$tag$) that starts at i, or i itself
 * when no quoted run starts there.
 * @param {string} text @param {number} i
 */
function quotedEnd(text, i) {
  const c = text[i]
  if (c === "'" || c === '"') {
    let j = i + 1
    while (j < text.length) {
      if (text[j] !== c) j += 1
      else if (text[j + 1] === c) j += 2
      else return j + 1
    }
    return text.length
  }
  if (c !== '$') return i
  DOLLAR_TAG.lastIndex = i
  const tag = DOLLAR_TAG.exec(text)?.[0]
  if (tag === undefined) return i
  const close = text.indexOf(tag, i + tag.length)
  return close === -1 ? text.length : close + tag.length
}

/**
 * `--` comments removed, quoted runs kept intact.
 * @param {string} text
 */
function stripComments(text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const skip = quotedEnd(text, i)
    if (skip > i) {
      out += text.slice(i, skip)
      i = skip
    } else if (text.startsWith('--', i)) {
      const nl = text.indexOf('\n', i)
      i = nl === -1 ? text.length : nl
    } else {
      out += text[i]
      i += 1
    }
  }
  return out
}

/**
 * Split on a separator character outside quotes and outside parentheses deeper than the
 * starting depth. Used for statements (`;`) and for a CREATE TABLE's items (`,`).
 * @param {string} text @param {string} sep
 */
function splitTopLevel(text, sep) {
  const parts = []
  let depth = 0
  let start = 0
  let i = 0
  while (i < text.length) {
    const skip = quotedEnd(text, i)
    if (skip > i) {
      i = skip
      continue
    }
    const c = text[i]
    if (c === '(') depth += 1
    else if (c === ')') depth -= 1
    else if (c === sep && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
    i += 1
  }
  parts.push(text.slice(start))
  return parts.map(squash).filter((s) => s !== '')
}

/**
 * SQL text to its statements: CRLF folded, comments dropped, whitespace squashed.
 * @param {string} text
 */
const statementsOf = (text) => splitTopLevel(stripComments(lf(text)), ';')

/**
 * The example's names to the fixture's: the skeleton's `<t>`, and `notes` as a whole
 * identifier or an identifier prefix (notes_select_org, public.notes).
 * @param {string} stmt
 */
const toFixture = (stmt) =>
  stmt.replaceAll('<t>', FIXTURE).replace(/(?<![A-Za-z0-9_])notes(?![A-Za-z0-9])/g, FIXTURE)

/** @param {string} stmt */
const isCreateTable = (stmt) => /^CREATE TABLE /i.test(stmt)

/** @param {string} stmt */
function tableParts(stmt) {
  const open = stmt.indexOf('(')
  const close = stmt.lastIndexOf(')')
  if (open === -1 || close < open) return { head: stmt, items: [] }
  return {
    head: squash(stmt.slice(0, open)),
    items: splitTopLevel(stmt.slice(open + 1, close), ','),
  }
}

/** @param {string} s */
const clip = (s) => (s.length > 160 ? `${s.slice(0, 157)}...` : s)

// ─── the model: what every fixture region must be ────────────────────────────

/**
 * Every ```sql fenced block of a markdown file, with the 0-based line its fence opens on.
 * @param {string[]} lines
 */
function fencedSql(lines) {
  const blocks = []
  let open = -1
  lines.forEach((line, at) => {
    const t = line.trim()
    if (open === -1 && t === '```sql') open = at
    else if (open !== -1 && t === '```') {
      blocks.push({ at: open, body: lines.slice(open + 1, at).join('\n') })
      open = -1
    }
  })
  return blocks
}

/**
 * The skeleton's two halves: the hand-written block that creates `public.<t>`, and the
 * block inside the generated org-policies region.
 * @param {string} md @param {string[]} problems
 */
function skeletonBlocks(md, problems) {
  const lines = lf(md).split('\n')
  const blocks = fencedSql(lines)
  const hand = blocks.filter((b) => b.body.includes('CREATE TABLE public.<t>'))
  const begin = lines.findIndex((l) => l.startsWith('<!-- skill-region:begin org-policies '))
  const end = lines.findIndex((l) => l.startsWith('<!-- skill-region:end org-policies '))
  const policy = blocks.filter((b) => begin !== -1 && b.at > begin && b.at < end)
  if (hand.length !== 1) {
    problems.push(
      `migration-rls.md: expected one sql block creating public.<t> (the skeleton's hand-written half), found ${String(hand.length)}`,
    )
  }
  if (policy.length !== 1) {
    problems.push(
      `migration-rls.md: expected one sql block inside the org-policies region (the skeleton's policy half), found ${String(policy.length)}`,
    )
  }
  return [...hand, ...policy].map((b) => b.body).join('\n')
}

/**
 * The slice columns the moved assertions write, as 20_notes.sql declares them.
 * @param {string} schema @param {string[]} problems
 */
function sliceColumns(schema, problems) {
  const table = statementsOf(schema).find((s) => s.startsWith('CREATE TABLE public.notes '))
  const items = table === undefined ? [] : tableParts(table).items
  return SLICE_COLUMNS.map((col) => {
    const item = items.find((i) => i.startsWith(`${col} `))
    if (item === undefined) problems.push(`20_notes.sql: CREATE TABLE public.notes has no '${col}' column`)
    return item ?? `${col} <missing>`
  })
}

/**
 * One addition's source statement, renamed to the fixture.
 * @param {string} text @param {{ label: string, file: string, head: string }} spec
 * @param {string[]} problems
 */
function additionFrom(text, spec, problems) {
  const found = statementsOf(text).filter((s) => s.startsWith(spec.head))
  if (found.length !== 1) {
    problems.push(`${spec.file}: expected one '${spec.head.trim()}' statement (${spec.label}), found ${String(found.length)}`)
    return `${spec.label} <missing>`
  }
  return toFixture(found[0])
}

/**
 * @param {{ skeleton: string, notesSchema: string, auditMigration: string }} src
 */
function buildModel(src) {
  /** @type {string[]} */
  const problems = []
  const skeleton = statementsOf(skeletonBlocks(src.skeleton, problems)).map(toFixture)
  const tables = skeleton.filter(isCreateTable)
  if (tables.length !== 1) {
    problems.push(`migration-rls.md: the skeleton must carry exactly one CREATE TABLE, found ${String(tables.length)}`)
  }
  return {
    problems,
    statements: skeleton.filter((s) => !isCreateTable(s)),
    table: tableParts(tables[0] ?? ''),
    slice: sliceColumns(src.notesSchema, problems),
    additions: {
      mfaRail: additionFrom(src.notesSchema, ADDITIONS.mfaRail, problems),
      auditTrigger: additionFrom(src.auditMigration, ADDITIONS.auditTrigger, problems),
    },
  }
}

/** @typedef {ReturnType<typeof buildModel>} Model */

// ─── the rules ───────────────────────────────────────────────────────────────

const MARKER_MENTION = /fixture:(?:begin|end)\b/
const ROLE_SWITCH = /\bSET\s+(?:LOCAL\s+)?ROLE\b|set_config\(\s*'role'/i
const RAIL_FUNCTION = /\b(CREATE(?:\s+OR\s+REPLACE)?|ALTER|DROP)\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?"?(private|audit)"?\s*\.\s*"?(\w+)/gi

/**
 * Rule 1: exactly one well-formed region, opening before the first role switch.
 * @param {string} name @param {string[]} lines @param {string[]} problems
 */
function findRegion(name, lines, problems) {
  const begins = []
  const ends = []
  lines.forEach((line, at) => {
    const t = line.trim()
    if (t === BEGIN) begins.push(at)
    else if (t === END) ends.push(at)
    else if (MARKER_MENTION.test(line)) {
      problems.push(`${name}:${String(at + 1)}: this line names a fixture marker but is not one — write '${BEGIN}' or '${END}' alone on its line`)
    }
  })
  if (begins.length !== 1 || ends.length !== 1) {
    problems.push(`${name}: expected exactly one '${BEGIN}' / '${END}' region, found ${String(begins.length)} begin and ${String(ends.length)} end marker(s)`)
    return null
  }
  if (ends[0] < begins[0]) {
    problems.push(`${name}: '${END}' (line ${String(ends[0] + 1)}) comes before '${BEGIN}' (line ${String(begins[0] + 1)})`)
    return null
  }
  return { begin: begins[0], end: ends[0] }
}

/**
 * @param {string} name @param {string[]} lines @param {{ begin: number }} region
 * @param {string[]} problems
 */
function judgePlacement(name, lines, region, problems) {
  const first = lines.findIndex((l) => ROLE_SWITCH.test(l.replace(/--.*$/, '')))
  if (first !== -1 && first < region.begin) {
    problems.push(`${name}: the fixture region opens at line ${String(region.begin + 1)}, after the suite's first role switch at line ${String(first + 1)} — build the fixture as the migration role, before any role switch`)
  }
}

/**
 * Rule 2, the CREATE TABLE half: every skeleton column line kept, only the slice columns
 * added.
 * @param {string} name @param {string | undefined} stmt @param {Model} model
 * @param {string[]} problems
 */
function judgeTable(name, stmt, model, problems) {
  if (stmt === undefined) {
    problems.push(`${name}: the fixture region has no CREATE TABLE`)
    return
  }
  const { head, items } = tableParts(stmt)
  if (head !== model.table.head) {
    problems.push(`${name}: the fixture's CREATE TABLE must open '${model.table.head} (', found '${head} ('`)
  }
  for (const item of model.table.items) {
    if (!items.includes(item)) problems.push(`${name}: the fixture's CREATE TABLE lacks the skeleton's line '${item}'`)
  }
  for (const item of model.slice) {
    if (!items.includes(item)) problems.push(`${name}: the fixture's CREATE TABLE lacks the slice column '${item}' of 20_notes.sql`)
  }
  for (const item of items) {
    if (!model.table.items.includes(item) && !model.slice.includes(item)) {
      problems.push(`${name}: the fixture's CREATE TABLE carries '${item}', which is neither a skeleton line nor a slice column (${SLICE_COLUMNS.join(', ')}) of 20_notes.sql`)
    }
  }
}

/**
 * Remove one occurrence of each expected statement; what is left was not expected.
 * @param {string[]} have @param {string[]} expected
 */
function takeEach(have, expected) {
  const left = [...have]
  const missing = []
  for (const stmt of expected) {
    const at = left.indexOf(stmt)
    if (at === -1) missing.push(stmt)
    else left.splice(at, 1)
  }
  return { missing, left }
}

/**
 * Rules 2 and 3 over the region's statements.
 * @param {Suite} suite @param {string} regionText @param {Model} model
 * @param {string[]} problems
 */
function judgeRegion(suite, regionText, model, problems) {
  const stmts = statementsOf(regionText)
  const tables = stmts.filter(isCreateTable)
  judgeTable(suite.name, tables[0], model, problems)
  const addition = suite.addition === null ? [] : [model.additions[suite.addition]]
  const { missing, left } = takeEach(
    stmts.filter((s) => s !== tables[0]),
    [...model.statements, ...addition],
  )
  for (const stmt of missing) {
    const spec = suite.addition === null ? undefined : ADDITIONS[suite.addition]
    const what = stmt === addition[0] && spec !== undefined
      ? `${spec.label} as written in ${spec.file}, renamed to ${FIXTURE}`
      : 'the skeleton statement'
    problems.push(`${suite.name}: the fixture region lacks ${what}: ${clip(stmt)}`)
  }
  for (const stmt of left) {
    problems.push(`${suite.name}: the fixture region carries a statement that is neither the skeleton's nor the suite's one addition: ${clip(stmt)}`)
  }
}

/**
 * Rule 4.
 * @param {string} name @param {string} text @param {string[]} problems
 */
function judgeRailFunctions(name, text, problems) {
  for (const m of stripComments(lf(text)).matchAll(RAIL_FUNCTION)) {
    problems.push(`${name}: ${m[1].toUpperCase()} FUNCTION ${m[2]}.${m[3]} — the fixture must run on the real rail functions, so no suite defines or changes one in the ${m[2]} schema`)
  }
}

/**
 * The recursion probe's lines: the statement whose description reads "no policy recurses".
 * @param {string[]} lines
 */
function probeSpan(lines) {
  const at = lines.findIndex((l) => l.includes("'no policy recurses"))
  if (at === -1) return null
  let start = at
  while (start > 0 && !/^SELECT\b/.test(lines[start])) start -= 1
  let end = at
  while (end < lines.length - 1 && !/;\s*$/.test(lines[end])) end += 1
  return { start, end }
}

/**
 * Rule 5.
 * @param {string} name @param {string[]} lines @param {string[]} problems
 */
function judgeExampleMentions(name, lines, problems) {
  const probe = probeSpan(lines)
  lines.forEach((line, at) => {
    if (!/\bpublic\.notes\b/.test(line)) return
    if (probe !== null && at >= probe.start && at <= probe.end) return
    problems.push(`${name}:${String(at + 1)}: names public.notes outside the recursion probe — a behavioural assertion belongs on ${FIXTURE}, and only the probe reads the real table`)
  })
}

/**
 * @param {Suite} suite @param {Model} model
 * @returns {string[]}
 */
function judgeSuite(suite, model) {
  /** @type {string[]} */
  const problems = []
  const lines = lf(suite.text).split('\n')
  const region = findRegion(suite.name, lines, problems)
  if (region !== null) {
    judgePlacement(suite.name, lines, region, problems)
    judgeRegion(suite, lines.slice(region.begin + 1, region.end).join('\n'), model, problems)
  }
  judgeRailFunctions(suite.name, suite.text, problems)
  judgeExampleMentions(suite.name, lines, problems)
  return problems
}

/**
 * The whole judgement, as a pure function over file text.
 * @param {{ skeleton: string, notesSchema: string, auditMigration: string, suites: Suite[] }} input
 * @returns {string[]}
 */
function judgeFixtures(input) {
  const model = buildModel(input)
  if (model.problems.length > 0) return model.problems
  return input.suites.flatMap((suite) => judgeSuite(suite, model))
}

// ─── the shipped tree, and planted defects ───────────────────────────────────

/** @param {string} path */
const read = (path) => readFileSync(path, 'utf8')

function shipped() {
  return {
    skeleton: read(SKELETON_MD),
    notesSchema: read(NOTES_SCHEMA),
    auditMigration: read(AUDIT_MIGRATION),
    suites: SUITES.map((s) => ({ ...s, text: read(join(STACK_SUPABASE, 'tests', s.name)) })),
  }
}

/**
 * Replace exactly one occurrence, or throw: a case whose anchor moved must fail loudly
 * rather than plant nothing and pass vacuously.
 * @param {string} text @param {string} from @param {string} to
 */
function replaceOnce(text, from, to) {
  const at = text.indexOf(from)
  assert.ok(at !== -1, `anchor not found: ${from}`)
  assert.equal(text.indexOf(from, at + 1), -1, `anchor not unique: ${from}`)
  return text.slice(0, at) + to + text.slice(at + from.length)
}

/**
 * The shipped input with one suite's text rewritten.
 * @param {string} name @param {(text: string) => string} edit
 */
function withSuite(name, edit) {
  const input = shipped()
  input.suites = input.suites.map((s) => (s.name === name ? { ...s, text: edit(s.text) } : s))
  return input
}

/**
 * Green before the plant, red after it, and red for the stated reason.
 * @param {ReturnType<typeof shipped>} planted @param {RegExp} reason
 */
function assertRed(planted, reason) {
  assert.deepEqual(judgeFixtures(shipped()), [], 'the unplanted tree must be green first')
  const problems = judgeFixtures(planted)
  assert.ok(
    problems.some((p) => reason.test(p)),
    `expected a problem matching ${String(reason)}, got:\n${problems.join('\n')}`,
  )
}

// ─── live ────────────────────────────────────────────────────────────────────

test('LIVE: the three shipped suites satisfy every fixture rule', () => {
  const problems = judgeFixtures(shipped())
  assert.deepEqual(problems, [], problems.join('\n'))
})

test('LIVE: the model is not vacuous — the skeleton, the slice columns and both additions resolve', () => {
  const input = shipped()
  const model = buildModel(input)
  assert.deepEqual(model.problems, [])
  const policies = model.statements.filter((s) => s.startsWith(`CREATE POLICY ${FIXTURE}_`))
  assert.equal(policies.length, 4, 'the four permissive policies of the policy half')
  assert.ok(model.statements.includes(`ALTER TABLE public.${FIXTURE} FORCE ROW LEVEL SECURITY`))
  assert.ok(model.table.items.some((i) => i.startsWith('org_id uuid NOT NULL REFERENCES public.orgs')))
  assert.deepEqual(model.slice, ['title text NOT NULL', "body text NOT NULL DEFAULT ''"])
  assert.match(model.additions.mfaRail, /^CREATE POLICY pgtap_fixture_mfa_aal2 ON public\.pgtap_fixture AS RESTRICTIVE /)
  assert.match(model.additions.auditTrigger, /^CREATE TRIGGER pgtap_fixture_audit .* ON public\.pgtap_fixture .*audit\.write_row\('org_id', 'id'\)$/)
})

test('LIVE: public.notes is named once in rls_isolation (the recursion probe) and never in the other two', () => {
  const counts = shipped().suites.map((s) => [s.name, (s.text.match(/\bpublic\.notes\b/g) ?? []).length])
  assert.deepEqual(counts, [
    ['rls_isolation.test.sql', 1],
    ['mfa_aal2.test.sql', 0],
    ['audit_immutability.test.sql', 0],
  ])
})

test('CRLF: the shipped suites, skeleton and sources judged with CRLF line endings are still green', () => {
  const input = shipped()
  /** @param {string} t */
  const crlf = (t) => t.replace(/\n/g, '\r\n')
  const problems = judgeFixtures({
    skeleton: crlf(input.skeleton),
    notesSchema: crlf(input.notesSchema),
    auditMigration: crlf(input.auditMigration),
    suites: input.suites.map((s) => ({ ...s, text: crlf(s.text) })),
  })
  assert.deepEqual(problems, [], problems.join('\n'))
})

// ─── rule 1: one region, before the first role switch ────────────────────────

test('rule 1: a suite with no fixture region is red', () => {
  const planted = withSuite('rls_isolation.test.sql', (t) =>
    replaceOnce(replaceOnce(t, `${BEGIN}\n`, ''), `${END}\n`, ''),
  )
  assertRed(planted, /^rls_isolation\.test\.sql: expected exactly one '-- fixture:begin' \/ '-- fixture:end' region, found 0 begin and 0 end/)
})

test('rule 1: a second region is red', () => {
  const planted = withSuite('mfa_aal2.test.sql', (t) =>
    replaceOnce(t, 'SELECT * FROM finish();', `${BEGIN}\n${END}\nSELECT * FROM finish();`),
  )
  assertRed(planted, /^mfa_aal2\.test\.sql: expected exactly one .* found 2 begin and 2 end/)
})

test('rule 1: a marker that does not parse is red, never read as prose', () => {
  const planted = withSuite('audit_immutability.test.sql', (t) =>
    replaceOnce(t, `${END}\n`, `-- fixture:end of the fixture\n`),
  )
  assertRed(planted, /^audit_immutability\.test\.sql:\d+: this line names a fixture marker but is not one/)
})

test('rule 1: a region that opens after the first role switch is red', () => {
  const planted = withSuite('rls_isolation.test.sql', (t) =>
    replaceOnce(t, `${BEGIN}\n`, `SET LOCAL ROLE authenticated;\n${BEGIN}\n`),
  )
  assertRed(planted, /^rls_isolation\.test\.sql: the fixture region opens at line \d+, after the suite's first role switch/)
})

// ─── rule 2: the region is the skeleton ──────────────────────────────────────

test('rule 2: a region missing a skeleton statement (FORCE) is red, naming it', () => {
  const planted = withSuite('rls_isolation.test.sql', (t) =>
    replaceOnce(t, `ALTER TABLE public.${FIXTURE} FORCE ROW LEVEL SECURITY;\n`, ''),
  )
  assertRed(planted, /^rls_isolation\.test\.sql: the fixture region lacks the skeleton statement: ALTER TABLE public\.pgtap_fixture FORCE ROW LEVEL SECURITY$/)
})

test('rule 2: a loosened policy predicate is red — the taught floor is missing and the loose one is foreign', () => {
  const planted = withSuite('mfa_aal2.test.sql', (t) =>
    replaceOnce(
      t,
      `CREATE POLICY ${FIXTURE}_insert_org ON public.${FIXTURE}\n  AS PERMISSIVE FOR INSERT TO authenticated\n  WITH CHECK (coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0) >= 20);`,
      `CREATE POLICY ${FIXTURE}_insert_org ON public.${FIXTURE}\n  AS PERMISSIVE FOR INSERT TO authenticated\n  WITH CHECK (coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0) >= 10);`,
    ),
  )
  assertRed(planted, /^mfa_aal2\.test\.sql: the fixture region lacks the skeleton statement: CREATE POLICY pgtap_fixture_insert_org /)
  assert.ok(judgeFixtures(planted).some((p) => /carries a statement that is neither .*>= 10\)$/.test(p)))
})

test("rule 2: a CREATE TABLE that drops a skeleton column line's constraint is red", () => {
  const planted = withSuite('audit_immutability.test.sql', (t) =>
    replaceOnce(
      t,
      '  org_id uuid NOT NULL REFERENCES public.orgs (id) ON DELETE CASCADE,\n',
      '  org_id uuid REFERENCES public.orgs (id) ON DELETE CASCADE,\n',
    ),
  )
  assertRed(planted, /^audit_immutability\.test\.sql: the fixture's CREATE TABLE lacks the skeleton's line 'org_id uuid NOT NULL REFERENCES public\.orgs \(id\) ON DELETE CASCADE'$/)
})

test('rule 2: a CREATE TABLE with a column beyond the slice columns is red', () => {
  const planted = withSuite('rls_isolation.test.sql', (t) =>
    replaceOnce(t, "  body text NOT NULL DEFAULT '',\n", "  body text NOT NULL DEFAULT '',\n  archived_at timestamptz,\n"),
  )
  assertRed(planted, /^rls_isolation\.test\.sql: the fixture's CREATE TABLE carries 'archived_at timestamptz', which is neither/)
})

test('rule 2: a slice column without its default is red — three inserts omit body', () => {
  const planted = withSuite('rls_isolation.test.sql', (t) =>
    replaceOnce(t, "  body text NOT NULL DEFAULT '',\n", '  body text NOT NULL,\n'),
  )
  assertRed(planted, /^rls_isolation\.test\.sql: the fixture's CREATE TABLE lacks the slice column 'body text NOT NULL DEFAULT '''/)
})

test('rule 2: a statement the skeleton does not teach is red, even a harmless-looking policy', () => {
  const planted = withSuite('rls_isolation.test.sql', (t) =>
    replaceOnce(
      t,
      `${END}\n`,
      `CREATE POLICY ${FIXTURE}_all ON public.${FIXTURE} AS PERMISSIVE FOR SELECT TO authenticated USING (true);\n${END}\n`,
    ),
  )
  assertRed(planted, /^rls_isolation\.test\.sql: the fixture region carries a statement that is neither the skeleton's nor the suite's one addition: CREATE POLICY pgtap_fixture_all /)
})

test('rule 2: the skeleton is the source — editing it reds all three fixtures', () => {
  const input = shipped()
  input.skeleton = replaceOnce(
    input.skeleton,
    '  ON public.<t> (org_id, created_at DESC, id DESC);',
    '  ON public.<t> (created_at DESC, org_id, id DESC);',
  )
  const problems = judgeFixtures(input)
  for (const { name } of SUITES) {
    assert.ok(
      problems.some((p) => p.startsWith(`${name}: the fixture region lacks the skeleton statement: CREATE INDEX`)),
      `${name} should red on the edited skeleton index:\n${problems.join('\n')}`,
    )
  }
})

test("rule 2: the skeleton's policy half counts too — a drifted org-policies region reds the fixtures", () => {
  const input = shipped()
  input.skeleton = replaceOnce(
    input.skeleton,
    'CREATE POLICY notes_select_org ON public.notes\n  AS PERMISSIVE FOR SELECT TO authenticated\n',
    'CREATE POLICY notes_select_org ON public.notes\n  AS PERMISSIVE FOR SELECT TO authenticated, anon\n',
  )
  const problems = judgeFixtures(input)
  assert.ok(problems.some((p) => /^rls_isolation\.test\.sql: the fixture region lacks the skeleton statement: CREATE POLICY pgtap_fixture_select_org ON public\.pgtap_fixture AS PERMISSIVE FOR SELECT TO authenticated, anon/.test(p)), problems.join('\n'))
})

// ─── rule 3: the one addition equals its source ──────────────────────────────

test('rule 3: an MFA rail that differs from 20_notes.sql is red (USING only)', () => {
  const planted = withSuite('mfa_aal2.test.sql', (t) =>
    replaceOnce(t, '  USING ((SELECT private.mfa_satisfied()))\n  WITH CHECK ((SELECT private.mfa_satisfied()));', '  USING ((SELECT private.mfa_satisfied()));'),
  )
  assertRed(planted, /^mfa_aal2\.test\.sql: the fixture region lacks the MFA rail as written in supabase\/schemas\/20_notes\.sql, renamed to pgtap_fixture: CREATE POLICY pgtap_fixture_mfa_aal2 /)
})

test('rule 3: a suite that drops its addition is red — the audit trigger is required, not optional', () => {
  const planted = withSuite('audit_immutability.test.sql', (t) =>
    replaceOnce(
      t,
      `CREATE TRIGGER ${FIXTURE}_audit\n  AFTER INSERT OR UPDATE OR DELETE ON public.${FIXTURE}\n  FOR EACH ROW EXECUTE FUNCTION audit.write_row('org_id', 'id');\n`,
      '',
    ),
  )
  assertRed(planted, /^audit_immutability\.test\.sql: the fixture region lacks the audit trigger as written in supabase\/migrations\/20260202000000_audit\.sql/)
})

test("rule 3: an audit trigger with other arguments than the source's is red", () => {
  const planted = withSuite('audit_immutability.test.sql', (t) =>
    replaceOnce(t, "audit.write_row('org_id', 'id');", "audit.write_row('org_id', 'id', 'title');"),
  )
  assertRed(planted, /^audit_immutability\.test\.sql: the fixture region lacks the audit trigger/)
})

test("rule 3: a suite's addition is its own — the MFA rail in rls_isolation is red", () => {
  const rail = buildModel(shipped()).additions.mfaRail
  const planted = withSuite('rls_isolation.test.sql', (t) => replaceOnce(t, `${END}\n`, `${rail};\n${END}\n`))
  assertRed(planted, /^rls_isolation\.test\.sql: the fixture region carries a statement that is neither .*: CREATE POLICY pgtap_fixture_mfa_aal2 /)
})

test('rule 3: the source is read, not remembered — editing the rail in 20_notes.sql reds mfa_aal2', () => {
  const input = shipped()
  input.notesSchema = replaceOnce(input.notesSchema, '  AS RESTRICTIVE TO authenticated\n', '  AS RESTRICTIVE TO authenticated, anon\n')
  const problems = judgeFixtures(input)
  assert.ok(problems.some((p) => p.startsWith('mfa_aal2.test.sql: the fixture region lacks the MFA rail')), problems.join('\n'))
})

// ─── rule 4: the real rail functions ─────────────────────────────────────────

test('rule 4: a suite that replaces private.member_org_ids() is red', () => {
  const planted = withSuite('rls_isolation.test.sql', (t) =>
    replaceOnce(
      t,
      `${BEGIN}\n`,
      "CREATE OR REPLACE FUNCTION private.member_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $f$ SELECT array_agg(id) FROM public.orgs $f$;\n" + `${BEGIN}\n`,
    ),
  )
  assertRed(planted, /^rls_isolation\.test\.sql: CREATE OR REPLACE FUNCTION private\.member_org_ids — the fixture must run on the real rail functions/)
})

test('rule 4: a suite that redefines audit.write_row() inside a quoted EXECUTE is red too', () => {
  const planted = withSuite('audit_immutability.test.sql', (t) =>
    replaceOnce(
      t,
      'SELECT * FROM finish();',
      "DO $x$ BEGIN EXECUTE 'CREATE OR REPLACE FUNCTION audit.write_row() RETURNS trigger LANGUAGE plpgsql AS $b$ BEGIN RETURN NULL; END $b$'; END $x$;\nSELECT * FROM finish();",
    ),
  )
  assertRed(planted, /^audit_immutability\.test\.sql: CREATE OR REPLACE FUNCTION audit\.write_row/)
})

test('rule 4: a suite that alters private.mfa_satisfied() is red', () => {
  const planted = withSuite('mfa_aal2.test.sql', (t) =>
    replaceOnce(t, 'SELECT * FROM finish();', 'ALTER FUNCTION private.mfa_satisfied() SECURITY INVOKER;\nSELECT * FROM finish();'),
  )
  assertRed(planted, /^mfa_aal2\.test\.sql: ALTER FUNCTION private\.mfa_satisfied/)
})

// ─── rule 5: public.notes only in the recursion probe ────────────────────────

test('rule 5: a behavioural assertion left on public.notes is red', () => {
  const planted = withSuite('mfa_aal2.test.sql', (t) =>
    replaceOnce(t, 'SELECT * FROM finish();', "SELECT is_empty($$ SELECT id FROM public.notes $$, 'left behind');\nSELECT * FROM finish();"),
  )
  assertRed(planted, /^mfa_aal2\.test\.sql:\d+: names public\.notes outside the recursion probe/)
})

test('rule 5: a comment naming public.notes is red too — the file must read as it runs', () => {
  const planted = withSuite('audit_immutability.test.sql', (t) =>
    replaceOnce(t, 'SELECT * FROM finish();', '-- formerly written to public.notes\nSELECT * FROM finish();'),
  )
  assertRed(planted, /^audit_immutability\.test\.sql:\d+: names public\.notes outside the recursion probe/)
})

test('rule 5: in rls_isolation the probe is the only licence — a second read of public.notes is red', () => {
  const planted = withSuite('rls_isolation.test.sql', (t) =>
    replaceOnce(t, 'SELECT * FROM finish();', "SELECT lives_ok($$ SELECT count(*) FROM public.notes $$, 'extra');\nSELECT * FROM finish();"),
  )
  const problems = judgeFixtures(planted)
  assert.equal(problems.filter((p) => /names public\.notes outside the recursion probe/.test(p)).length, 1, problems.join('\n'))
  assertRed(planted, /^rls_isolation\.test\.sql:\d+: names public\.notes outside the recursion probe/)
})

// ─── the model fails closed ──────────────────────────────────────────────────

test('the model fails closed: a skeleton with no hand-written block, or no MFA rail source, is refused', () => {
  const noHand = shipped()
  noHand.skeleton = replaceOnce(noHand.skeleton, 'CREATE TABLE public.<t> (', 'CREATE TABLE public.thing (')
  assert.ok(judgeFixtures(noHand).some((p) => /^migration-rls\.md: expected one sql block creating public\.<t>/.test(p)))

  const noRail = shipped()
  noRail.notesSchema = replaceOnce(noRail.notesSchema, 'CREATE POLICY notes_mfa_aal2 ', 'CREATE POLICY notes_mfa_rail ')
  assert.ok(judgeFixtures(noRail).some((p) => /^supabase\/schemas\/20_notes\.sql: expected one 'CREATE POLICY notes_mfa_aal2' statement/.test(p)))
})
