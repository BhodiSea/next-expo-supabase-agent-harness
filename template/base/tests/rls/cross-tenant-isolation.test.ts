// Cross-tenant isolation proven THROUGH the Supabase client — the transport a real
// Class-A mobile write and a web Server Action both take. Two tenants are created via
// the admin API, sign in for real GoTrue JWTs, bootstrap themselves through the same
// SECURITY DEFINER RPCs the application calls, and then: tenant A sees its OWN rows
// (the positive control — a deny-all database must NOT pass), a cross-tenant read
// returns the EMPTY SET rather than an error (existence is data; a 403 on "note 91c3…"
// confirms the row exists and belongs to someone else), a cross-tenant DELETE matches
// nothing, an INSERT smuggling another tenant's scope is rejected, a direct write to a
// seat table is refused outright, and an anonymous client — which holds no grant —
// reads nothing.
//
// This is the client-path twin of supabase/tests/rls_isolation.test.sql (pgTAP, the DB
// boundary via raw role-switch). Both run from `node tests/rls/run-rls.mjs`; this half
// self-skips unless RLS_SUITE_READY=1, so a bare `vitest run` never touches the network.
// SOURCE: supabase/tests/rls_isolation.test.sql (the empty-set principle) [corpus: postgres/rls-force]
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  anonClient,
  bootstrapTenant,
  createTenant,
  deleteTenant,
  ISOLATION_TARGETS,
  RLS_SUITE_READY,
  resetTenants,
  serviceClient,
  signIn,
  TENANT_A,
  TENANT_B,
  type TenantContext,
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
    let ctxA: TenantContext
    let ctxB: TenantContext

    beforeAll(async () => {
      svc = serviceClient()
      await resetTenants(svc) // clear residue from a prior aborted run
      await createTenant(svc, TENANT_A)
      await createTenant(svc, TENANT_B)
      a = await signIn(TENANT_A.email, TENANT_A.password)
      b = await signIn(TENANT_B.email, TENANT_B.password)

      // The tenancy bootstrap, through the RPCs. There is no direct-write path to
      // orgs, memberships or invitations — `authenticated` holds no INSERT grant on
      // any of them — so reaching the assertions at all proves the definer write
      // path works end to end.
      ctxA = await bootstrapTenant(a, TENANT_A.id, 'a')
      ctxB = await bootstrapTenant(b, TENANT_B.id, 'b')

      // Then the directly-writable rows, THROUGH the RLS path: that a self-write is
      // ADMITTED is itself part of the contract the INSERT policies encode.
      for (const t of ISOLATION_TARGETS.filter((x) => x.provision === 'direct')) {
        for (const [client, ctx, who] of [
          [a, ctxA, TENANT_A.email],
          [b, ctxB, TENANT_B.email],
        ] as const) {
          const { error } = await client.from(t.table).insert(t.row(ctx))
          expect(error, `${who} self-insert into ${t.table}: ${error?.message}`).toBeNull()
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
      const own = await a.from(t.table).select(t.ownerColumn).eq(t.ownerColumn, t.scopeValue(ctxA))
      expect(own.error, `A own-read ${t.table}: ${own.error?.message}`).toBeNull()
      expect(own.data?.length ?? 0, `A must see its own ${t.table} row`).toBeGreaterThanOrEqual(1)

      // Cross-tenant SELECT → the EMPTY SET, no error. RLS filters rows; it does not
      // reject the statement, so nothing — not even existence — is disclosed.
      const cross = await a
        .from(t.table)
        .select(t.ownerColumn)
        .eq(t.ownerColumn, t.scopeValue(ctxB))
      expect(cross.error, `A cross-read ${t.table} must not raise`).toBeNull()
      expect(cross.data ?? [], `A must see none of B's ${t.table} rows`).toHaveLength(0)

      // INSERT smuggling B's scope. On a 'direct' table this is WITH CHECK refusing a
      // row outside the caller's reach; on an 'rpc' table `authenticated` has no INSERT
      // grant at all, so it is refused one layer earlier. Either way it must not land.
      const smuggle = await a.from(t.table).insert(t.row(ctxB))
      expect(smuggle.error, `A smuggling B's scope into ${t.table} must be rejected`).not.toBeNull()

      // B still sees its own row, untouched.
      const bOwn = await b.from(t.table).select(t.ownerColumn).eq(t.ownerColumn, t.scopeValue(ctxB))
      expect(
        bOwn.data?.length ?? 0,
        `B must still see its own ${t.table} row`,
      ).toBeGreaterThanOrEqual(1)
    })

    it.each(
      ISOLATION_TARGETS.filter((t) => t.provision === 'rpc'),
    )('refuses a DIRECT write to the seat table $table', async (t) => {
      // The seat tables are read-only to `authenticated`: every write goes through an
      // allowlisted definer RPC. A policy keyed on the caller would be a self-service
      // seat grant — any user could award themselves any rank in any org whose id they
      // can name — so the write is refused for the caller's OWN scope too, not merely
      // across the boundary. That is what distinguishes this from the smuggle case.
      const ins = await a.from(t.table).insert(t.row(ctxA))
      expect(
        ins.error,
        `A must not be able to INSERT its own ${t.table} row directly`,
      ).not.toBeNull()

      // A DELETE aimed at the caller's own row. Missing grant surfaces as an error;
      // were a future migration to grant it, the deny-all policy would instead make it
      // match nothing. Both are acceptable — so rather than assert on which, assert on
      // the only thing that actually matters afterwards: the row is still there.
      await a.from(t.table).delete().eq(t.ownerColumn, t.scopeValue(ctxA))

      const still = await a
        .from(t.table)
        .select(t.ownerColumn)
        .eq(t.ownerColumn, t.scopeValue(ctxA))
      expect(still.error, `A re-read of ${t.table}: ${still.error?.message}`).toBeNull()
      expect(
        still.data?.length ?? 0,
        `a direct DELETE must not have removed A's own ${t.table} row`,
      ).toBeGreaterThanOrEqual(1)
    })

    it.each(
      ISOLATION_TARGETS.filter((t) => t.provision === 'direct'),
    )('lets a cross-tenant DELETE on $table match nothing without raising', async (t) => {
      // The absence of an error is the point: a caller cannot distinguish "no such
      // row" from "not yours". The returned set is what was actually deleted.
      const del = await a.from(t.table).delete().eq(t.ownerColumn, t.scopeValue(ctxB)).select()
      expect(del.error, `A cross-delete ${t.table} must not raise`).toBeNull()
      expect(del.data ?? [], `A must delete none of B's ${t.table} rows`).toHaveLength(0)
    })

    it('ignores an X-Org-Id header naming an org the caller does not belong to', async () => {
      // THE LOAD-BEARING ASSERTION for the org-selector design. The acting org is a
      // TRANSPORT SELECTOR — it travels in a header, never in a payload, and it can only
      // ever NARROW what the caller already reaches. This proves the database is
      // indifferent to it: PostgREST does not read it, and the policies key on
      // public.memberships at statement time, so a caller who names somebody else's org
      // gets exactly what they got before — nothing.
      //
      // The honest scope of this test: it proves a header cannot WIDEN the boundary. It
      // does not prove the application layer refuses to trust one, because at this layer
      // there is no application. That half is the server-side resolution in
      // packages/api's createContext, which resolves x-org-id against the caller's REAL
      // memberships and yields a null active org for anything else.
      const aSpoofed = await signIn(TENANT_A.email, TENANT_A.password, {
        'X-Org-Id': ctxB.teamOrgId,
      })

      // NON-VACUITY, asserted HERE rather than inferred from a sibling test. The
      // whole assertion below is "A sees none of B's notes" — which is trivially
      // true if B has no notes. B reads its own org through its own client first,
      // so the ∅ that follows is B's rows being HIDDEN, not B's rows being absent.
      const bHas = await b.from('notes').select('id').eq('org_id', ctxB.teamOrgId)
      expect(bHas.error, `B own-read before the spoof: ${bHas.error?.message}`).toBeNull()
      expect(
        bHas.data?.length ?? 0,
        "B's org must hold at least one note, or the empty set below proves nothing",
      ).toBeGreaterThanOrEqual(1)

      const foreign = await aSpoofed.from('notes').select('id').eq('org_id', ctxB.teamOrgId)
      expect(foreign.error, 'a spoofed X-Org-Id must not raise').toBeNull()
      expect(foreign.data ?? [], "claiming B's org must still return the empty set").toHaveLength(0)

      // POSITIVE CONTROL: the header did not simply break the client. A still reads its
      // own org through the very same connection — so the ∅ above is isolation, not a
      // malformed request.
      const own = await aSpoofed.from('notes').select('id').eq('org_id', ctxA.teamOrgId)
      expect(own.error, `A own-read while spoofing: ${own.error?.message}`).toBeNull()
      expect(
        own.data?.length ?? 0,
        'A must still see its own org while spoofing',
      ).toBeGreaterThanOrEqual(1)
    })

    it('refuses a seat RPC aimed at an org the caller is not a member of', async () => {
      // The RPCs re-derive the caller from auth.uid(), never from an argument — but the
      // ORG is an argument, and this is what stops that being a hole. A holds rank 0 in
      // B's org, and every rank floor is `>= 30`, so the invitation is refused.
      const invite = await a.rpc('create_invitation', {
        p_org_id: ctxB.teamOrgId,
        p_email: 'intruder@example.test',
        p_role_rank: 20,
      })
      expect(invite.error, "A must not be able to invite into B's org").not.toBeNull()

      // And nothing landed: B sees only the invitation B created.
      const bInvites = await b.from('invitations').select('email').eq('org_id', ctxB.teamOrgId)
      expect(bInvites.error, `B invitation read: ${bInvites.error?.message}`).toBeNull()
      expect(
        (bInvites.data ?? []).map((r) => r['email']),
        "B's org must hold no invitation A tried to create",
      ).not.toContain('intruder@example.test')
    })

    it('an anonymous client reads no rows from a private table', async () => {
      // anon holds no grant on these tables (REVOKE ALL … FROM anon), so it reads
      // nothing — whether PostgREST answers with a permission error or an empty set, the
      // one thing that must never come back is a row.
      const anon = anonClient()
      for (const t of ISOLATION_TARGETS) {
        const res = await anon.from(t.table).select(t.ownerColumn)
        expect(res.data ?? [], `anon must read zero rows from ${t.table}`).toHaveLength(0)
      }
    })

    it('an anonymous client cannot execute a tenancy RPC', async () => {
      // PostgreSQL grants EXECUTE to PUBLIC on every new function and Supabase's default
      // privileges additionally grant anon, so a definer function that names no grants is
      // ALREADY callable by an unauthenticated caller. The migration REVOKEs both; this
      // is that REVOKE observed from outside.
      const anon = anonClient()
      const res = await anon.rpc('ensure_personal_org')
      expect(res.error, 'anon must not be able to execute ensure_personal_org').not.toBeNull()
    })
  })
}
