#!/usr/bin/env node
// Gate: db-limits — the per-role resource ceilings and the per-org quota machinery
// hold the shape that makes them BIND, not merely the shape that makes them present.
//
// THE GATE HAS AN INVERTED HALF, and it is the half that matters most. Two knobs read
// as obvious hardening, were in this release's own plan, and are REFUSED here:
// `temp_file_limit` (superuser-only, so `postgres` on Supabase cannot set it at all)
// and `CONNECTION LIMIT` (the only role where it would bind is `authenticator`, which
// is reserved; on anon/authenticated/service_role it succeeds and binds nothing,
// because a connection limit applies at LOGIN and none of those three ever log in).
// A number that cannot bind is worse than no number: a reviewer reads it as a control.
// So `unavailable` reds when the knob APPEARS, which is the opposite polarity from
// every other rule here.
//
// WHAT MAKES THE REST BIND, because the manual alone says they do not. `ALTER ROLE x
// SET y` writes a pg_db_role_setting row that PostgreSQL applies when role x STARTS A
// SESSION, and `SET ROLE` does not start a session — verified: as `authenticator`,
// `SET LOCAL ROLE authenticated` left statement_timeout at the AUTHENTICATOR's value.
// They bind because PostgREST reads pg_db_role_setting for the role it impersonates
// and applies it per request. Verified end to end: anon at 2s, authenticator at 8s, a
// 5-second RPC through PostgREST as anon cancelled at 2.03s with SQLSTATE 57014.
//
// The consequence is recorded rather than smoothed over: these ceilings bound traffic
// arriving THROUGH PostgREST — every supabase-js call from web and mobile — and do NOT
// bound a direct connection, which gets its own login role's settings. That is why the
// runtime twin is a CLIENT-side assertion through PostgREST (public.effective_limits())
// and not only a pgTAP read of pg_db_role_setting: the catalog row proves what PostgREST
// will read, never that PostgREST applied it.
//
// THE QUOTA HALF is structural for the same reason: both wrong implementations are one
// word away and neither fails loudly. FOR EACH ROW serializes every insert behind one
// hot tuple; a RESTRICTIVE policy over a STABLE function is hoisted to one evaluation
// per statement against the PRE-statement count, so a single multi-row INSERT of any
// size passes wholesale. The gate therefore asserts FOR EACH STATEMENT + REFERENCING,
// not merely "a trigger exists".
// SOURCE: docs/harness/gates-catalog.md (db-limits) [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'
import { walkFiles } from './lib/fs-walk.mjs'
import { fail, failures, ok, rampNote, skipOrFail, stampGate } from './lib/gate.mjs'
import {
  parseColumnFacts,
  parseFunctions,
  parseGrants,
  parseTriggers,
  qualify,
  readSqlDir,
  readSqlDirByFile,
  splitStatements,
  stripSchema,
} from './lib/sql-parse.mjs'
import { STAMP_INPUTS } from './lib/stamp-inputs.mjs'

const GATE = 'db-limits'
const CONFIG = 'tools/db-limits.json'
const MIGRATIONS_DIR = 'supabase/migrations'
const CONFIG_TOML = 'supabase/config.toml'
const RAMP = '0.2.0'

if (!existsSync(CONFIG)) {
  fail(
    GATE,
    `${CONFIG} is missing — the resource ceilings must exist as reviewable data before any migration is judged against them (restore it from git or re-run the installer update)`,
  )
}
let cfg
try {
  cfg = JSON.parse(readFileSync(CONFIG, 'utf8'))
} catch (e) {
  fail(
    GATE,
    `${CONFIG} is not valid JSON (${e.message}) — the gate fails closed rather than treating an unreadable ceiling list as no ceilings`,
  )
}

// ---------------------------------------------------------------------------
// Contract shape — fail closed on every malformation.
// ---------------------------------------------------------------------------
if (
  cfg.roles === null ||
  typeof cfg.roles !== 'object' ||
  Array.isArray(cfg.roles) ||
  Object.keys(cfg.roles).length === 0
) {
  fail(
    GATE,
    `${CONFIG}: "roles" must map role names to a knob→value object (non-empty) — an empty matrix would green a database with no ceilings at all`,
  )
}
if (cfg.ceilings === null || typeof cfg.ceilings !== 'object' || Array.isArray(cfg.ceilings)) {
  fail(GATE, `${CONFIG}: "ceilings" must map each knob to its maximum in milliseconds`)
}
if (!Array.isArray(cfg.unavailable)) fail(GATE, `${CONFIG}: "unavailable" must be an array`)
for (const e of cfg.unavailable) {
  if (
    e === null ||
    typeof e !== 'object' ||
    typeof e.knob !== 'string' ||
    typeof e.reason !== 'string' ||
    e.reason.trim().length < 20
  ) {
    fail(
      GATE,
      `${CONFIG}: every "unavailable" entry must be {"knob", "reason"} with a substantive reason — recording WHY a knob is refused is the whole value of the entry; got ${JSON.stringify(e)}`,
    )
  }
}
if (
  cfg.quota === null ||
  typeof cfg.quota !== 'object' ||
  !Array.isArray(cfg.quota?.meteredTables)
) {
  fail(GATE, `${CONFIG}: "quota" must be an object carrying a "meteredTables" array`)
}
for (const key of [
  'usageTable',
  'limitTable',
  'defaultsTable',
  'enforceFunction',
  'releaseFunction',
  'reconcileFunction',
  'writerRole',
  'errorCode',
]) {
  if (typeof cfg.quota[key] !== 'string' || cfg.quota[key].trim() === '') {
    fail(
      GATE,
      `${CONFIG}: quota."${key}" must be a non-empty string — a contract missing a section cannot green the checks that section governs`,
    )
  }
}
for (const m of cfg.quota.meteredTables) {
  if (
    m === null ||
    typeof m !== 'object' ||
    typeof m.table !== 'string' ||
    typeof m.metric !== 'string' ||
    typeof m.reason !== 'string' ||
    m.reason.trim() === ''
  ) {
    fail(
      GATE,
      `${CONFIG}: every meteredTables entry must be {"table", "metric", "reason"} — got ${JSON.stringify(m)}`,
    )
  }
}

/** '3s' / '250ms' / '30000' -> milliseconds, or null when unparseable. */
function toMs(value) {
  const m = String(value)
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*(ms|s|min|h)?$/i)
  if (m === null) return null
  const n = Number(m[1])
  switch ((m[2] ?? 'ms').toLowerCase()) {
    case 'ms':
      return n
    case 's':
      return n * 1000
    case 'min':
      return n * 60_000
    case 'h':
      return n * 3_600_000
    default:
      return null
  }
}

for (const [role, knobs] of Object.entries(cfg.roles)) {
  for (const [knob, value] of Object.entries(knobs)) {
    if (toMs(value) === null) {
      fail(
        GATE,
        `${CONFIG}: roles.${role}.${knob} = ${JSON.stringify(value)} is not a parseable duration — a ceiling nobody can compare against is not a ceiling`,
      )
    }
    if (cfg.ceilings[knob] === undefined) {
      fail(
        GATE,
        `${CONFIG}: roles.${role} sets "${knob}" but "ceilings" declares no maximum for it — every knob under review needs a bound, or raising it later is unreviewed`,
      )
    }
  }
}

const recordGreen = stampGate(GATE, STAMP_INPUTS[GATE])

if (!existsSync(MIGRATIONS_DIR))
  skipOrFail(GATE, `${MIGRATIONS_DIR} not found (no migration surface yet)`)

const statements = splitStatements(readSqlDir(MIGRATIONS_DIR))
const errs = []

// ---------------------------------------------------------------------------
// 1. The role × knob matrix, folded in statement order.
// ---------------------------------------------------------------------------
// Folded rather than collected, because `ALTER ROLE x RESET y` and a later re-SET are
// both legal and the LAST word is what the database ends up holding. A gate that only
// collected SETs would report a ceiling that a subsequent RESET had removed.
const applied = new Map() // role -> Map<knob, value|null>
for (const stmt of statements) {
  const m = stmt.match(
    /^ALTER ROLE ([a-z0-9_]+)\s+(?:IN DATABASE [a-z0-9_]+\s+)?(SET|RESET)\s+([a-z0-9_]+)(?:\s*(?:=|TO)\s*(.+))?$/i,
  )
  if (m === null) continue
  const [, roleRaw, verb, knobRaw, valueRaw] = m
  const role = roleRaw.toLowerCase()
  const knob = knobRaw.toLowerCase()
  if (!applied.has(role)) applied.set(role, new Map())
  applied
    .get(role)
    .set(
      knob,
      verb.toUpperCase() === 'RESET' ? null : (valueRaw ?? '').trim().replace(/^'|'$/g, ''),
    )
}

const anyRoleSetting = [...applied.values()].some((knobs) =>
  [...knobs.values()].some((v) => v !== null),
)

// The adoption seam. An install predating 0.2.0 has no resource-limit migration at
// all, and hard-failing it would be an upgrade ambush; the moment ANY role setting
// exists the surface is adopted and every rule below is a hard red.
if (!anyRoleSetting) {
  if (
    rampNote(
      GATE,
      RAMP,
      `no ALTER ROLE ... SET in any migration — the per-role ceilings arrive in ${RAMP}`,
      { until: '0.4.0' },
    )
  ) {
    ok(
      GATE,
      `pre-${RAMP} install without resource ceilings — adopt via docs/adr/20260203-resource-limits.md`,
    )
  }
  skipOrFail(GATE, 'no per-role resource settings in any migration')
}

// ─────────────────────────────────────────────────────────────────────────────
// A ceiling without a schema reload is a ceiling that does not bind.
// ─────────────────────────────────────────────────────────────────────────────
// PostgREST caches pg_db_role_setting in its schema cache and applies the CACHED copy;
// it does not re-read the catalog per request. Supabase's `pgrst_ddl_watch` event
// trigger issues the reload for ordinary DDL, and it cannot help here: event triggers
// do not fire for shared objects, and roles are shared. So `ALTER ROLE ... SET` is the
// one statement class that changes what a limit SHOULD be while never triggering the
// reload that makes it so.
//
// Checked PER FILE, because the failure is per-deployment. A NOTIFY in some older
// migration did not reload anything for the migration being added today, so requiring
// one "somewhere in the directory" would pass the exact tree that breaks.
//
// This is the same rule as the `unavailable` list above, in a different disguise: a
// number that reads as a control and bounds nothing. It is worse here, because the
// value IS correct in the catalog — every static check, including this gate's own
// matrix and the pgTAP catalog assertion, agrees the ceiling is set. Only traffic
// disagrees, and only on an already-running project: a fresh `supabase start` boots
// PostgREST after migrations, so every local run and every CI lane looks green.
// SOURCE: https://www.postgresql.org/docs/17/event-trigger-matrix.html (event triggers do not fire for shared objects)
const NOTIFY_PGRST = /^NOTIFY\s+pgrst\b/i
const ROLE_SET = /^ALTER ROLE\s+[a-z0-9_]+\s+(?:IN DATABASE [a-z0-9_]+\s+)?(?:SET|RESET)\s/i
for (const { file, statements: fileStatements } of readSqlDirByFile(MIGRATIONS_DIR)) {
  if (!fileStatements.some((s) => ROLE_SET.test(s.trim()))) continue
  if (fileStatements.some((s) => NOTIFY_PGRST.test(s.trim()))) continue
  errs.push(
    `${file}: changes a per-role ceiling with \`ALTER ROLE ... SET/RESET\` but never issues \`NOTIFY pgrst, 'reload schema'\`. PostgREST serves role settings from its schema cache, and the pgrst_ddl_watch event trigger does not fire for roles (shared objects), so this ceiling will not bind API traffic until PostgREST restarts for some unrelated reason. Add \`NOTIFY pgrst, 'reload schema';\` at the end of the migration`,
  )
}

for (const [role, knobs] of Object.entries(cfg.roles)) {
  const live = applied.get(role.toLowerCase())
  for (const [knob, want] of Object.entries(knobs)) {
    const got = live?.get(knob.toLowerCase())
    if (got === undefined) {
      errs.push(
        `${role}: no \`ALTER ROLE ${role} SET ${knob}\` in any migration — ${CONFIG} declares it as a ceiling, and a declared ceiling that no migration applies is a control that exists only in a JSON file. Add it to a migration`,
      )
      continue
    }
    if (got === null) {
      errs.push(
        `${role}: ${knob} is RESET by a later migration — an earlier SET does not survive it, so the ceiling ${CONFIG} declares is not in force. Re-set it in a NEW migration, or remove it from the contract`,
      )
      continue
    }
    const gotMs = toMs(got)
    const wantMs = toMs(want)
    if (gotMs === null) {
      errs.push(
        `${role}.${knob} is set to '${got}', which is not a parseable duration — PostgreSQL would reject it at apply time or read it as milliseconds`,
      )
      continue
    }
    if (gotMs !== wantMs) {
      errs.push(
        `${role}.${knob} is '${got}' in the migration but '${want}' in ${CONFIG} — the reviewed ceiling and the applied value must agree, or the contract describes a database nobody runs`,
      )
    }
    const ceiling = toMs(cfg.ceilings[knob])
    if (ceiling !== null && gotMs > ceiling) {
      errs.push(
        `${role}.${knob} = '${got}' (${gotMs}ms) exceeds the ${knob} ceiling of ${ceiling}ms in ${CONFIG} — raising a ceiling is a reviewed widening, so it belongs in the contract diff, not only in a migration`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// 2. The inverted rule: knobs that must NEVER appear.
// ---------------------------------------------------------------------------
for (const entry of cfg.unavailable) {
  const knob = entry.knob.toLowerCase()
  if (knob === 'connection limit') {
    for (const stmt of statements) {
      const m = stmt.match(/^ALTER ROLE ([a-z0-9_]+)\s+CONNECTION LIMIT\s+(-?\d+)/i)
      if (m === null || m[2] === '-1') continue
      errs.push(
        `${m[1]}: \`CONNECTION LIMIT ${m[2]}\` — ${entry.reason} Remove it: a number in pg_authid that bounds nothing reads to a reviewer as a control that exists.`,
      )
    }
    continue
  }
  for (const [role, knobs] of applied) {
    if (knobs.has(knob) && knobs.get(knob) !== null) {
      errs.push(
        `${role}: sets '${entry.knob}', which ${CONFIG} records as unavailable on this platform — ${entry.reason}`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// 3. The quota machinery's SHAPE.
// ---------------------------------------------------------------------------
const triggers = parseTriggers(statements)
const functions = parseFunctions(statements)
const columnFacts = parseColumnFacts(statements)
const grants = parseGrants(statements)
const enforceFn = qualify(cfg.quota.enforceFunction).qualified
const releaseFn = qualify(cfg.quota.releaseFunction).qualified
const reconcileFn = qualify(cfg.quota.reconcileFunction).qualified
const usageTable = stripSchema(cfg.quota.usageTable)
const limitTable = stripSchema(cfg.quota.limitTable)

const quotaAdopted = columnFacts.has(usageTable)
if (!quotaAdopted) {
  if (
    !rampNote(
      GATE,
      RAMP,
      `no ${cfg.quota.usageTable} table — the per-org quota arrives in ${RAMP}`,
      { until: '0.4.0' },
    )
  ) {
    errs.push(
      `${cfg.quota.usageTable}: named by ${CONFIG} as the usage counter but no migration creates it — without it no metered table has a limit`,
    )
  }
} else {
  for (const m of cfg.quota.meteredTables) {
    const table = stripSchema(m.table)
    const add = triggers.find(
      (t) =>
        t.table === table &&
        t.timing === 'AFTER' &&
        t.events.includes('INSERT') &&
        t.execute !== null &&
        qualify(t.execute).qualified === enforceFn,
    )
    if (add === undefined) {
      errs.push(
        `${table}: metered for '${m.metric}' in ${CONFIG} but no AFTER INSERT trigger executes ${cfg.quota.enforceFunction} — the limit is declared and unenforced, which is the shape that reads as a quota and is not one`,
      )
    } else {
      // THE TWO WRONG ANSWERS, both one word from the right one.
      if (add.forEach !== 'STATEMENT') {
        errs.push(
          `${table}: quota trigger ${add.name} is FOR EACH ROW — that serializes every insert behind the org's single usage tuple, so a 1000-row import becomes 1000 sequential lock acquisitions and 1000 dead tuples on one page. Use FOR EACH STATEMENT with REFERENCING NEW TABLE`,
        )
      }
      if (!/\bREFERENCING\b[^)]*\bNEW TABLE\b/i.test(add.stmt)) {
        errs.push(
          `${table}: quota trigger ${add.name} declares no \`REFERENCING NEW TABLE\` — a statement-level trigger without a transition table cannot see how many rows the statement added, so it can only ever count zero`,
        )
      }
      if (add.when !== null) {
        errs.push(
          `${table}: quota trigger ${add.name} carries a WHEN clause — a conditional quota is a quota with a documented bypass`,
        )
      }
    }
    const release = triggers.find(
      (t) =>
        t.table === table &&
        t.timing === 'AFTER' &&
        t.events.includes('DELETE') &&
        t.execute !== null &&
        qualify(t.execute).qualified === releaseFn,
    )
    if (release === undefined) {
      errs.push(
        `${table}: no AFTER DELETE trigger executing ${cfg.quota.releaseFunction} — a counter that only ever increments turns every delete into a permanent debit, so an org that clears its rows stays at its limit forever`,
      )
    } else if (
      release.forEach !== 'STATEMENT' ||
      !/\bREFERENCING\b[^)]*\bOLD TABLE\b/i.test(release.stmt)
    ) {
      errs.push(
        `${table}: release trigger ${release.name} must be FOR EACH STATEMENT with \`REFERENCING OLD TABLE\` — the same reasoning as the increment`,
      )
    }
  }

  // A RESTRICTIVE policy over a STABLE function is the alternative that fails OPEN.
  for (const stmt of statements) {
    if (!/^CREATE POLICY/i.test(stmt) || !/\bAS RESTRICTIVE\b/i.test(stmt)) continue
    const target = stmt.match(/^CREATE POLICY [a-z0-9_]+ ON ([a-z0-9_.]+)/i)?.[1]
    if (target === undefined) continue
    if (
      cfg.quota.meteredTables.some((m) => stripSchema(m.table) === stripSchema(target)) &&
      /count\s*\(/i.test(stmt)
    ) {
      errs.push(
        `${stripSchema(target)}: a RESTRICTIVE policy counting rows — the planner hoists a STABLE call to ONE evaluation per statement against the PRE-statement count, so a single multi-row INSERT of any size passes wholesale. This is the alternative that fails OPEN and looks correct; enforcement belongs in the statement-level trigger`,
      )
    }
  }

  // The reconciler must stay unscoped, and this is the check for the failure that is
  // both silent and total: reassigned to the tenant-scoped writer role, it would run
  // from cron with no JWT, read an empty scope, and set EVERY counter to zero.
  for (const stmt of statements) {
    const m = stmt.match(/^ALTER FUNCTION ([a-z0-9_.]+)\s*\([^)]*\)\s+OWNER TO ([a-z0-9_]+)/i)
    if (m === null) continue
    if (qualify(m[1]).qualified === reconcileFn) {
      errs.push(
        `${cfg.quota.reconcileFunction}: ownership reassigned to '${m[2]}'. It must stay owned by the migration role. Reconciliation recomputes EVERY org's usage from count(*) — a tenant-scoped owner resolves its policies through the caller's identity, and pg_cron runs with no JWT, so the scope comes back EMPTY, the truth set is empty, and every counter in the database is silently set to zero on a schedule. Safety here comes from unreachability (EXECUTE revoked from PUBLIC, anon, authenticated), never from a scoped owner`,
      )
    }
  }
  const reconcile = functions.find((f) => f.qualified === reconcileFn)
  if (reconcile === undefined) {
    errs.push(
      `${cfg.quota.reconcileFunction}: named by ${CONFIG} but defined in no migration — every incrementing counter drifts (a disabled trigger, a logical restore, a bug in a decrement), and drift UP blocks a paying customer while drift DOWN gives the product away. Recomputing from count(*) is the only thing that closes both`,
    )
  } else {
    // Matched on BOTH spellings: parseGrants strips a `public.` qualifier from its
    // target, so a `GRANT ... ON FUNCTION public.reconcile_org_usage()` arrives here
    // as the bare name while the contract names it qualified. Comparing only the
    // qualified form silently matched nothing — the check existed and never fired.
    const reconcileNames = new Set([reconcileFn, qualify(cfg.quota.reconcileFunction).name])
    for (const role of ['authenticated', 'anon']) {
      const granted = grants.some(
        (g) =>
          g.kind === 'GRANT' &&
          g.privileges.includes('EXECUTE') &&
          reconcileNames.has(g.target.replace(/\(.*$/, '').trim()) &&
          g.roles.includes(role),
      )
      if (granted) {
        errs.push(
          `${cfg.quota.reconcileFunction}: EXECUTE granted to ${role} — the reconciler reads every org's rows and rewrites every counter. Its safety is that no client can call it`,
        )
      }
    }
  }

  // The counter must not be client-writable. This is the whole point of the writer
  // role: a tenant who can UPDATE org_usage has no quota.
  for (const g of grants) {
    if (g.kind !== 'GRANT') continue
    if (![usageTable, limitTable].includes(g.target)) continue
    const writes = g.privileges.filter((p) =>
      ['INSERT', 'UPDATE', 'DELETE', 'ALL', 'ALL PRIVILEGES'].includes(p),
    )
    const clients = g.roles.filter((r) => ['authenticated', 'anon', 'service_role'].includes(r))
    if (writes.length > 0 && clients.length > 0) {
      errs.push(
        `${g.target}: GRANT ${writes.join(', ')} TO ${clients.join(', ')} — a tenant that can write its own usage counter or raise its own limit has no quota. Writes go only through ${cfg.quota.writerRole}, which is reachable solely as the owner of ${cfg.quota.enforceFunction} (statement: ${g.stmt})`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// 4. config.toml: the row cap and the pooler mode.
// ---------------------------------------------------------------------------
if (existsSync(CONFIG_TOML)) {
  const toml = readFileSync(CONFIG_TOML, 'utf8')
  const maxRows = Number(toml.match(/^\s*max_rows\s*=\s*(\d+)/m)?.[1] ?? NaN)
  if (Number.isNaN(maxRows)) {
    errs.push(
      `${CONFIG_TOML}: no [api].max_rows — without it a client that forgets a range header turns a table scan into a response body; the cap makes the pathological case slow-but-survivable instead of an outage`,
    )
  } else if (maxRows > cfg.apiMaxRows) {
    errs.push(
      `${CONFIG_TOML}: [api].max_rows = ${maxRows} exceeds the reviewed cap of ${cfg.apiMaxRows} in ${CONFIG}`,
    )
  }
  // A pooler in SESSION mode holds one backend per client for the connection's whole
  // life, which is how a serverless deployment exhausts the pool with idle callers.
  // Sliced by index rather than by a lookahead regex. The obvious `(?=^\[|\Z)` is a
  // PERL anchor: JavaScript has no \Z, so it reads as a literal 'Z', the alternation
  // never matches end-of-input, and the section came back undefined for the last block
  // in the file — which is exactly where [db.pooler] sits.
  const poolerStart = toml.search(/^\[db\.pooler\]/m)
  const poolerRest = poolerStart === -1 ? '' : toml.slice(poolerStart + 1)
  const nextSection = poolerRest.search(/^\[/m)
  const pooler =
    poolerStart === -1
      ? undefined
      : poolerRest.slice(0, nextSection === -1 ? undefined : nextSection)
  if (pooler !== undefined && /enabled\s*=\s*true/.test(pooler)) {
    const mode = pooler.match(/pool_mode\s*=\s*"([a-z]+)"/)?.[1]
    if (mode !== cfg.poolerMode) {
      errs.push(
        `${CONFIG_TOML}: [db.pooler] pool_mode is ${mode === undefined ? 'unset' : `"${mode}"`}, expected "${cfg.poolerMode}" — session mode pins one backend per client for the life of the connection, so a serverless deployment exhausts the pool with callers that are doing nothing`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Pooled-connection discipline, tree-wide.
// ---------------------------------------------------------------------------
// Transaction mode hands the same backend to a different tenant between statements,
// which turns three ordinary-looking lines into cross-request defects:
//
//   - a `postgres()` client with prepared statements on: the statement was prepared
//     on a backend the next request does not get, and the driver sends the cached
//     NAME. Intermittent 26000, load-dependent, invisible against a direct connection.
//   - `SET statement_timeout` (no LOCAL): the ceiling stays on the session and the
//     next tenant's request inherits it — the per-role ceilings above, silently gone.
//   - `pg_advisory_lock`: session-scoped, so an error path leaks a lock that no pool
//     release clears and every later caller of that key blocks forever.
//
// The write-guard denies all three at the moment of the edit (pg-prepared-statement,
// pg-session-timeout-set, pg-advisory-session-lock). This is the tree-wide half: the
// hook cannot see a file it did not watch being written — a file that arrived by
// `git merge`, by an installer update, or before the rule existed.
//
// The walk is deliberately NOT a fixed file list. The two known constructions today
// are tools/mcp/rls-verify-server.mjs and tests/rls/db-context.ts, and a gate that
// names them is green by construction the moment someone adds a third.
const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  'android',
  'ios',
])
// Two non-constructions have to stay out: `postgres(?:ql)?://` in a URL-validating
// regex (the shipped env validator and the secret scanner both contain exactly that,
// hence the `(?!\?)`) and prose — including this gate's OWN failure message, which
// says "a postgres() client built without…" and self-flagged before the leading
// context was required. A real construction is assigned, awaited, returned, or passed.
const PG_CONSTRUCTION = /(?:[=(,]|\bawait\b|\breturn\b)\s*postgres\s*\(\s*(?!\?)/g
const SESSION_TIMEOUT =
  /(?<!\bALTER\s+(?:ROLE|DATABASE)\s+[\w"]+\s+)\bSET\s+(?!LOCAL\b)(?:SESSION\s+)?(?:statement_timeout|lock_timeout|idle_in_transaction_session_timeout)\s*(?:=|TO)/i
const SESSION_ADVISORY = /\bpg_advisory_(?:un)?lock(?:_shared)?\s*\(/i
const lineOf = (text, index) => text.slice(0, index).split('\n').length

const sourceFiles = (root) =>
  walkFiles(root, { excludeDirs: SKIP_DIRS, filter: (p) => SOURCE_EXT.test(p) }).map(
    (rel) => `${root}/${rel}`,
  )

// Connection construction and advisory locks are judged EVERYWHERE, tools/ and tests/
// included — tools/mcp/rls-verify-server.mjs is the one real postgres() client in a
// shipped scaffold, so a walk that skipped tools/ would cover none of them.
for (const file of ['apps', 'packages', 'supabase/functions', 'tools', 'tests'].flatMap(
  sourceFiles,
)) {
  const text = readFileSync(file, 'utf8')
  for (const m of text.matchAll(PG_CONSTRUCTION)) {
    // 600 chars, not the whole file: `prepare: false` on a LATER construction must not
    // clear an earlier one. This is the per-construction closure the hook's file-scoped
    // tripwire cannot do.
    if (!/prepare\s*:\s*false/.test(text.slice(m.index, m.index + 600))) {
      errs.push(
        `${file}:${lineOf(text, m.index)}: a postgres() client built without \`prepare: false\` — under a transaction-mode pooler statements from different clients share a backend, so a prepared statement is missing when the next one lands. The failure is intermittent and reads as data corruption`,
      )
    }
  }
  const advisory = SESSION_ADVISORY.exec(text)
  if (advisory !== null) {
    errs.push(
      `${file}:${lineOf(text, advisory.index)}: takes a SESSION-scoped advisory lock (${advisory[0].trim()}) — it outlives the request that took it, so an error path leaks a lock that blocks every later caller of that key and no pool release clears it. Use pg_advisory_xact_lock, which the transaction end releases unconditionally`,
    )
  }
}

// The timeout rule is scoped to RUNTIME code — the same roots the write-guard's
// pg-session-timeout-set uses, and for a reason that is not stylistic: a gate script
// under tools/ legitimately PRINTS the statement as remediation advice. This rule
// walked tools/ for exactly one run, and reddened every scaffold on
// check-migrations.mjs's own fix message ("add `SET lock_timeout = '3s';`"). Discussing
// a statement is not executing it, and only runtime code holds a pooled connection.
for (const file of ['apps', 'packages', 'supabase/functions'].flatMap(sourceFiles)) {
  const text = readFileSync(file, 'utf8')
  const timeout = SESSION_TIMEOUT.exec(text)
  if (timeout !== null) {
    errs.push(
      `${file}:${lineOf(text, timeout.index)}: sets a timeout GUC at SESSION scope (${timeout[0].trim()}) — a pooled backend carries it into the NEXT tenant's request, so one slow report permanently widens someone else's ceiling. Use \`SET LOCAL\` inside the transaction, or change the reviewed per-role value in ${CONFIG}`,
    )
  }
}

failures(
  GATE,
  errs,
  `The contract is ${CONFIG}: "roles"/"ceilings" are the applied matrix, "unavailable" is the INVERTED half (those knobs must never appear, because on this platform they bind nothing), and "quota" fixes the trigger shape. Widening any of them is a CODEOWNERS-reviewed diff.`,
)
recordGreen()
ok(
  GATE,
  `${Object.keys(cfg.roles).length} role(s) × ${Object.keys(cfg.ceilings).length} ceiling(s) applied and under budget; ${cfg.unavailable.length} unavailable knob(s) absent; ${quotaAdopted ? `${cfg.quota.meteredTables.length} metered table(s) enforced by a statement-level trigger with a transition table, reconciler unscoped and client-unreachable` : 'quota not adopted'}; [api].max_rows <= ${cfg.apiMaxRows}`,
)
