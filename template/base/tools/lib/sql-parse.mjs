// tools/lib/sql-parse.mjs — the ONE statement-level SQL reader the SQL gates share.
//
// Why a module rather than a regex in each gate: check-rls-manifest, check-tenancy,
// check-migrations and the write-guard all have to agree about what a statement IS.
// When they each carried their own splitter they disagreed in exactly the places that
// matter — a policy predicate containing a nested `)`, a DDL keyword inside a
// dollar-quoted function body, a trailing `-- comment` on a code line.
//
// Three properties the previous per-gate regexes did not have:
//
//   1. DOLLAR-QUOTE AWARE. `$$ ... $$` and `$tag$ ... $tag$` bodies are carried
//      through whole. Splitting on a bare `;` tore a PL/pgSQL body into fragments,
//      which is why no gate could ever look inside a function — and why relocating
//      `auth.uid()` into a helper body silently vacated the initPlan check.
//   2. BALANCED-PAREN CLAUSE EXTRACTION. `USING (...)` is read by counting
//      parentheses, not by a non-greedy regex anchored on ` WITH CHECK|$`. The old
//      form survived only because every shipped policy happened to end there; a
//      predicate with a nested sub-select and a trailing clause read back truncated,
//      and a truncated predicate is one that gets judged on the wrong text.
//   3. STRING-LITERAL AWARE. A `;`, `)` or `--` inside '...' is data, not syntax.
//
// Pure: no imports beyond node:fs for the directory reader, no process exit, no I/O
// side effects. Every consumer supplies its own failure vocabulary.
// SOURCE: docs/harness/README.md (one parser, four consumers) [corpus: postgres/rls-force]
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Concatenate every .sql in a directory in filename order — the cumulative text is
 * what the database ends up running. Filename order IS apply order for Supabase
 * migrations (timestamp prefixes), so this is not an approximation.
 */
export function readSqlDir(dir) {
  if (!existsSync(dir)) return ''
  let raw = ''
  for (const f of sortedSqlFiles(dir)) {
    raw += `\n${readFileSync(join(dir, f), 'utf8')}`
  }
  return raw
}

/**
 * The same directory listing, per file, so a gate can name the offending FILE rather
 * than only the offending statement. `readdirSync` order is filesystem-dependent —
 * the explicit sort is what makes every gate that walks migrations deterministic.
 */
function sortedSqlFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
}

/** [{ file, statements }] — statement-level parse with file provenance retained. */
export function readSqlDirByFile(dir) {
  return sortedSqlFiles(dir).map((file) => ({
    file: join(dir, file),
    statements: splitStatements(readFileSync(join(dir, file), 'utf8')),
  }))
}

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

const DOLLAR_TAG = /^\$([a-zA-Z_][a-zA-Z0-9_]*)?\$/

// ---- span readers -------------------------------------------------------------
// Each returns the index just PAST the construct starting at `i`. Named separately
// so both scanners below (statement splitting and paren matching) share one
// definition of "where does this quoted thing end" — two copies would be two
// chances to disagree about `''` escaping.

/** Past a single-quoted literal at `i` (raw[i] === "'"), honouring '' escapes. */
function endOfSingleQuoted(raw, i) {
  let j = i + 1
  while (j < raw.length) {
    if (raw[j] === "'" && raw[j + 1] === "'") {
      j += 2
      continue
    }
    if (raw[j] === "'") return j + 1
    j++
  }
  return j
}

/** Past a `-- line comment` at `i`, stopping ON the newline. */
function endOfLineComment(raw, i) {
  let j = i
  while (j < raw.length && raw[j] !== '\n') j++
  return j
}

/** Past a block comment at `i`. PostgreSQL nests these, unlike C. */
function endOfBlockComment(raw, i) {
  let j = i + 2
  let depth = 1
  while (j < raw.length && depth > 0) {
    if (raw[j] === '/' && raw[j + 1] === '*') {
      depth++
      j += 2
    } else if (raw[j] === '*' && raw[j + 1] === '/') {
      depth--
      j += 2
    } else j++
  }
  return j
}

/** Past a "quoted identifier" at `i`. */
function endOfQuotedIdent(raw, i) {
  let j = i + 1
  while (j < raw.length && raw[j] !== '"') j++
  return Math.min(j + 1, raw.length)
}

/** The `$tag$` opening at `i`, or null if `$` is not starting a dollar quote. */
function dollarTagAt(raw, i) {
  return DOLLAR_TAG.exec(raw.slice(i))?.[0] ?? null
}

/** Past a dollar-quoted body opened by `tag` at `i`. */
function endOfDollarQuoted(raw, i, tag) {
  const end = raw.indexOf(tag, i + tag.length)
  return end === -1 ? raw.length : end + tag.length
}

/**
 * Split raw SQL into whitespace-normalized statements, dropping comments.
 *
 * One left-to-right scan that understands the four things that can contain a
 * character which would otherwise be read as syntax: line comments, block comments,
 * single-quoted literals, and dollar-quoted bodies. Double-quoted identifiers are
 * unwrapped, matching how every downstream pattern is written (`public.notes`,
 * never `public."notes"`).
 */
export function splitStatements(raw) {
  const out = []
  let cur = ''
  let i = 0

  while (i < raw.length) {
    const ch = raw[i]
    const two = ch + (raw[i + 1] ?? '')

    if (two === '--') {
      i = endOfLineComment(raw, i)
    } else if (two === '/*') {
      i = endOfBlockComment(raw, i)
      cur += ' '
    } else if (ch === "'") {
      // Carried through verbatim: role names, reasons and search_path values all
      // live inside literals and the checks downstream read them.
      const j = endOfSingleQuoted(raw, i)
      cur += raw.slice(i, j)
      i = j
    } else if (ch === '"') {
      const j = endOfQuotedIdent(raw, i)
      cur += raw.slice(i + 1, j - 1)
      i = j
    } else if (ch === '$' && dollarTagAt(raw, i) !== null) {
      // The whole body is one opaque run — the property that makes function-body
      // inspection possible at all.
      const j = endOfDollarQuoted(raw, i, dollarTagAt(raw, i))
      cur += raw.slice(i, j)
      i = j
    } else if (ch === ';') {
      out.push(cur)
      cur = ''
      i++
    } else {
      cur += ch
      i++
    }
  }
  out.push(cur)

  return out.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)
}

/**
 * Given the index of a '(' in `text`, return [contentStart, contentEnd) for its
 * balanced group, or null if it never closes. String-literal aware, so a ')' inside
 * '...' does not close the group.
 */
export function matchParen(text, openIdx) {
  if (text[openIdx] !== '(') return null
  let depth = 0
  let i = openIdx
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'") {
      i = endOfSingleQuoted(text, i)
    } else if (ch === '(') {
      depth++
      i++
    } else if (ch === ')') {
      depth--
      i++
      if (depth === 0) return [openIdx + 1, i - 1]
    } else i++
  }
  return null
}

/** The balanced body of the first `<keyword> (...)` clause, or null. */
function clauseBody(text, keywordRe) {
  const m = keywordRe.exec(text)
  if (m === null) return null
  const open = text.indexOf('(', m.index + m[0].length - 1)
  if (open === -1) return null
  const span = matchParen(text, open)
  return span === null ? null : text.slice(span[0], span[1])
}

/**
 * Split on commas at paren depth 0 (string-literal aware). A CREATE TABLE column
 * list cannot be split by a naive `split(',')` — `numeric(10,2)`, `CHECK (a IN
 * (1,2))` and composite FK column lists all carry nested commas that would tear a
 * definition in half and hand downstream checks a fragment to judge.
 */
function splitTopLevelCommas(text) {
  const parts = []
  let depth = 0
  let start = 0
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'") {
      i = endOfSingleQuoted(text, i)
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
    i++
  }
  parts.push(text.slice(start))
  return parts.map((p) => p.trim()).filter(Boolean)
}

const isWordChar = (c) => c !== undefined && /[a-z0-9_$]/i.test(c)

/**
 * Split a predicate expression on TOP-LEVEL `OR` (paren depth 0, word-bounded,
 * literal-aware). This is what lets a policy check reason arm-by-arm: an AND
 * inside an arm can only narrow, but every OR arm is an independent grant, so a
 * scope requirement must hold in each arm separately — `<scope> OR owner_id =
 * (SELECT auth.uid())` is exactly as open as its weakest arm.
 */
export function splitTopLevelOr(expr) {
  const arms = []
  let depth = 0
  let start = 0
  let i = 0
  while (i < expr.length) {
    const ch = expr[i]
    if (ch === "'") {
      i = endOfSingleQuoted(expr, i)
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (
      depth === 0 &&
      (ch === 'o' || ch === 'O') &&
      /^or$/i.test(expr.slice(i, i + 2)) &&
      !isWordChar(expr[i - 1]) &&
      !isWordChar(expr[i + 2])
    ) {
      arms.push(expr.slice(start, i))
      i += 2
      start = i
      continue
    }
    i++
  }
  arms.push(expr.slice(start))
  return arms.map((a) => a.trim()).filter(Boolean)
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** `public.notes` -> `notes`; a non-public schema keeps its qualification. */
export const stripSchema = (t) => t.replace(/^public\./i, '').toLowerCase()

/** `private.member_org_ids` -> { schema: 'private', name: 'member_org_ids' } */
export function qualify(ident) {
  const lower = ident.toLowerCase()
  const dot = lower.indexOf('.')
  return dot === -1
    ? { schema: 'public', name: lower, qualified: `public.${lower}` }
    : { schema: lower.slice(0, dot), name: lower.slice(dot + 1), qualified: lower }
}

// ---------------------------------------------------------------------------
// Statement parsers
// ---------------------------------------------------------------------------

/**
 * RLS toggles, INCLUDING the negations.
 *
 * The negation sets are the point. A gate that collects only ENABLE and FORCE reads
 * a migration which later turns RLS off as fully covered — the statement it needs to
 * see matches none of its patterns, so the table stays in `enabled` forever.
 */
export function parseRlsToggles(statements) {
  const enabled = new Set()
  const forced = new Set()
  const disabled = new Map() // table -> statement
  const unforced = new Map() // table -> statement (NO FORCE)
  const triggersDisabled = new Map() // table -> statement

  for (const stmt of statements) {
    let m = stmt.match(/^ALTER TABLE (?:ONLY )?([a-z0-9_.]+) ENABLE ROW LEVEL SECURITY$/i)
    if (m) {
      enabled.add(stripSchema(m[1]))
      continue
    }
    m = stmt.match(/^ALTER TABLE (?:ONLY )?([a-z0-9_.]+) FORCE ROW LEVEL SECURITY$/i)
    if (m) {
      forced.add(stripSchema(m[1]))
      continue
    }
    m = stmt.match(/^ALTER TABLE (?:ONLY )?([a-z0-9_.]+) DISABLE ROW LEVEL SECURITY$/i)
    if (m) {
      disabled.set(stripSchema(m[1]), stmt)
      continue
    }
    m = stmt.match(/^ALTER TABLE (?:ONLY )?([a-z0-9_.]+) NO FORCE ROW LEVEL SECURITY$/i)
    if (m) {
      unforced.set(stripSchema(m[1]), stmt)
      continue
    }
    m = stmt.match(/^ALTER TABLE (?:ONLY )?([a-z0-9_.]+) DISABLE TRIGGER\b/i)
    if (m) triggersDisabled.set(stripSchema(m[1]), stmt)
  }
  return { enabled, forced, disabled, unforced, triggersDisabled }
}

const OPS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE']

/**
 * CREATE POLICY, with balanced-paren USING / WITH CHECK bodies.
 * Returns Map<table, Map<op, [{ name, using, check, roles, permissive, stmt }]>>
 * plus the DROP POLICY statements, which no gate looked at before.
 */
export function parsePolicies(statements) {
  const policies = new Map()
  const dropped = []

  for (const stmt of statements) {
    const d = stmt.match(/^DROP POLICY (?:IF EXISTS )?([a-z0-9_]+) ON ([a-z0-9_.]+)/i)
    if (d) {
      dropped.push({ name: d[1].toLowerCase(), table: stripSchema(d[2]), stmt })
      continue
    }

    const m = stmt.match(/^CREATE POLICY ([a-z0-9_]+) ON ([a-z0-9_.]+)(.*)$/i)
    if (m === null) continue
    const [, name, tableRaw, rest] = m
    const table = stripSchema(tableRaw)
    const op = (
      rest.match(/\bFOR (ALL|SELECT|INSERT|UPDATE|DELETE)\b/i)?.[1] ?? 'ALL'
    ).toUpperCase()
    const permissive = /\bAS RESTRICTIVE\b/i.test(rest) ? 'RESTRICTIVE' : 'PERMISSIVE'
    const roles = (rest.match(/\bTO ([a-z0-9_, ]+?)(?=\s+(?:USING|WITH CHECK)\b|$)/i)?.[1] ?? '')
      .split(',')
      .map((r) => r.trim().toLowerCase())
      .filter(Boolean)

    const using = clauseBody(rest, /\bUSING\s*\(/i)
    const check = clauseBody(rest, /\bWITH\s+CHECK\s*\(/i)

    if (!policies.has(table)) policies.set(table, new Map())
    const byOp = policies.get(table)
    if (!byOp.has(op)) byOp.set(op, [])
    byOp.get(op).push({ name: name.toLowerCase(), using, check, roles, permissive, stmt })
  }
  return { policies, dropped, OPS }
}

/**
 * Indexes, recording the LEADING column only — a second-position column does not
 * serve a policy's equality qual. CREATE INDEX, inline PK/UNIQUE, table-level
 * PK/UNIQUE and ALTER TABLE ADD CONSTRAINT all back an index and all count.
 *
 * Also returns the full ordered column list per index, which the query-shape gate
 * needs to prove an index serves a sort, not merely a filter.
 */
/** Ordered column list of an index/constraint definition, with sort direction. */
function columnsOf(list) {
  return list.split(',').map((raw) => {
    const t = raw.trim()
    return {
      name: t.match(/^[a-z0-9_]+/i)?.[0]?.toLowerCase() ?? null,
      desc: /\bDESC\b/i.test(t),
    }
  })
}

/** The balanced group opened by the first '(' at or after `from`, as text. */
function groupAfter(stmt, from) {
  const open = stmt.indexOf('(', from)
  if (open === -1) return null
  const span = matchParen(stmt, open)
  return span === null ? null : stmt.slice(span[0], span[1])
}

/**
 * PRIMARY KEY / UNIQUE groups declared inside a CREATE TABLE — inline column
 * markers and table-level constraint entries both — with names synthesized the
 * way PostgreSQL itself defaults them (`<table>_pkey`, `<table>_<col>_key`), so
 * a reviewed exemption can name the constraint the live catalog will hold.
 */
/** A table-level `[CONSTRAINT x] PRIMARY KEY|UNIQUE (...)` entry, or null. */
function constraintGroupOf(def, table) {
  const m = def.match(/^(?:CONSTRAINT\s+([a-z0-9_]+)\s+)?(PRIMARY\s+KEY|UNIQUE)\s*\(/i)
  if (m === null) return null
  const group = groupAfter(def, m[0].length - 1)
  if (group === null) return null
  const columns = columnsOf(group)
  const fallback = /^p/i.test(m[2])
    ? `${table}_pkey`
    : `${table}_${columns.map((c) => c.name).join('_')}_key`
  return { name: (m[1] ?? fallback).toLowerCase(), columns }
}

/** An inline `<col> <type> ... PRIMARY KEY|UNIQUE` column marker, or null. */
function inlineGroupOf(def, table) {
  const col = def.match(/^([a-z0-9_]+)\b(.*)$/i)
  if (col === null) return null
  // The negative lookahead rejects the table-level `... (cols)` form, which the
  // constraint reader above owns.
  const marker = col[2].match(/\b(PRIMARY\s+KEY|UNIQUE)\b(?!\s*\()/i)
  if (marker === null) return null
  const name = col[1].toLowerCase()
  return {
    name: /^p/i.test(marker[1]) ? `${table}_pkey` : `${table}_${name}_key`,
    columns: [{ name, desc: false }],
  }
}

function uniqueGroupsFromCreateTable(stmt, table) {
  const body = groupAfter(stmt, 0)
  if (body === null) return []
  const out = []
  for (const def of splitTopLevelCommas(body)) {
    const g = constraintGroupOf(def, table) ?? inlineGroupOf(def, table)
    if (g !== null) out.push(g)
  }
  return out
}

/** Index/constraint names this statement REMOVES (lowercased, schema stripped). */
function indexDropsIn(stmt) {
  const dropIdx = stmt.match(/^DROP INDEX (?:CONCURRENTLY )?(?:IF EXISTS )?([a-z0-9_.]+)/i)
  if (dropIdx) return [stripSchema(dropIdx[1])]
  // ALTER TABLE carries comma-separated actions, so a DROP CONSTRAINT can sit beside
  // the ADD CONSTRAINT that replaces it inside ONE statement.
  const alter = stmt.match(/^ALTER TABLE (?:ONLY )?[a-z0-9_.]+\s+(.+)$/i)
  if (alter === null) return []
  return [...alter[1].matchAll(/\bDROP\s+CONSTRAINT\s+(?:IF EXISTS\s+)?([a-z0-9_]+)/gi)].map((m) =>
    m[1].toLowerCase(),
  )
}

/** Index/constraint entries this statement CREATES. */
function indexAddsIn(stmt) {
  const create = stmt.match(/^CREATE TABLE (?:IF NOT EXISTS )?([a-z0-9_.]+)/i)
  if (create) {
    const table = stripSchema(create[1])
    return uniqueGroupsFromCreateTable(stmt, table).map((g) => ({
      table,
      name: g.name,
      columns: g.columns,
      unique: true,
    }))
  }
  const idx = stmt.match(
    /^CREATE (UNIQUE )?INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?([a-z0-9_]+) ON (?:ONLY )?([a-z0-9_.]+)(?: USING [a-z0-9_]+)?\s*\(/i,
  )
  if (idx) {
    const group = groupAfter(stmt, stmt.toUpperCase().indexOf(' ON '))
    if (group === null) return []
    return [
      {
        table: stripSchema(idx[3]),
        name: idx[2].toLowerCase(),
        columns: columnsOf(group),
        unique: idx[1] !== undefined,
      },
    ]
  }
  // ALTER TABLE carries COMMA-SEPARATED actions, so an ADD CONSTRAINT can sit beside
  // the DROP CONSTRAINT it replaces inside one statement — which is exactly how a
  // tenant re-scope swaps `PRIMARY KEY (id)` for `PRIMARY KEY (org_id, id)`. Scanning
  // for every ADD in the statement rather than anchoring one to the table name is what
  // makes the add half symmetric with indexDropsIn: anchored, the swap parsed as a pure
  // DROP and the table read as having no primary key at all, silently vacating every
  // leading-column and partition-ready-unique rule that depends on it.
  const alter = stmt.match(/^ALTER TABLE (?:ONLY )?([a-z0-9_.]+)\s/i)
  if (alter === null) return []
  const table = stripSchema(alter[1])
  const out = []
  for (const m of stmt.matchAll(
    /\bADD\s+(?:CONSTRAINT\s+([a-z0-9_]+)\s+)?(PRIMARY\s+KEY|UNIQUE)\s*\(/gi,
  )) {
    const group = groupAfter(stmt, m.index + m[0].length - 1)
    if (group === null) continue
    const columns = columnsOf(group)
    // PostgreSQL's own default names, so a reviewed exemption can name the constraint
    // the live catalog will hold even when the DDL left it unnamed.
    const fallback = /^p/i.test(m[2])
      ? `${table}_pkey`
      : `${table}_${columns.map((c) => c.name).join('_')}_key`
    out.push({ table, name: (m[1] ?? fallback).toLowerCase(), columns, unique: true })
  }
  return out
}

export function parseIndexes(statements) {
  let all = [] // { table, name, columns: [{ name, desc }], unique }

  for (const stmt of statements) {
    // Drops first, so a single ALTER TABLE that swaps a constraint (DROP … , ADD …)
    // ends with only the replacement. Folding the drops is what stops a superseded
    // PRIMARY KEY from satisfying the leading-column rule forever, and what stops a
    // removed tenant-blind unique from still looking like it needs a reviewed escape.
    const drops = new Set(indexDropsIn(stmt))
    if (drops.size > 0) all = all.filter((idx) => !drops.has(idx.name))
    all.push(...indexAddsIn(stmt))
  }
  // Derived at the END, from the indexes that SURVIVED — never accumulated as we go,
  // which is what let a dropped constraint keep vouching for its leading column.
  const leading = new Map()
  for (const idx of all) {
    const col = idx.columns[0]?.name
    if (col == null) continue
    if (!leading.has(idx.table)) leading.set(idx.table, new Set())
    leading.get(idx.table).add(col)
  }
  return { leading, all }
}

/**
 * CREATE TABLE names, with their schema qualification retained, and — for a partition
 * — the parent it attaches to.
 *
 * `partitionOf` matters because a partition is not a table in the sense any tenancy
 * or RLS rule means. It has no independent column list to inspect (`CREATE TABLE x
 * PARTITION OF y DEFAULT` declares none), its tenancy is its parent's, and treating it
 * as an ordinary table produces a confident, entirely wrong finding: "created with no
 * tenant column".
 */
export function parseCreatedTables(statements) {
  const created = new Map() // stripped name -> { qualified, schema, partitionOf, stmt }
  for (const stmt of statements) {
    const m = stmt.match(/^CREATE TABLE (?:IF NOT EXISTS )?([a-z0-9_.]+)/i)
    if (m === null) continue
    const parent = stmt.match(/\bPARTITION\s+OF\s+([a-z0-9_.]+)/i)
    created.set(stripSchema(m[1]), {
      ...qualify(m[1]),
      partitionOf: parent === null ? null : stripSchema(parent[1]),
      stmt,
    })
  }
  return created
}

// ---------------------------------------------------------------------------
// Column facts
// ---------------------------------------------------------------------------
// The cumulative per-column story the migration history tells: does the column
// exist, is it NOT NULL after the LAST word on the subject, and what does it
// REFERENCE. Folded in statement order because the expand→contract runbook
// legitimately adds a column nullable and hardens it later with SET NOT NULL —
// a reader that stopped at CREATE TABLE would red the exact adoption path the
// docs prescribe, and one that ignored DROP NOT NULL would green its undoing.

const TABLE_LEVEL_ENTRY =
  /^(?:CONSTRAINT\s+[a-z0-9_]+\s+)?(?:PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|EXCLUDE|LIKE)\b/i

function columnEntry(cols, rawName) {
  const name =
    rawName
      .trim()
      .toLowerCase()
      .match(/^[a-z0-9_]+/)?.[0] ?? rawName.trim().toLowerCase()
  if (!cols.has(name)) {
    cols.set(name, {
      notNull: false,
      references: null,
      onDelete: null,
      constraint: null,
      stmts: [],
    })
  }
  return cols.get(name)
}

/**
 * The referential ACTION on a FOREIGN KEY clause, normalised.
 *
 * `null` means the clause named none, which in PostgreSQL is NO ACTION — and that is
 * reported as the explicit string rather than as "unknown", because the difference
 * between "nobody chose" and "somebody chose NO ACTION" is a review question and the
 * parser is not the place to answer it. Callers that care read `onDelete === null`.
 * SOURCE: https://www.postgresql.org/docs/current/ddl-constraints.html
 */
function referentialAction(tail) {
  const m = tail.match(/\bON\s+DELETE\s+(CASCADE|RESTRICT|NO\s+ACTION|SET\s+NULL|SET\s+DEFAULT)\b/i)
  return m === null ? null : m[1].toUpperCase().replace(/\s+/g, ' ')
}

/**
 * The name a later `DROP CONSTRAINT` will use.
 *
 * PostgreSQL names an unnamed foreign key `<table>_<column>_fkey`, and that generated name is
 * what real migrations drop — supabase/migrations/20260201000100 drops `notes_owner_id_fkey`
 * for a constraint no CREATE TABLE ever named. Synthesising it is what makes a drop-only
 * ALTER readable at all; without it the parser keeps believing in a foreign key the database
 * no longer has, which for a reachability question is the worst direction to be wrong in.
 * SOURCE: https://www.postgresql.org/docs/current/ddl-constraints.html
 */
const defaultFkName = (table, column) => `${table.replace(/^.*\./, '')}_${column}_fkey`

function applyColumnDef(cols, def, stmt, table) {
  const m = def.match(/^([a-z0-9_]+)\b\s*(.*)$/i)
  if (m === null) return
  const entry = columnEntry(cols, m[1])
  if (/\bNOT\s+NULL\b/i.test(m[2]) || /\bPRIMARY\s+KEY\b/i.test(m[2])) entry.notNull = true
  const ref = m[2].match(/\bREFERENCES\s+([a-z0-9_.]+)/i)
  if (ref !== null) {
    const named = m[2].slice(0, ref.index).match(/\bCONSTRAINT\s+([a-z0-9_]+)\s*$/i)
    entry.references = qualify(ref[1]).qualified
    entry.onDelete = referentialAction(m[2].slice(ref.index))
    entry.constraint =
      named === null ? defaultFkName(table, m[1].toLowerCase()) : named[1].toLowerCase()
  }
  entry.stmts.push(stmt)
}

function applyTableLevelEntry(cols, def, stmt, table) {
  const fk = def.match(/\bFOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+([a-z0-9_.]+)/i)
  if (fk !== null) {
    // The constraint NAME, when the clause carries one. It is what a later
    // `DROP CONSTRAINT` names, and without it a dropped foreign key still reads as
    // present — which for any reachability question is the worst direction to be wrong in.
    const named = def.match(/^CONSTRAINT\s+([a-z0-9_]+)\b/i)
    for (const raw of fk[1].split(',')) {
      const entry = columnEntry(cols, raw)
      entry.references = qualify(fk[2]).qualified
      entry.onDelete = referentialAction(def.slice(fk.index))
      entry.constraint =
        named === null ? defaultFkName(table, raw.trim().toLowerCase()) : named[1].toLowerCase()
      entry.stmts.push(stmt)
    }
    return
  }
  // A table-level PRIMARY KEY implies NOT NULL on each member column.
  const pk = def.match(/\bPRIMARY\s+KEY\s*\(([^)]*)\)/i)
  if (pk !== null) for (const raw of pk[1].split(',')) columnEntry(cols, raw).notNull = true
}

function applyAlterAction(cols, action, stmt, table) {
  const add = action.match(/^ADD\s+(?:COLUMN\s+)?(?:IF NOT EXISTS\s+)?(.+)$/i)
  if (add !== null) {
    if (TABLE_LEVEL_ENTRY.test(add[1])) applyTableLevelEntry(cols, add[1], stmt, table)
    else applyColumnDef(cols, add[1], stmt, table)
    return
  }
  const setNn = action.match(/^ALTER\s+(?:COLUMN\s+)?([a-z0-9_]+)\s+SET\s+NOT\s+NULL$/i)
  if (setNn !== null) {
    columnEntry(cols, setNn[1]).notNull = true
    return
  }
  const dropNn = action.match(/^ALTER\s+(?:COLUMN\s+)?([a-z0-9_]+)\s+DROP\s+NOT\s+NULL$/i)
  if (dropNn !== null) {
    columnEntry(cols, dropNn[1]).notNull = false
    return
  }
  const dropCol = action.match(/^DROP\s+COLUMN\s+(?:IF EXISTS\s+)?([a-z0-9_]+)/i)
  if (dropCol !== null) {
    cols.delete(dropCol[1].toLowerCase())
    return
  }
  // A dropped FOREIGN KEY leaves the column but takes its referential action with it.
  // Folded because the expand→contract path legitimately drops and re-adds one in a
  // single statement to change ON DELETE — supabase/migrations/20260201000100 does
  // exactly that to notes.owner_id, CASCADE -> SET NULL — and a reader that ignored the
  // DROP would report whichever the ADD did not set. For a reachability question that
  // is the difference between "this row is erased with the account" and "it is not".
  const dropCon = action.match(/^DROP\s+CONSTRAINT\s+(?:IF EXISTS\s+)?([a-z0-9_]+)/i)
  if (dropCon !== null) {
    const name = dropCon[1].toLowerCase()
    for (const entry of cols.values()) {
      if (entry.constraint !== name) continue
      entry.references = null
      entry.onDelete = null
      entry.constraint = null
    }
  }
}

function applyCreateColumns(cols, stmt, table) {
  const body = groupAfter(stmt, 0)
  if (body === null) return
  for (const def of splitTopLevelCommas(body)) {
    if (TABLE_LEVEL_ENTRY.test(def)) applyTableLevelEntry(cols, def, stmt, table)
    else applyColumnDef(cols, def, stmt, table)
  }
}

/**
 * Map<table, Map<column, { notNull, references, onDelete, constraint, stmts }>> over the
 * whole history.
 *
 * `onDelete` and `constraint` joined in 0.6.0 for the `data-flow` gate, which asks a
 * question no earlier gate did: what happens to THIS row when the account it belongs to is
 * deleted. That is a property of the referential ACTION, not of the reference — and the
 * two shipped answers here (CASCADE on profiles/memberships, SET NULL on notes.owner_id,
 * orgs.created_by and invitations.invited_by) mean opposite things to a subject asking to
 * be erased.
 */
export function parseColumnFacts(statements) {
  const tables = new Map()
  const colsOf = (t) => {
    if (!tables.has(t)) tables.set(t, new Map())
    return tables.get(t)
  }
  for (const stmt of statements) {
    const create = stmt.match(/^CREATE TABLE (?:IF NOT EXISTS )?([a-z0-9_.]+)\s*\(/i)
    if (create) {
      applyCreateColumns(colsOf(stripSchema(create[1])), stmt, stripSchema(create[1]))
      continue
    }
    const alter = stmt.match(/^ALTER TABLE (?:ONLY )?(?:IF EXISTS )?([a-z0-9_.]+)\s+(.+)$/i)
    if (alter === null) continue
    const cols = colsOf(stripSchema(alter[1]))
    const table = stripSchema(alter[1])
    for (const action of splitTopLevelCommas(alter[2])) applyAlterAction(cols, action, stmt, table)
  }
  return tables
}

/**
 * The EFFECTIVE definition of a function, by qualified name: the LAST one in migration
 * order, never the first.
 *
 * WHY THIS EXISTS (0.11.0). `parseFunctions` returns EVERY `CREATE [OR REPLACE] FUNCTION`
 * across the append-only migration set, in file order, so a function redefined by a later
 * migration appears more than once. Every caller resolving a name reached for
 * `functions.find(...)`, which returns the FIRST — the definition the migration set has
 * already replaced. Policies fold last-wins in this codebase; functions did not, and the
 * asymmetry was silent because a tree with no redefinition behaves identically under both.
 *
 * The consequence is a gate that judges a definition the database will never run: a later
 * `CREATE OR REPLACE FUNCTION private.member_ranks()` that inverted the rank ladder, or
 * dropped a `SET search_path`, would be checked against the original and pass. Any
 * discharge that redefines a helper is VACUOUS AT THE GATE until this resolves last-wins,
 * which is why it is fixed before anything is built on top of it.
 *
 * Deliberately NOT applied to the whole-fleet scans in check-rls-manifest.mjs: asking
 * "does every definer definition pin search_path" over all definitions is stricter than
 * asking it of the survivor, and a transiently-unsafe definition still executes during a
 * replay against real data. This resolver is for NAME RESOLUTION only.
 * @param {Array<{qualified: string}>} functions in migration order, as parseFunctions returns them
 * @param {string} qualified schema-qualified function name
 */
export function resolveFunction(functions, qualified) {
  for (let i = functions.length - 1; i >= 0; i -= 1) {
    if (functions[i].qualified === qualified) return functions[i]
  }
  return undefined
}

/**
 * CREATE FUNCTION, with the three attributes that decide whether a definer function
 * is a hardening tool or a privilege-escalation footgun: whether it is SECURITY
 * DEFINER, whether it pins `search_path`, and its parameter list (an identity-shaped
 * parameter means the caller tells the function who they are).
 *
 * Returns EVERY definition, including redefinitions, in migration order — use
 * `resolveFunction` to get the effective one by name.
 */
export function parseFunctions(statements) {
  const fns = []
  for (const stmt of statements) {
    const m = stmt.match(/^CREATE (?:OR REPLACE )?FUNCTION ([a-z0-9_.]+)\s*\(/i)
    if (m === null) continue
    const open = stmt.indexOf('(', m[0].length - 1)
    const span = matchParen(stmt, open)
    const paramText = span === null ? '' : stmt.slice(span[0], span[1])
    const params = paramText
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const pm = p.match(/^(?:IN|OUT|INOUT|VARIADIC)?\s*([a-z0-9_]+)\s+(.+)$/i)
        return { name: (pm?.[1] ?? p).toLowerCase(), type: (pm?.[2] ?? '').toLowerCase(), raw: p }
      })

    const searchPath = stmt.match(/\bSET\s+search_path\s*(?:=|TO)\s*('[^']*'|[a-z0-9_."]+)/i)?.[1]

    fns.push({
      ...qualify(m[1]),
      params,
      securityDefiner: /\bSECURITY\s+DEFINER\b/i.test(stmt),
      searchPath: searchPath === undefined ? null : searchPath.replace(/'/g, ''),
      volatility: stmt.match(/\b(IMMUTABLE|STABLE|VOLATILE)\b/i)?.[1]?.toUpperCase() ?? 'VOLATILE',
      language: stmt.match(/\bLANGUAGE\s+([a-z0-9_]+)/i)?.[1]?.toLowerCase() ?? null,
      body: bodyOf(stmt),
      stmt,
    })
  }
  return fns
}

/** The dollar-quoted body of a CREATE FUNCTION statement, unwrapped. */
function bodyOf(stmt) {
  const m = /\$([a-zA-Z_][a-zA-Z0-9_]*)?\$/.exec(stmt)
  if (m === null) return null
  const tag = m[0]
  const start = m.index + tag.length
  const end = stmt.indexOf(tag, start)
  return end === -1 ? stmt.slice(start) : stmt.slice(start, end)
}

/**
 * The literal argument list of a trigger's `EXECUTE FUNCTION f(...)`, unquoted.
 *
 * Trigger arguments are how a shared trigger function is told which columns of THIS
 * table it is acting on — `audit.write_row('org_id', 'id', 'role_rank')` — so they
 * carry policy, not just plumbing, and a gate that cannot read them cannot close over
 * what a trigger actually captures. Returns [] for `f()`, and null when the statement
 * has no EXECUTE clause at all (the two are different: no arguments is a fact, no
 * function is a malformed trigger).
 */
function triggerArgs(tail) {
  const m = /\bEXECUTE\s+(?:PROCEDURE|FUNCTION)\s+[a-z0-9_.]+\s*\(/i.exec(tail)
  if (m === null) return null
  const span = matchParen(tail, m.index + m[0].length - 1)
  if (span === null) return null
  return splitTopLevelCommas(tail.slice(span[0], span[1])).map((a) =>
    a.trim().replace(/^'(.*)'$/s, '$1'),
  )
}

/** CREATE TRIGGER, so a gate can require one and notice when it is later disabled. */
export function parseTriggers(statements) {
  const triggers = []
  for (const stmt of statements) {
    const m = stmt.match(
      /^CREATE (?:OR REPLACE )?(?:CONSTRAINT )?TRIGGER ([a-z0-9_]+) (BEFORE|AFTER|INSTEAD OF) ([A-Z ,]+?) ON ([a-z0-9_.]+)(.*)$/i,
    )
    if (m === null) continue
    triggers.push({
      name: m[1].toLowerCase(),
      timing: m[2].toUpperCase(),
      events: m[3]
        .split(/\s+OR\s+|,/i)
        .map((e) => e.trim().toUpperCase())
        .filter(Boolean),
      table: stripSchema(m[4]),
      forEach: /\bFOR EACH ROW\b/i.test(m[5]) ? 'ROW' : 'STATEMENT',
      when: clauseBody(m[5], /\bWHEN\s*\(/i),
      execute:
        m[5].match(/\bEXECUTE\s+(?:PROCEDURE|FUNCTION)\s+([a-z0-9_.]+)/i)?.[1]?.toLowerCase() ??
        null,
      args: triggerArgs(m[5]),
      stmt,
    })
  }
  return triggers
}

/**
 * GRANT / REVOKE, so "REVOKE ALL then narrow GRANT" is checkable as data.
 *
 * `object` is the OBJECT-TYPE keyword the statement used — 'TABLE', 'FUNCTION',
 * 'SCHEMA', 'ALL TABLES IN SCHEMA', or null when the statement omitted it (which SQL
 * allows, and which then means TABLE for a bare name and FUNCTION for a name carrying
 * an argument list). It is recorded rather than discarded because `target` alone is
 * ambiguous in a way that silently mixes ledgers: `REVOKE ALL ON SCHEMA audit FROM
 * anon` and `REVOKE ALL ON TABLE audit.events FROM anon` both reduce to a bare name,
 * and a consumer folding the first into the second's privilege history would conclude
 * a table had been locked down when only its schema had. Callers that judge table
 * privileges must therefore filter on this field, not on the privilege list alone.
 * SOURCE: https://www.postgresql.org/docs/17/sql-grant.html
 */
export function parseGrants(statements) {
  const entries = []
  for (const stmt of statements) {
    const m = stmt.match(
      /^(GRANT|REVOKE)\s+(.+?)\s+ON\s+(TABLE\s+|FUNCTION\s+|ALL TABLES IN SCHEMA\s+|SCHEMA\s+)?([a-z0-9_.(), ]+?)\s+(?:TO|FROM)\s+([a-z0-9_, ]+)$/i,
    )
    if (m === null) continue
    entries.push({
      kind: m[1].toUpperCase(),
      privileges: m[2]
        .split(',')
        .map((p) => p.trim().toUpperCase())
        .filter(Boolean),
      object: m[3] === undefined ? null : m[3].trim().toUpperCase(),
      target: stripSchema(m[4].trim()),
      roles: m[5]
        .split(',')
        .map((r) => r.trim().toLowerCase())
        .filter(Boolean),
      stmt,
    })
  }
  return entries
}

// A `parseSqlDir(dir)` aggregate — one pass returning every parsed view — was written
// here and DELETED unused: all four consuming gates call the specific parsers they need,
// so it was speculative API that `knip --strict` correctly refused to carry. The parse
// cost it was meant to amortize is a few milliseconds; if a caller ever wants the whole
// set, it is four lines to bring back with a real call site behind it.
