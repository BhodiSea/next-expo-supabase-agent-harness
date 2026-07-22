// Cross-user isolation over plain Postgres FORCE RLS: as user A, user B's rows must
// be invisible to SELECT, untouchable by UPDATE/DELETE (0 rows matched, no error),
// and un-smugglable via INSERT (WITH CHECK → SQLSTATE 42501). Includes the seeded
// positive control (A sees its own row — a deny-all database must NOT pass), the
// pooled-connection GUC-leak detector, and the catalog gate (FORCE RLS + per-op
// policies + pgvector version straight from pg_catalog).
// SOURCE: docs/harness/README.md (RLS testing doctrine) [corpus: postgres/rls-force]
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  appSql,
  ISOLATION_TARGETS,
  RLS_SUITE_READY,
  type Sql,
  USER_A,
  USER_B,
  withUser,
} from './db-context'

if (!RLS_SUITE_READY) {
  describe.skip('user-scoped isolation (skipped: database not ready)', () => {
    it('database not ready — RLS suite self-skips (run node tests/rls/run-rls.mjs; FAILS CLOSED in CI)', () => {
      expect(true).toBe(true)
    })
  })
} else {
  describe('user-scoped isolation', () => {
    let sql: Sql

    beforeAll(async () => {
      sql = appSql()
      // Seed one row per user per target THROUGH the RLS path (impersonated
      // insert) — proving inserts-as-self work is itself part of the contract.
      for (const t of ISOLATION_TARGETS) {
        for (const user of [USER_A, USER_B]) {
          await withUser(sql, user, async (tx) => {
            await tx`INSERT INTO ${tx(t.table)} ${tx(t.seedRow(user))}`
          })
        }
      }
    })

    afterAll(async () => {
      for (const t of ISOLATION_TARGETS) {
        for (const user of [USER_A, USER_B]) {
          await withUser(sql, user, async (tx) => {
            await tx`DELETE FROM ${tx(t.table)}`
          })
        }
      }
      await sql.end({ timeout: 5 })
    })

    it.each(ISOLATION_TARGETS)('isolates user B rows in $table from user A', async (t) => {
      // POSITIVE CONTROL: A sees its OWN row. Without this, a deny-all database
      // would make every assertion below pass vacuously.
      const own = await withUser(
        sql,
        USER_A,
        (tx) => tx`SELECT * FROM ${tx(t.table)} WHERE ${tx(t.ownerColumn)} = ${USER_A}`,
      )
      expect(own.length).toBeGreaterThanOrEqual(1)

      // SELECT another user's rows → RLS hides them: no error, zero rows.
      const read = await withUser(
        sql,
        USER_A,
        (tx) => tx`SELECT * FROM ${tx(t.table)} WHERE ${tx(t.ownerColumn)} = ${USER_B}`,
      )
      expect(read).toHaveLength(0)

      // UPDATE / DELETE across users: statements match nothing (0 rows), no error.
      // The probed column comes from the target's OWN seed row — hard-coding a
      // column name (the old `SET title = ...`) reds SQLSTATE 42703 on any
      // second ISOLATION_TARGET whose table has no such column.
      const probeSample = t.seedRow(USER_B)
      const probeColumn = Object.keys(probeSample).find((c) => c !== t.ownerColumn)
      if (probeColumn === undefined) {
        throw new Error(`${t.table}: seedRow has no non-owner column to probe`)
      }
      const updated = await withUser(
        sql,
        USER_A,
        (tx) =>
          tx`UPDATE ${tx(t.table)} SET ${tx(probeColumn)} = ${'pwned'} WHERE ${tx(t.ownerColumn)} = ${USER_B}`,
      )
      expect(updated.count).toBe(0)
      const deleted = await withUser(
        sql,
        USER_A,
        (tx) => tx`DELETE FROM ${tx(t.table)} WHERE ${tx(t.ownerColumn)} = ${USER_B}`,
      )
      expect(deleted.count).toBe(0)

      // INSERT smuggling B's id must be rejected by WITH CHECK → SQLSTATE 42501.
      await expect(
        withUser(sql, USER_A, (tx) => tx`INSERT INTO ${tx(t.table)} ${tx(t.seedRow(USER_B))}`),
      ).rejects.toMatchObject({ code: '42501' })

      // B still sees B's data untouched (probe column not 'pwned', row count intact).
      const bOwn = await withUser(
        sql,
        USER_B,
        (tx) =>
          tx`SELECT ${tx(probeColumn)} FROM ${tx(t.table)} WHERE ${tx(t.ownerColumn)} = ${USER_B}`,
      )
      expect(bOwn.length).toBeGreaterThanOrEqual(1)
      for (const row of bOwn) expect(row[probeColumn]).not.toBe('pwned')
    })

    it('does not leak identity across the pooled connection (GUC hygiene)', async () => {
      // withUser sets the GUC transaction-locally; after the transaction the SAME
      // physical connection (pool max=1) must have no identity: current_setting
      // returns NULL and RLS matches nothing.
      await withUser(sql, USER_A, (tx) => tx`SELECT 1`)
      const guc = await sql`SELECT current_setting('app.user_id', true) AS v`
      // Postgres reports "no identity" two ways: NULL on a session that never
      // set the GUC, '' on one that ran SET LOCAL in a now-closed transaction.
      // The policies map BOTH to NULL via nullif(..., '') — any other value
      // here is a real cross-request identity leak.
      const leaked = guc[0]?.['v'] ?? null
      expect(leaked === null || leaked === '', `leaked identity: ${String(leaked)}`).toBe(true)
      for (const t of ISOLATION_TARGETS) {
        const rows = await sql`SELECT * FROM ${sql(t.table)}`
        expect(rows).toHaveLength(0)
      }
    })

    // The account-deletion sweep (Apple 5.1.1(v)) — the LIVE half of the slice:
    // accountDal.deleteAllOwnedData emits an unqualified DELETE (statement shape
    // pinned by apps/server/src/dal/account.test.ts), so under FORCE RLS the
    // policy qual must be the ONLY thing separating "delete my account" from
    // "delete the table". Runs LAST in this describe: it empties user A.
    it.each(
      ISOLATION_TARGETS,
    )('account deletion in $table: an unqualified DELETE as A sweeps ONLY A — B survives', async (t) => {
      // Fresh seeds for both users through the RLS path.
      for (const user of [USER_A, USER_B]) {
        await withUser(sql, user, async (tx) => {
          await tx`INSERT INTO ${tx(t.table)} ${tx(t.seedRow(user))}`
        })
      }
      // The DAL's exact statement shape: DELETE with NO application WHERE.
      const swept = await withUser(sql, USER_A, (tx) => tx`DELETE FROM ${tx(t.table)}`)
      expect(swept.count).toBeGreaterThanOrEqual(1)
      // A's account is empty…
      const aRows = await withUser(sql, USER_A, (tx) => tx`SELECT * FROM ${tx(t.table)}`)
      expect(aRows).toHaveLength(0)
      // …and B's data SURVIVED the unqualified sweep — the whole point.
      const bRows = await withUser(sql, USER_B, (tx) => tx`SELECT * FROM ${tx(t.table)}`)
      expect(bRows.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('catalog gate (pg_catalog facts, not vibes)', () => {
    let sql: Sql
    beforeAll(() => {
      sql = appSql()
    })
    afterAll(async () => {
      await sql.end({ timeout: 5 })
    })

    it('every isolation target has ENABLE + FORCE row security and per-op policies', async () => {
      for (const t of ISOLATION_TARGETS) {
        const rel = await sql`
          SELECT relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE oid = ${`public.${t.table}`}::regclass`
        expect(rel[0], t.table).toMatchObject({
          relrowsecurity: true,
          relforcerowsecurity: true,
        })
        const policies = await sql`
          SELECT cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = ${t.table}`
        const cmds = new Set(policies.map((p) => String(p['cmd'])))
        const covered = (op: string) => cmds.has(op) || cmds.has('ALL')
        for (const op of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          expect(covered(op), `${t.table}: policy FOR ${op}`).toBe(true)
        }
      }
    })

    it('every isolation target owner column is the LEADING column of an index', async () => {
      // Leading-column coverage is what turns the policy qual into an Index Cond —
      // an index with the owner column in second position does not serve
      // `owner = $0`, and every RLS policy filters by it on every statement.
      // SOURCE: PostgreSQL multicolumn index semantics [corpus: postgres/rls-initplan]
      for (const t of ISOLATION_TARGETS) {
        const idx = await sql`
          SELECT c.relname FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
          WHERE i.indrelid = ${`public.${t.table}`}::regclass AND a.attname = ${t.ownerColumn}`
        expect(
          idx.length,
          `${t.table}.${t.ownerColumn}: no leading-column index — add a migration (see 0001_notes_owner_idx.sql)`,
        ).toBeGreaterThanOrEqual(1)
      }
    })

    it('every policy predicate resolves identity through a sub-select (initPlan), per pg_policies', async () => {
      // The static schema-rls gate asserts this on migration TEXT; this asserts it on
      // what the database actually compiled — pg_policies pretty-prints the stored
      // predicate, so a per-row current_setting() shows up here with no `( SELECT`.
      // SOURCE: initPlan sub-select pattern [corpus: postgres/rls-initplan]
      for (const t of ISOLATION_TARGETS) {
        const policies = await sql`
          SELECT policyname, qual, with_check FROM pg_policies
          WHERE schemaname = 'public' AND tablename = ${t.table}`
        expect(policies.length, `${t.table}: has policies`).toBeGreaterThanOrEqual(1)
        for (const p of policies) {
          const preds: [string, unknown][] = [
            ['USING', p['qual']],
            ['WITH CHECK', p['with_check']],
          ]
          for (const [kind, pred] of preds) {
            if (pred === null || pred === undefined) continue
            const text = String(pred)
            expect(
              /\(\s*SELECT\b/i.test(text) && /current_setting/i.test(text),
              `${t.table} policy ${String(p['policyname'])} ${kind} must wrap current_setting in a scalar sub-select (initPlan) — got: ${text}`,
            ).toBe(true)
          }
        }
      }
    })

    it('pgvector is installed at a patched version (>= 0.8.2)', async () => {
      const ext = await sql`SELECT extversion FROM pg_extension WHERE extname = 'vector'`
      expect(ext, 'vector extension installed').toHaveLength(1)
      const [maj = 0, min = 0, pat = 0] = String(ext[0]?.['extversion']).split('.').map(Number)
      // SOURCE: patched pgvector floor per security advisory [corpus: pgvector/hnsw]
      expect(maj * 10000 + min * 100 + pat).toBeGreaterThanOrEqual(802)
    })

    it('the app role is not policy-exempt (no BYPASSRLS, not superuser)', async () => {
      const role = await sql`
        SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      expect(role[0]).toMatchObject({ rolsuper: false, rolbypassrls: false })
    })
  })
}
