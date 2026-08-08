#!/usr/bin/env node
// Gate: data-flow — what happens to a person's data when they ask to be forgotten, and what
// a portability request has to hand back. Both decided from files this repository commits.
//
// THE SENTENCE THIS ENFORCES. docs/adr/20260201-org-scoped-tenancy.md records that after the
// org re-scope "DSR completeness is now procedure-backed, not schema-backed... residual rows
// can no longer be enumerated back to the subject." That is an accurate and serious statement
// and until this gate nothing could check it — the procedure it refers to lived in one Edge
// Function's header, the reasons for each surviving column lived in six different SQL
// comments, and no file anywhere listed what actually survives.
//
// WHY IT IS DECIDABLE. A delete of `auth.users` does exactly what the FOREIGN KEY actions say.
// So every link out of the subject lands in one of four buckets (tools/lib/data-flow.mjs
// states them), and only two of them are decisions a human has to make and defend: a SEVERED
// link means a row survives that somebody asked to have erased, and a RETAINED column means
// data survives that no delete will ever reach. Both are legitimate here — the org
// owns its notes, the audit trail must outlive its subjects — and both are exactly the kind of
// legitimate decision that stops being reviewed once it is three releases old.
//
// THE BUCKET NOBODY WATCHES IS THE THIRD. An FK to the subject with ON DELETE RESTRICT or
// NO ACTION makes the delete FAIL, and NO ACTION is what PostgreSQL assumes when the clause is
// simply omitted — so the spelling that breaks account deletion is the one that looks like
// every other column definition. That is a GDPR Art. 17 failure and an Apple 5.1.1(v) review
// rejection from a line nobody would look at twice.
//
// MIGRATIONS ARE THE SUBJECT, and the schemas are checked AGAINST them rather than trusted.
// Same call check-tenancy and check-db-limits make: a policy that lives only in the
// declarative schema never ran. But this gate also closes the two directories against each
// other on the referential actions, which nothing else does — check-migrations' own header
// defers schema↔migration drift to CI's db lane, and check-rls-manifest compares table NAMES
// only. On this question that gap matters more than usual: notes.owner_id was created ON
// DELETE CASCADE and demoted to SET NULL by a later ALTER, so a reviewer reading only the
// declarative file and a reviewer reading only the creating migration reach opposite
// conclusions about whether a note dies with its author.
// SOURCE: https://www.postgresql.org/docs/current/ddl-constraints.html (referential actions)
// SOURCE: docs/adr/20260201-org-scoped-tenancy.md (the DSR sentence this makes checkable)
import { existsSync, readFileSync } from 'node:fs'
import {
  classifyLinks,
  closeAgainstReviewed,
  foreignKeys,
  SUBJECT_ROOT,
  siteKey,
  spelledAction,
} from './lib/data-flow.mjs'
import { fail, failures, ok, rampNote, skipOrFail } from './lib/gate.mjs'
import { parseColumnFacts, readSqlDir, splitStatements } from './lib/sql-parse.mjs'

const GATE = 'data-flow'
const MIGRATIONS_DIR = 'supabase/migrations'
const SCHEMAS_DIR = 'supabase/schemas'
const POLICY = 'tools/data-flow.json'
const PII = 'tools/pii-columns.json'
const RAMP = '0.6.0'

if (!existsSync(MIGRATIONS_DIR)) {
  skipOrFail(GATE, `${MIGRATIONS_DIR} not found (no Supabase surface yet)`)
}

// WITHHELD ON UPDATE, PLANTED ON INIT (template/migrations.json seedOnInitOnly). An existing
// install's schema will have severed links this file has never reviewed, so planting a policy
// written against the HARNESS's schema would red them for rows the harness never saw. Absent,
// the gate reports what it found and asks for the file — it does not pass vacuously, and it
// does not judge a project against somebody else's decisions either.
const policy = existsSync(POLICY) ? JSON.parse(readFileSync(POLICY, 'utf8')) : null

const facts = parseColumnFacts(splitStatements(readSqlDir(MIGRATIONS_DIR)))
const links = classifyLinks(foreignKeys(facts), policy?.subjectRoot ?? SUBJECT_ROOT)
const errs = []

const has = (table, column) => facts.get(table)?.has(column) === true
const reasonOf = (list, key) =>
  (list ?? []).find((r) => siteKey(r.table ?? '', r.column ?? '') === key)

// ── 1. BLOCKING: the delete would FAIL ───────────────────────────────────────────────
// No silent escape. An entry in blockingAllowed must name the committed file that clears the
// rows first — the pattern delete-account already uses for the personal org — and that file
// must exist, because a procedure named in reviewed data and absent from the tree is the
// compensating control this repository deletes on sight.
for (const e of links.blocking) {
  const allowed = reasonOf(policy?.blockingAllowed, siteKey(e.table, e.column))
  if (allowed === undefined) {
    errs.push(
      `${e.table}.${e.column} REFERENCES ${e.parent} ON DELETE ${spelledAction(e.onDelete)} — deleting the account would FAIL while any such row exists. An account that cannot be deleted is a GDPR Art. 17 failure and an Apple 5.1.1(v) rejection at once. Use ON DELETE CASCADE (the row goes with the account) or SET NULL (the row survives, reviewed in ${POLICY} severed[]); if a pre-delete sweep is genuinely the design, record it in ${POLICY} blockingAllowed[] with the \`procedure\` that performs it.`,
    )
    continue
  }
  if (!existsSync(String(allowed.procedure ?? ''))) {
    errs.push(
      `${e.table}.${e.column}: blockingAllowed names procedure ${JSON.stringify(allowed.procedure ?? null)}, which is not a file in this tree. The whole basis for allowing a delete-blocking foreign key is that something clears the rows first; a procedure nobody can open is not that something.`,
    )
  }
}

// ── 2. SEVERED: the row survives, and somebody decided it should ─────────────────────
const severedKeys = links.severed.map((e) => siteKey(e.table, e.column))
const severedClosure = closeAgainstReviewed(severedKeys, policy?.severed ?? [])
for (const k of severedClosure.unreviewed) {
  const e = links.severed.find((x) => siteKey(x.table, x.column) === k)
  errs.push(
    `${k} REFERENCES ${e.parent} ON DELETE ${e.onDelete} — the row SURVIVES the account's deletion with only the link cut, and no entry in ${POLICY} severed[] says why. That is a decision that somebody else is the data controller for this row. It may well be right (the org owns its notes); it has to be written down, because the next person to read this column cannot tell a deliberate SET NULL from one that was copied.`,
  )
}
for (const k of severedClosure.stale) {
  errs.push(
    `${POLICY} severed[] reviews ${k}, which is no longer a SET NULL link to ${links.erased.size > 0 ? 'the subject' : SUBJECT_ROOT} in ${MIGRATIONS_DIR} — either the column went, or its action changed and the reasoning attached to it did not. A reviewed reason for a decision nobody is making any more reads as coverage and is not.`,
  )
}
for (const k of severedClosure.thin) {
  errs.push(
    `${POLICY} severed[] entry for ${k} has a reason under 40 characters. This is the only place a reader learns why data that somebody asked to have erased is still here.`,
  )
}

// ── 3. RETAINED: nothing the delete does will ever reach it ──────────────────────────
// The gate cannot DERIVE which columns carry personal data — that is a human judgement about
// meaning, not about SQL. It derives the closure instead, from the one list in the tree that
// already names personal data for a different purpose: tools/pii-columns.json. That file is
// explicit that it is "not a general PII inventory" — it is the audit-capture deny-list — so
// it is used here only as a LOWER BOUND, which is exactly what it can support. Every column
// it names must be accounted for: erased with its row, severed with a reason, or retained
// with a reason AND a procedure.
const piiColumns = existsSync(PII) ? (JSON.parse(readFileSync(PII, 'utf8')).columns ?? []) : []
for (const c of piiColumns) {
  const key = siteKey(c.table, c.column)
  if (links.erased.has(c.table)) continue
  if (severedKeys.includes(key)) continue
  if (reasonOf(policy?.retained, key) !== undefined) continue
  errs.push(
    `${key} is declared personal data in ${PII}, its table is not erased by the account's deletion, and it is not a severed link — so nothing removes it and nothing explains that. Record it in ${POLICY} retained[] with a reason and the \`procedure\` that answers an erasure request for it, or give the table a path to ${SUBJECT_ROOT}.`,
  )
}
for (const u of policy?.retained ?? []) {
  const key = siteKey(u.table ?? '?', u.column ?? '?')
  if (links.erased.has(u.table)) {
    errs.push(
      `${POLICY} retained[] claims ${key} survives the subject's deletion, but ${u.table} is erased by a chain of ON DELETE CASCADE — the row goes with the account. A retention exception recorded against data that is already deleted is a claim that will be read as a gap and is not one.`,
    )
    continue
  }
  if (!has(u.table, u.column) && !u.table.includes('.')) {
    errs.push(
      `${POLICY} retained[] names ${key}, which no migration in ${MIGRATIONS_DIR} creates — a retention exception for a column that does not exist.`,
    )
    continue
  }
  if ((u.reason ?? '').trim().length < 40) {
    errs.push(`${POLICY} retained[] entry for ${key} has a reason under 40 characters.`)
  }
  if (!existsSync(String(u.procedure ?? ''))) {
    errs.push(
      `${POLICY} retained[] entry for ${key} names procedure ${JSON.stringify(u.procedure ?? null)}, which is not a file in this tree. Data no cascade can reach is answered by a PROCEDURE or it is not answered at all — and the whole finding in the tenancy ADR is that this schema's DSR completeness is procedure-backed.`,
    )
  }
}

// ── 4. THE EXPORT PROJECTION, closed both ways ───────────────────────────────────────
const projection = policy?.export?.projection ?? []
for (const p of projection) {
  for (const col of p.columns ?? []) {
    if (!has(p.table, col)) {
      errs.push(
        `${POLICY} export.projection promises ${siteKey(p.table, col)}, which no migration creates — a portability response cannot return a column that is not there.`,
      )
    }
  }
}
// Every table that holds subject data is either projected or excluded WITH A REASON. The
// subject-data table set is derived, not listed: the erased tables plus every table carrying a
// severed link or a reviewed retained column. So adding a table that cascades from the
// account puts it in scope automatically, which is the direction a hand-maintained list fails.
const subjectTables = new Set([
  ...links.erased,
  ...links.severed.map((e) => e.table),
  ...(policy?.retained ?? []).map((u) => u.table),
])
const projected = new Set(projection.map((p) => p.table))
const excluded = new Map((policy?.export?.excluded ?? []).map((x) => [x.table, x]))
for (const t of [...subjectTables].sort()) {
  if (projected.has(t)) continue
  const x = excluded.get(t)
  if (x === undefined) {
    errs.push(
      `${t} carries subject data and appears in neither ${POLICY} export.projection nor export.excluded — a portability response either returns it or states why it does not. Silence is the one answer a data subject cannot be given.`,
    )
    continue
  }
  if ((x.reason ?? '').trim().length < 40) {
    errs.push(`${POLICY} export.excluded entry for ${t} has a reason under 40 characters.`)
  }
}
for (const t of excluded.keys()) {
  if (subjectTables.has(t) || projected.has(t)) continue
  if (facts.has(t)) continue
  errs.push(
    `${POLICY} export.excluded names ${t}, which no migration creates — a stale exclusion reads as a considered decision about a table nobody has.`,
  )
}

// ── 5. THE DELIVERY SURFACE, declared either way ─────────────────────────────────────
// Same shape as store-policy.json's accountDeletion: a real surface, or `none` with a reason
// and a dated Target. The escape exists because a projection closed against the schema is
// worth something on its own — but an UNDECLARED absence is how "we have an export" becomes
// true in a README and false in the product.
const surface = policy?.export?.surface
if (policy !== null && (surface === null || surface === undefined)) {
  errs.push(
    `${POLICY} export.surface is missing — declare { kind: "procedure", procedure } for a delivered export, or { kind: "none", reason, target } to state its absence with a date.`,
  )
} else if (surface?.kind === 'none') {
  if ((surface.reason ?? '').trim().length < 40 || !/^\d+\.\d+\.\d+$/.test(surface.target ?? '')) {
    errs.push(
      `${POLICY} export.surface is "none" but does not carry both a reason of at least 40 characters and a \`target\` version — an absence with no date is a deferral nobody has to keep.`,
    )
  }
} else if (surface?.kind === 'procedure' && !existsSync(String(surface.procedure ?? ''))) {
  errs.push(
    `${POLICY} export.surface names procedure ${JSON.stringify(surface.procedure ?? null)}, which is not a file in this tree.`,
  )
}

// ── 6. THE DECLARATIVE SCHEMA MUST NOT DISAGREE ──────────────────────────────────────
// The only place in this repo where supabase/schemas and supabase/migrations are compared on
// COLUMN facts. check-migrations defers schema↔migration drift to CI's db lane and
// check-rls-manifest compares table names only, so a declarative file can carry a referential
// action the database never had. On any other question that is a documentation bug; here the
// declarative file is what a reviewer reads to answer "does this row die with its author",
// and both answers are one word long.
if (existsSync(SCHEMAS_DIR)) {
  const declared = parseColumnFacts(splitStatements(readSqlDir(SCHEMAS_DIR)))
  for (const e of foreignKeys(facts)) {
    const d = declared.get(e.table)?.get(e.column)
    if (d === undefined || d.references === null) continue
    if ((d.onDelete ?? null) === (e.onDelete ?? null)) continue
    errs.push(
      `${siteKey(e.table, e.column)}: ${SCHEMAS_DIR} declares ON DELETE ${spelledAction(d.onDelete)} but the applied history in ${MIGRATIONS_DIR} leaves it ON DELETE ${spelledAction(e.onDelete)}. The database does what the migrations say; the declarative file is what a reviewer reads. On this column those two sentences answer "is this erased with the account" differently.`,
    )
  }
}

// ── the ramp ─────────────────────────────────────────────────────────────────────────
// An install that predates 0.6.0 has a schema whose severed links were never reviewed and no
// policy file to review them in (it is withheld on update). Every finding above would land at
// once on an upgrade nobody asked for. Projects grow into gates.
if (
  errs.length > 0 &&
  rampNote(GATE, RAMP, `the ${GATE} closure over ${SUBJECT_ROOT}`, { until: '0.7.0' })
) {
  console.log(`${GATE}: NOTE — ${String(errs.length)} finding(s) withheld by the ${RAMP} ramp:`)
  for (const e of errs) console.log(`  - ${e}`)
  ok(GATE, `NOTE-only on this pre-${RAMP} install (the ramp expires in 0.7.0)`)
}

if (policy === null) {
  fail(
    GATE,
    `${POLICY} is missing and the schema has ${String(links.severed.length)} severed link(s) and ${String(links.blocking.length)} delete-blocking link(s) that nobody has reviewed. Pull the reviewed exemplar with \`npx next-expo-supabase-agent-harness update --refresh-seeded ${POLICY}\` and edit it to match THIS schema's decisions — it is withheld on update precisely so it describes your rows rather than the harness's.`,
  )
}

failures(
  GATE,
  errs,
  `Each finding is a decision the schema cannot make for itself: change the referential action, or record the reason in ${POLICY}. The file is git-clean-enforced by check-gate-integrity.mjs, so every widening lands in a PR diff where somebody can see it.`,
)
ok(
  GATE,
  `${String(links.erased.size)} table(s) erased with the account, ${String(links.severed.length)} reviewed severed link(s), ${String((policy.retained ?? []).length)} reviewed retained column(s), 0 delete-blocking link(s); export projection closed over ${String(projection.length)} table(s) with ${String(excluded.size)} reviewed exclusion(s); ${SCHEMAS_DIR} agrees with the applied history`,
)
