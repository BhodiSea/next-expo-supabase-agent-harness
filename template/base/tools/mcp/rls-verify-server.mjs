#!/usr/bin/env node
// rls_verify MCP server — mid-turn cross-tenant isolation probe.
// Connects with the app's own unprivileged role (DATABASE_URL → app_api, which is
// RLS-subject under FORCE ROW LEVEL SECURITY), impersonates a user via the app.user_id
// GUC, and asserts another user's rows are invisible. Read-only, always rolled back.
// Never a false green: anything that prevents a real probe returns SKIPPED, and the CI
// suite (`pnpm test:rls`) stays authoritative.
// SOURCE: docs/harness/README.md (mid-turn RLS probe) [corpus: harness/doctrine]
import { createRequire } from 'node:module'
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
// read-only transaction; the GUC is transaction-local so nothing leaks.
// SOURCE: transaction-local GUCs, unset returns NULL with the two-arg form [corpus: postgres/guc-set-local]
async function countAs(sql, { table, ownerColumn, asUser, ownerValue }) {
  const rows = await sql.begin('read only', async (tx) => {
    await tx`SELECT set_config('app.user_id', ${asUser}, true)`
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
  // the same unprivileged connection. Zero baseline rows → SKIPPED, never green — an
  // empty table or mistyped id would otherwise make the probe vacuous and report
  // ISOLATED even with RLS broken.
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
  const dbUrl = process.env['DATABASE_URL']
  if (!dbUrl) return 'RLS: SKIPPED (DATABASE_URL not set — start the local db: pnpm db:up)'
  const { table, userA, userB } = args
  const ownerColumn = args.ownerColumn || 'owner_id'
  if (typeof table !== 'string' || typeof userA !== 'string' || typeof userB !== 'string') {
    return 'RLS: SKIPPED (table, userA and userB must all be strings)'
  }
  // The postgres.js driver is a dependency of apps/server, not the workspace root —
  // resolve it from the server package's context so the probe uses the app's own driver.
  let postgres
  try {
    postgres = createRequire(new URL('../../apps/server/package.json', import.meta.url))('postgres')
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
        "Probe cross-user RLS isolation for a table: as userA, assert 0 rows of userB are visible. userB must already own at least one visible row (positive control, checked by impersonating userB) or the probe returns SKIPPED — a vacuous probe is never reported green. Runs on the app's unprivileged role with transaction-local app.user_id GUCs. Returns RLS: ISOLATED / RLS: LEAK / SKIPPED. Read-only, always rolled back. The CI suite (pnpm test:rls) is authoritative.",
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
