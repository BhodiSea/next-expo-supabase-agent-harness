#!/usr/bin/env node
// Gate: migrations — migration files are append-only, DML-free, and destructive
// changes are ADR-coupled.
//
// A DEFERRAL THIS HEADER USED TO CLAIM WAS COVERED, corrected in 0.6.0. It read "the
// schema↔migration drift check via `supabase db diff` runs in CI's db lane where an install
// exists". No workflow in this repository runs `supabase db diff` — not migration-safety.yml,
// not either database lane in quality-gate.yml, not the selftest matrix. So the reconciliation
// between the declarative `supabase/schemas/` and the applied `supabase/migrations/` was
// deferred to a lane that does not exist, which is worse than an open deferral because it
// reads as coverage. `check-data-flow.mjs` now closes the slice of it that decides whether a
// row dies with its owner (the ON DELETE actions on every foreign key, both directions); the
// REST of the drift surface — column types, defaults, check constraints — is still unclosed
// and is now stated as such rather than attributed to a job nobody wrote.
//
// Checks (all static):
//   1. append-only: no committed migration is modified or deleted in the working tree
//      or (in CI) relative to the PR base
//   2. no DML: INSERT/UPDATE/DELETE in migrations only with an explicit
//      `-- harness-allow-dml: <reason>` marker (reference data is a deliberate act).
//      Judged per STATEMENT, so DML inside a CREATE FUNCTION body — which the
//      migration defines but never executes — is not the migration's DML
//   3. destructive DDL (DROP TABLE/COLUMN, TRUNCATE) requires `-- adr: docs/adr/<file>`
//      pointing at an existing ADR
// SOURCE: docs/harness/README.md (migration discipline)
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  commandFailureOutput,
  fail,
  failures,
  inCI,
  ok,
  rampNote,
  skipOrFail,
} from './lib/gate.mjs'
import { splitStatements } from './lib/sql-parse.mjs'

const GATE = 'migrations'
const DIR = 'supabase/migrations'
const RAMP = '0.2.0'

// DML is judged at STATEMENT level, never by grepping raw text: a SECURITY DEFINER
// RPC's function body legitimately contains INSERT/UPDATE/DELETE that the migration
// itself never executes, and splitStatements carries a dollar-quoted body INSIDE its
// CREATE FUNCTION statement — so a body write can never START a statement. The
// statement-level rule also closes the pinned oddity the old regex shipped with:
// `UPDATE\s+[a-z"]` plus a trailing \b only ever matched a quoted or single-letter
// table name, so `UPDATE notes SET ...` was invisible to the DML rule entirely.
const DML_START =
  /^(?:INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|MERGE\s+INTO|COPY\s+\S+\s+FROM)\b/i
const DML_IN_CTE = /\b(?:INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|MERGE\s+INTO)\b/i
const isDml = (stmt) => DML_START.test(stmt) || (/^WITH\b/i.test(stmt) && DML_IN_CTE.test(stmt))

// Statements that remove an authorization control without removing the object it
// guarded. Each is paired with the vocabulary a reader will recognize in the failure.
// Annotated as a TUPLE array, not inferred. Without this the literal widens to
// `(string | RegExp)[][]`, `re` destructures as `string | RegExp`, and `re.test(code)`
// is a type error the machinery typecheck catches — the label/pattern pairing is a fact
// worth having checked rather than a shape that happens to hold.
/** @type {ReadonlyArray<readonly [string, RegExp]>} */
const AUTHZ_DESTRUCTIVE = [
  ['DROP POLICY', /\bDROP\s+POLICY\b/i],
  ['DISABLE ROW LEVEL SECURITY', /\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i],
  ['NO FORCE ROW LEVEL SECURITY', /\bNO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY\b/i],
  ['DROP FUNCTION', /\bDROP\s+FUNCTION\b/i],
  ['DISABLE TRIGGER', /\bDISABLE\s+TRIGGER\b/i],
  ['REVOKE ... FROM authenticated', /\bREVOKE\b[^;]*\bFROM\b[^;]*\bauthenticated\b/i],
]

// ALTER TABLE takes ACCESS EXCLUSIVE for every form this codebase uses (ADD/DROP
// COLUMN, SET NOT NULL, ADD CONSTRAINT, ENABLE/FORCE RLS), and it is the form that
// runs against a table already serving traffic.
//
// Two deliberate exclusions:
//   DROP TABLE / TRUNCATE — already gated by the ADR requirement above. Stacking a
//   second control on the one statement class a human has demonstrably already
//   stopped to think about buys nothing and trains people to paste the preamble.
//   CREATE INDEX — takes SHARE, which blocks writes but not reads, and the
//   CONCURRENTLY alternative cannot run inside the transaction Supabase wraps a
//   migration in. Mandating it would make adding an index to an existing table
//   impossible via any migration, forever, for every consumer.
// SOURCE: https://www.postgresql.org/docs/17/explicit-locking.html (ACCESS EXCLUSIVE conflicts with every other lock mode)
const ACCESS_EXCLUSIVE = /\bALTER\s+TABLE(?:\s+ONLY)?\s+([a-z0-9_."]+)/gi

if (!existsSync(DIR)) skipOrFail(GATE, `${DIR} not found (no migrations surface yet)`)
const errs = []
// New-in-0.2.0 findings: a consumer whose migrations predate these rules cannot
// retroactively add an ADR to applied history, so they ramp.
/** @type {Array<{file: string, rule: 'authz-adr'|'lock-timeout', msg: string}>} */
const rampedErrs = []
/** @param {string} file @param {'authz-adr'|'lock-timeout'} rule @param {string} msg */
function ramped(file, rule, msg) {
  rampedErrs.push({ file, rule, msg })
}

// 1. append-only — a git failure must never silently VACATE this check: an
// unresolvable base ref in CI (shallow clone) previously returned [] and the
// append-only rule passed without ever diffing. execFileSync (no shell), and
// the failure mode is explicit per environment.
function changedAgainst(ref) {
  let out
  try {
    out = execFileSync('git', ['diff', '--name-status', ref, '--', `${DIR}/*.sql`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    const reason = commandFailureOutput(e).split('\n')[0]
    if (inCI()) {
      fail(
        GATE,
        `git diff against ${ref} failed (${reason}) — the append-only check cannot run. In CI this usually means a shallow checkout: set fetch-depth: 0.`,
      )
    }
    console.log(
      `${GATE}: NOTE — append-only diff skipped locally (${reason}); content rules still run`,
    )
    return []
  }
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'))
    .filter(([status]) => status.startsWith('M') || status.startsWith('D'))
}
const base = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : 'HEAD'
for (const [status, file] of changedAgainst(base)) {
  errs.push(
    `${file}: ${status === 'D' ? 'deleted' : 'modified'} — migrations are append-only; add a NEW migration that transforms the schema forward`,
  )
}

// 2 + 3. content rules over every migration
for (const f of readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()) {
  const text = readFileSync(join(DIR, f), 'utf8')
  const code = text
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
  if (splitStatements(text).some(isDml) && !/--\s*harness-allow-dml:/.test(text)) {
    errs.push(
      `${DIR}/${f}: contains DML — schema migrations carry structure, not data. If this is deliberate reference data, add \`-- harness-allow-dml: <reason>\`.`,
    )
  }
  // 3a. The ORIGINAL destructive set — unramped, as shipped.
  if (/\b(DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE)\b/i.test(code)) {
    const m = text.match(/--\s*adr:\s*(\S+)/)
    if (!m) {
      errs.push(
        `${DIR}/${f}: destructive DDL requires an ADR — add \`-- adr: docs/adr/NNNN-<slug>.md\` referencing the decision record`,
      )
    } else if (!existsSync(m[1])) {
      errs.push(`${DIR}/${f}: referenced ADR ${m[1]} does not exist`)
    }
  }

  // 3b. The AUTHORIZATION-destructive set (0.2.0). Every statement here removes a
  // control while leaving the table in place, so none of them matched the shape
  // above and all of them shipped ADR-free. Dropping a policy, turning RLS off, or
  // revoking the grant the whole model rests on is at least as consequential as
  // dropping a column — and strictly harder to notice in review, because the table
  // still exists and every query still returns rows.
  for (const [label, re] of AUTHZ_DESTRUCTIVE) {
    if (!re.test(code)) continue
    const m = text.match(/--\s*adr:\s*(\S+)/)
    if (!m) {
      ramped(
        f,
        'authz-adr',
        `${DIR}/${f}: ${label} removes an authorization control — add \`-- adr: docs/adr/NNNN-<slug>.md\` recording why`,
      )
    } else if (!existsSync(m[1])) {
      ramped(f, 'authz-adr', `${DIR}/${f}: referenced ADR ${m[1]} does not exist`)
    }
  }

  // 3c. Lock discipline (0.2.0). An ACCESS EXCLUSIVE lock on a table that already
  // holds rows queues every reader and writer behind it; without a lock_timeout the
  // migration waits indefinitely for an open transaction and takes the product down
  // while it waits. A table CREATED in the same file is exempt — nothing can be
  // reading a table that did not exist a statement ago, which is why the seed
  // migrations need no preamble.
  const createdHere = new Set(
    [...code.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_."]+)/gi)].map((m) =>
      m[1]
        .replace(/"/g, '')
        .replace(/^public\./i, '')
        .toLowerCase(),
    ),
  )
  const heavy = [...code.matchAll(ACCESS_EXCLUSIVE)]
    .map((m) =>
      m[1]
        .replace(/"/g, '')
        .replace(/^public\./i, '')
        .toLowerCase(),
    )
    .filter((t) => !createdHere.has(t))
  //
  // The spelling is load-bearing and the OBVIOUS one is wrong. The Supabase CLI does
  // not wrap a migration in an explicit transaction block, so `SET LOCAL lock_timeout`
  // outside one raises `WARNING: SET LOCAL can only be used in transaction blocks` and
  // sets nothing at all. A warning scrolls past in a successful `db reset`, leaving a
  // guard that reads as present and does nothing — so requiring that spelling would be
  // this gate mandating its own vacuity. Plain `SET` is effective in both contexts.
  // Matches either spelling, so a file that used the LOCAL form gets ONLY the precise
  // "it is inert" message below rather than that plus a misleading "you forgot it".
  if (heavy.length > 0 && !/SET\s+(?:LOCAL\s+)?lock_timeout/i.test(code)) {
    ramped(
      f,
      'lock-timeout',
      `${DIR}/${f}: takes an ACCESS EXCLUSIVE lock on pre-existing table(s) ${[...new Set(heavy)].join(', ')} with no lock timeout — add \`SET lock_timeout = '3s';\` as the first statement so the migration fails fast instead of queueing every reader behind an open transaction`,
    )
  }
  if (/SET\s+LOCAL\s+lock_timeout/i.test(code)) {
    ramped(
      f,
      'lock-timeout',
      `${DIR}/${f}: uses \`SET LOCAL lock_timeout\`, which is INERT here — the Supabase CLI applies migrations outside an explicit transaction block, so PostgreSQL answers "WARNING: SET LOCAL can only be used in transaction blocks" and no timeout is set. Drop the LOCAL: \`SET lock_timeout = '3s';\``,
    )
  }
}

// ── the pre-adoption escape, and why it is a FILE rather than a marker ──────────
//
// The two rules above are the only findings in this gate a consumer cannot sweep. An
// ADR reference and a `SET lock_timeout` preamble both live INSIDE the migration, and
// rule 1 above reds any edit to a committed one — so on the day the ramp expires, an
// install whose own pre-0.2.0 migrations carry either finding has a red whose only
// in-file remedy is a different red. 0.3.0 dated the deadline without noticing that.
//
// Editing is also the wrong answer on the merits: a lock_timeout preamble on a
// migration that ran six months ago governs a lock already taken and released, and an
// ADR added retroactively records a decision after the fact. Both rules are entirely
// PROSPECTIVE. What applied history needs is a reviewed acknowledgement, which is what
// every other irreducible finding in this harness gets (rls-exempt.json,
// duplication-allow.json, license-exceptions.json).
//
// Three properties keep it from becoming a hole:
//   - it exempts a (file, rule) PAIR, never a file — a new destructive statement in an
//     already-exempted migration still reds;
//   - the file must ALREADY EXIST at the diff base, so a migration written today
//     cannot be exempted at all. That is the whole point: the escape covers history,
//     not authorship;
//   - a stale entry reds. An exemption whose finding is gone is a standing permission
//     nobody reviewed, waiting for a future statement to walk into it.
const ALLOW = 'tools/migrations-allow.json'
/** @type {Array<{file: string, rule: string, reason: string}>} */
let allow = []
if (existsSync(ALLOW)) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(ALLOW, 'utf8'))
  } catch (e) {
    fail(
      GATE,
      `${ALLOW} is not valid JSON (${e.message}) — the exemption list must be reviewable data`,
    )
  }
  if (!Array.isArray(parsed.allow)) {
    fail(
      GATE,
      `${ALLOW} must carry an "allow" ARRAY of {"file": string, "rule": "authz-adr"|"lock-timeout", "reason": string} entries`,
    )
  }
  for (const entry of parsed.allow) {
    if (
      typeof entry?.file !== 'string' ||
      (entry.rule !== 'authz-adr' && entry.rule !== 'lock-timeout') ||
      typeof entry.reason !== 'string' ||
      entry.reason.trim().length < 20
    ) {
      fail(
        GATE,
        `${ALLOW}: every entry must be {"file": <migration basename>, "rule": "authz-adr"|"lock-timeout", "reason": <why applied history cannot be swept>} with a substantive reason — got ${JSON.stringify(entry)}`,
      )
    }
    allow.push(entry)
  }
}

// The escape covers HISTORY, not authorship: a migration that is new in this change
// has no applied lock and no past decision, so its findings are fixable in-file and
// exempting one would convert the escape into a way of shipping the rule off.
/** @param {string} file @returns {boolean} */
function existsAtBase(file) {
  try {
    execFileSync('git', ['cat-file', '-e', `${base}:${DIR}/${file}`], {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}

const used = new Set()
const exempted = []
const remaining = []
for (const e of rampedErrs) {
  const hit = allow.find((a) => a.file === e.file && a.rule === e.rule)
  if (hit === undefined) {
    remaining.push(e)
    continue
  }
  used.add(`${hit.file} ${hit.rule}`)
  if (existsAtBase(e.file)) {
    exempted.push(e)
  } else {
    errs.push(
      `${ALLOW}: exempts ${e.file} (${e.rule}), but that migration does not exist at ${base} — it is NEW in this change, so the finding is fixable in the file itself. The escape covers applied history, not migrations being written now. Finding: ${e.msg}`,
    )
  }
}
for (const a of allow) {
  if (used.has(`${a.file} ${a.rule}`)) continue
  errs.push(
    `${ALLOW}: exempts ${a.file} (${a.rule}) but that migration produces no such finding — a stale exemption is a standing permission nobody reviewed, waiting for a future statement to walk into it. Delete the entry.`,
  )
}
for (const e of exempted) {
  console.log(`${GATE}: NOTE — (reviewed exemption, ${ALLOW}) ${e.msg}`)
}

if (remaining.length > 0) {
  const isRamped = rampNote(
    GATE,
    RAMP,
    `${remaining.length} finding(s) from the 0.2.0 rules (authorization-destructive DDL needs an ADR; ACCESS EXCLUSIVE needs a lock timeout)`,
    { until: '0.4.0' },
  )
  if (isRamped) for (const e of remaining) console.log(`${GATE}: NOTE — ${e.msg}`)
  else
    errs.push(
      ...remaining.map(
        (e) =>
          `${e.msg}${existsAtBase(e.file) ? ` — if this migration is already APPLIED, the fix belongs in ${ALLOW} (rule "${e.rule}"), because editing a committed migration reds the append-only rule above. See docs/runbooks/harness-upgrade.md.` : ''}`,
      ),
    )
}

failures(GATE, errs)
ok(
  GATE,
  'migrations append-only, DML-free, destructive and authorization-removing changes ADR-coupled, ACCESS EXCLUSIVE lock-bounded',
)
