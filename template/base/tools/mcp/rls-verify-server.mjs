#!/usr/bin/env node
// rls_verify MCP server — mid-turn cross-tenant isolation probe.
// Connects to the local database (SUPABASE_DB_URL) and, inside a read-only
// transaction, impersonates a user the SUPABASE way: `SET LOCAL ROLE
// authenticated` (so RLS applies — the authenticated role is policy-subject,
// never BYPASSRLS) plus a transaction-local `request.jwt.claims` whose `sub` is
// the user's id, which is exactly what `auth.uid()` reads. It then asserts
// another user's rows are invisible. Read-only, always rolled back.
// Never a false green: anything that prevents a real probe returns SKIPPED, and
// the CI suite (`node tests/rls/run-rls.mjs`) stays authoritative.
// SOURCE: docs/harness/README.md (mid-turn RLS probe) [corpus: harness/doctrine]
import process from 'node:process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

// Identifiers must be allow-listed against information_schema before they touch SQL text —
// never interpolate an unvalidated table/column name. Validated names are then double-quoted.
async function assertKnownColumn(sql, table, column) {
  const rows = await sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}`
  return rows.length > 0
}

const quoteIdent = (name) => `"${name.replaceAll('"', '""')}"`

// Count `ownerValue`'s rows in `table` while impersonating `asUser`. Runs in its own
// read-only transaction; ROLE and the GUC are transaction-local so nothing leaks.
// SOURCE: request.jwt.claims + SET LOCAL ROLE authenticated is Supabase's RLS
// impersonation model — auth.uid() reads the claims' `sub` [corpus: postgres/rls-force]
async function countAs(sql, { table, ownerColumn, asUser, ownerValue }) {
  const rows = await sql.begin('read only', async (tx) => {
    await tx`SET LOCAL ROLE authenticated`
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: asUser, role: 'authenticated' })}, true)`
    return tx.unsafe(
      `SELECT count(*)::int AS n FROM ${quoteIdent(table)} WHERE ${quoteIdent(ownerColumn)} = $1`,
      [ownerValue],
    )
  })
  return rows[0].n
}

async function runProbe(sql, { table, ownerColumn, userA, userB }) {
  if (!(await assertKnownColumn(sql, table, ownerColumn))) {
    return `RLS: SKIPPED (unknown identifier: public.${table}.${ownerColumn} is not in information_schema.columns — refusing to build SQL from it)`
  }
  // Positive control: as userB, userB's own rows must be visible. Under FORCE RLS even
  // the table owner is policy-subject, so the only honest baseline is self-visibility on
  // the same `authenticated` role. Zero baseline rows → SKIPPED, never green — an empty
  // table or mistyped id would otherwise make the probe vacuous and report ISOLATED even
  // with RLS broken.
  // SOURCE: docs/harness/README.md (seeded positive control) [corpus: harness/doctrine]
  const baseline = await countAs(sql, { table, ownerColumn, asUser: userB, ownerValue: userB })
  if (baseline === 0) {
    return `RLS: SKIPPED (vacuous probe: as ${userB}, 0 own rows visible in ${table} — seed at least one row for userB first)`
  }
  const leaked = await countAs(sql, { table, ownerColumn, asUser: userA, ownerValue: userB })
  return leaked === 0
    ? `RLS: ISOLATED (as ${userA}, 0 of ${userB}'s ${String(baseline)} row(s) visible in ${table})`
    : `RLS: LEAK (as ${userA}, ${String(leaked)} of ${userB}'s row(s) visible in ${table} via ${ownerColumn})`
}

async function rlsVerify(args) {
  const dbUrl = process.env['SUPABASE_DB_URL']
  if (!dbUrl) return 'RLS: SKIPPED (SUPABASE_DB_URL not set — start the local stack: supabase start)'
  const { table, userA, userB } = args
  const ownerColumn = args.ownerColumn || 'owner_id'
  if (typeof table !== 'string' || typeof userA !== 'string' || typeof userB !== 'string') {
    return 'RLS: SKIPPED (table, userA and userB must all be strings)'
  }
  // The `postgres` driver is dev-only tooling for this probe (the app talks to the
  // database through supabase-js/PostgREST). Load it lazily so a missing install is a
  // clean skip, never a crash.
  let postgres
  try {
    ;({ default: postgres } = await import('postgres'))
  } catch {
    return 'RLS: SKIPPED (the `postgres` driver is not installed — run pnpm install)'
  }
  const sql = postgres(dbUrl, { max: 1, prepare: false })
  try {
    return await runProbe(sql, { table, ownerColumn, userA, userB })
  } catch (err) {
    // Never a false green — any failure to complete a real probe is reported as a skip.
    return `RLS: SKIPPED (${err instanceof Error ? err.message : String(err)})`
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {})
  }
}

const server = new Server({ name: 'rls_verify', version: '0.1.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      description:
        "Probe cross-user RLS isolation for a table: as userA, assert 0 rows of userB are visible. userB must already own at least one visible row (positive control, checked by impersonating userB) or the probe returns SKIPPED — a vacuous probe is never reported green. Runs on the `authenticated` role with a transaction-local request.jwt.claims (auth.uid() reads its `sub`). Returns RLS: ISOLATED / RLS: LEAK / SKIPPED. Read-only, always rolled back. The CI suite (node tests/rls/run-rls.mjs) is authoritative.",
      inputSchema: {
        properties: {
          table: { type: 'string' },
          userA: { type: 'string', description: 'uuid to impersonate' },
          userB: { type: 'string', description: 'uuid whose rows must be invisible to userA' },
          ownerColumn: { description: 'owner id column (default owner_id)', type: 'string' },
        },
        required: ['table', 'userA', 'userB'],
        type: 'object',
      },
      name: 'rls_verify',
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const text = await rlsVerify(req.params.arguments ?? {})
  return { content: [{ text, type: 'text' }] }
})

await server.connect(new StdioServerTransport())
