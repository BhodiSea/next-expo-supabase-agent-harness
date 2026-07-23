// Cross-tenant isolation proven THROUGH the Supabase client — the transport a real
// Class-A mobile write and a web Server Action both take. Two tenants are created via
// the admin API, sign in for real GoTrue JWTs, and then: tenant A sees its OWN rows
// (the positive control — a deny-all database must NOT pass), a cross-tenant read
// returns the EMPTY SET rather than an error (existence is data; a 403 on "note 91c3…"
// confirms the row exists and belongs to someone else), a cross-tenant DELETE matches
// nothing, an INSERT smuggling another tenant's owner id is rejected by WITH CHECK, and
// an anonymous client — which holds no grant — reads nothing.
//
// This is the client-path twin of supabase/tests/rls_isolation.test.sql (pgTAP, the DB
// boundary via raw role-switch). Both run from `node tests/rls/run-rls.mjs`; this half
// self-skips unless RLS_SUITE_READY=1, so a bare `vitest run` never touches the network.
// SOURCE: supabase/tests/rls_isolation.test.sql (the empty-set principle) [corpus: postgres/rls-force]
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  anonClient,
  createTenant,
  deleteTenant,
  ISOLATION_TARGETS,
  RLS_SUITE_READY,
  resetTenants,
  serviceClient,
  signIn,
  TENANT_A,
  TENANT_B,
} from './db-context'

if (!RLS_SUITE_READY) {
  describe.skip('cross-tenant isolation via the Supabase client (skipped: no local stack)', () => {
    it('self-skips — run `node tests/rls/run-rls.mjs`; this layer FAILS CLOSED in CI', () => {
      expect(true).toBe(true)
    })
  })
} else {
  describe('cross-tenant isolation via the Supabase client', () => {
    let svc: SupabaseClient
    let a: SupabaseClient
    let b: SupabaseClient

    beforeAll(async () => {
      svc = serviceClient()
      await resetTenants(svc) // clear residue from a prior aborted run
      await createTenant(svc, TENANT_A)
      await createTenant(svc, TENANT_B)
      a = await signIn(TENANT_A.email, TENANT_A.password)
      b = await signIn(TENANT_B.email, TENANT_B.password)
      // Seed one row per target per tenant THROUGH the RLS path — that a self-write is
      // ADMITTED is itself part of the contract the INSERT policies encode.
      for (const t of ISOLATION_TARGETS) {
        for (const [client, tenant] of [
          [a, TENANT_A],
          [b, TENANT_B],
        ] as const) {
          const { error } = await client.from(t.table).insert(t.seedRow(tenant.id))
          expect(error, `${tenant.email} self-insert into ${t.table}: ${error?.message}`).toBeNull()
        }
      }
    })

    afterAll(async () => {
      await deleteTenant(svc, TENANT_A)
      await deleteTenant(svc, TENANT_B)
    })

    it.each(ISOLATION_TARGETS)('isolates $table across tenants through PostgREST', async (t) => {
      // POSITIVE CONTROL: A sees its OWN row. Without it, a deny-all database would pass
      // every assertion below for the worst possible reason.
      const own = await a.from(t.table).select(t.ownerColumn).eq(t.ownerColumn, TENANT_A.id)
      expect(own.error, `A own-read ${t.table}: ${own.error?.message}`).toBeNull()
      expect(own.data?.length ?? 0, `A must see its own ${t.table} row`).toBeGreaterThanOrEqual(1)

      // Cross-tenant SELECT → the EMPTY SET, no error. RLS filters rows; it does not
      // reject the statement, so nothing — not even existence — is disclosed.
      const cross = await a.from(t.table).select(t.ownerColumn).eq(t.ownerColumn, TENANT_B.id)
      expect(cross.error, `A cross-read ${t.table} must not raise`).toBeNull()
      expect(cross.data ?? [], `A must see none of B's ${t.table} rows`).toHaveLength(0)

      // Cross-tenant DELETE matches nothing and raises nothing (the returned set is what
      // was actually deleted — empty).
      const del = await a.from(t.table).delete().eq(t.ownerColumn, TENANT_B.id).select()
      expect(del.error, `A cross-delete ${t.table} must not raise`).toBeNull()
      expect(del.data ?? [], `A must delete none of B's ${t.table} rows`).toHaveLength(0)

      // INSERT smuggling B's owner id → rejected by WITH CHECK (surfaced as a PostgREST
      // error, never a silent write).
      const smuggle = await a.from(t.table).insert(t.seedRow(TENANT_B.id))
      expect(
        smuggle.error,
        `A smuggling B's owner id into ${t.table} must be rejected`,
      ).not.toBeNull()

      // B still sees its own row, untouched.
      const bOwn = await b.from(t.table).select(t.ownerColumn).eq(t.ownerColumn, TENANT_B.id)
      expect(
        bOwn.data?.length ?? 0,
        `B must still see its own ${t.table} row`,
      ).toBeGreaterThanOrEqual(1)
    })

    it('an anonymous client reads no rows from a private table', async () => {
      // anon holds no grant on these tables (REVOKE ALL … FROM anon), so it reads
      // nothing — whether PostgREST answers with a permission error or an empty set, the
      // one thing that must never come back is a row.
      const anon = anonClient()
      const res = await anon.from('notes').select('id')
      expect(res.data ?? [], 'anon must read zero rows').toHaveLength(0)
    })
  })
}
