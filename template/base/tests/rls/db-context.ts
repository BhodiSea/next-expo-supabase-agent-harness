// Shared helpers for the SDK RLS suite: the isolation-target registry the schema-rls
// gate closes over, and supabase-js clients authorized as two distinct tenants so the
// suite exercises the SAME PostgREST + GoTrue path a real Class-A mobile write takes.
// What the pgTAP twin (supabase/tests/*.sql, raw `SET LOCAL ROLE` + request.jwt.claims)
// cannot see is whether the deployed CLIENT transport enforces the boundary; this can.
// SOURCE: supabase/tests/rls_isolation.test.sql (the empty-set principle, proven here
// through the client) [corpus: postgres/rls-force]
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export const RLS_SUITE_READY = process.env['RLS_SUITE_READY'] === '1'

// Populated by tests/rls/run-rls.mjs from `supabase status` — NEVER committed (the
// local keys are JWT-shaped and the hygiene gate reds a literal one). Absent => the
// suite self-skips, so a bare `vitest run` never reaches for the network.
const apiUrl = process.env['SUPABASE_URL'] ?? ''
const anonKey = process.env['SUPABASE_ANON_KEY'] ?? ''
const serviceRoleKey = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? ''

// No session persistence: Node has no localStorage, and two tenant clients in one
// process must not share a session store — each createClient keeps its own in memory.
const noPersist = { auth: { persistSession: false, autoRefreshToken: false } }

// service-role client — creates and tears down the two ephemeral tenants. It BYPASSES
// RLS, so it is used ONLY for fixture setup; every isolation ASSERTION runs through a
// tenant client below.
export function serviceClient(): SupabaseClient {
  return createClient(apiUrl, serviceRoleKey, noPersist)
}

// A client signed in as one tenant. Its session — a real GoTrue JWT — rides every
// subsequent `.from()` call, so PostgREST resolves `authenticated` + `auth.uid()`
// exactly as it would for that user in production.
//
// `headers` exists for exactly one test: signing in a client that ALSO sends an
// `X-Org-Id` naming an org it does not belong to. The database must be
// indifferent to it. See the foreign-org assertion in cross-tenant-isolation.
export async function signIn(
  email: string,
  password: string,
  headers?: Record<string, string>,
): Promise<SupabaseClient> {
  const c = createClient(apiUrl, anonKey, { ...noPersist, global: { headers: headers ?? {} } })
  const { error } = await c.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`)
  return c
}

// An UNauthenticated client (publishable/anon key, no session) — the caller with no
// identity at all.
export function anonClient(): SupabaseClient {
  return createClient(apiUrl, anonKey, noPersist)
}

export interface Tenant {
  email: string
  password: string
  /** Filled in by createTenant once GoTrue assigns the id. */
  id: string
}

// Throwaway local fixtures — deliberately NOT the identities in supabase/seed.sql, so
// the suite neither depends on nor disturbs seeded state.
export const TENANT_A: Tenant = { email: 'rls-a@example.test', password: 'rls-suite-pw-a1', id: '' }
export const TENANT_B: Tenant = { email: 'rls-b@example.test', password: 'rls-suite-pw-b2', id: '' }

// email_confirm so signInWithPassword works without an email round-trip.
export async function createTenant(svc: SupabaseClient, t: Tenant): Promise<void> {
  const { data, error } = await svc.auth.admin.createUser({
    email: t.email,
    password: t.password,
    email_confirm: true,
  })
  if (error || !data.user) throw new Error(`createUser failed for ${t.email}: ${error?.message}`)
  t.id = data.user.id
}

// Tear-down, in the SAME order the delete-account Edge Function uses, and for the
// same reason. `public.orgs.created_by` is ON DELETE SET NULL, so deleting the auth
// user first would null the only column that identifies which orgs to remove and
// leave them — plus their memberships, invitations and notes — permanently
// unreachable. Sweep the orgs, then the identity. Deleting an org cascades
// everything hanging off it; deleting the user cascades public.profiles and revokes
// every remaining seat.
//
// This uses the one grant migration 20260201000200 hands service_role
// (SELECT, DELETE on public.orgs) — so if that grant is ever dropped, the suite's
// own cleanup is what notices.
export async function deleteTenant(svc: SupabaseClient, t: Tenant): Promise<void> {
  if (!t.id) return
  await svc.from('orgs').delete().eq('created_by', t.id)
  await svc.auth.admin.deleteUser(t.id)
}

// Clear any residue from a prior aborted run so createTenant never collides on email.
export async function resetTenants(svc: SupabaseClient): Promise<void> {
  const { data } = await svc.auth.admin.listUsers()
  for (const u of data?.users ?? []) {
    if (u.email === TENANT_A.email || u.email === TENANT_B.email) {
      await svc.from('orgs').delete().eq('created_by', u.id)
      await svc.auth.admin.deleteUser(u.id)
    }
  }
}

// Everything a tenant needs to exist in an org-scoped world. Built by
// bootstrapTenant below through the SAME RPCs the application calls — there is no
// direct-write path to any of it, which is the point.
export interface TenantContext {
  userId: string
  /** The single-seat org every user gets. Created lazily by ensure_personal_org(). */
  personalOrgId: string
  /** A team org this tenant founded, so they hold rank 40 in it. */
  teamOrgId: string
}

// The tenancy bootstrap, exercised end to end. Every call here is a
// SECURITY DEFINER RPC: `authenticated` holds no INSERT grant on orgs,
// memberships or invitations, so if any of these functions is broken there is no
// fallback and the suite cannot even reach its assertions. That is deliberate —
// it makes this function a positive control for the whole write path.
export async function bootstrapTenant(
  client: SupabaseClient,
  userId: string,
  label: string,
): Promise<TenantContext> {
  const personal = await client.rpc('ensure_personal_org')
  if (personal.error || !personal.data) {
    throw new Error(`ensure_personal_org failed for ${label}: ${personal.error?.message}`)
  }
  // Slug shape is CHECK-constrained (lowercase, hyphens, no reserved words) and
  // globally unique, so it carries the user id to stay collision-free across runs.
  const team = await client.rpc('create_org', {
    p_name: `RLS suite ${label}`,
    p_slug: `rls-${label}-${userId.slice(0, 8)}`,
  })
  if (team.error || !team.data) {
    throw new Error(`create_org failed for ${label}: ${team.error?.message}`)
  }
  // The privilege lifecycle (1.0.0): the invitation mint below is an admin act
  // judged against the EFFECTIVE rank, which for rank >= 30 exists only while an
  // unexpired elevation does — so the founder elevates first. This is also what
  // provisions the admin_elevations isolation target's row, making the JIT door
  // one more RPC this bootstrap is a positive control for.
  const lift = await client.rpc('elevate', { p_org_id: team.data })
  if (lift.error) {
    throw new Error(`elevate failed for ${label}: ${lift.error.message}`)
  }
  // One pending invitation, so the invitations target has a row of its own to
  // isolate. Rank 20 is strictly below the founder's 40, which is what makes it
  // legal — an admin may not mint a seat at or above their own rank.
  const invite = await client.rpc('create_invitation', {
    p_org_id: team.data,
    p_email: `pending-${label}@example.test`,
    p_role_rank: 20,
  })
  if (invite.error) {
    throw new Error(`create_invitation failed for ${label}: ${invite.error.message}`)
  }
  return { userId, personalOrgId: personal.data, teamOrgId: team.data }
}

// Tables under isolation test — the ONE registry the schema-rls gate closes over
// (tools/check-rls-manifest.mjs parses `table:` immediately followed by `ownerColumn:`;
// keep that key order). Add a row per user-scoped table AND a matching row in
// supabase/tests/rls_structure.test.sql's rls_targets — the gate holds the two in sync.
export interface IsolationTarget {
  table: string
  /**
   * The column this table's policies FILTER BY — the TENANT key for org-scoped
   * tables, a user id for the account-scoped ones. It must be the leading column of
   * some index (schema-rls asserts that statically, the pgTAP suite from pg_catalog).
   */
  ownerColumn: string
  /**
   * How a row gets there. 'direct' tables are writable by `authenticated` under a
   * WITH CHECK policy, so the suite inserts one and the insert itself proves the
   * policy admits a legitimate self-write. 'rpc' tables are READ-ONLY to
   * authenticated — every write goes through an allowlisted SECURITY DEFINER
   * function — so a direct insert MUST fail, and the row arrives as a side effect of
   * the tenancy bootstrap instead. Attempting a direct insert on an 'rpc' table is
   * itself an assertion the suite makes.
   */
  provision: 'direct' | 'rpc'
  /**
   * The value of ownerColumn identifying THIS tenant's rows. Reading it for the
   * other tenant's context is the cross-tenant probe, and must return ∅.
   */
  scopeValue: (ctx: TenantContext) => string
  /**
   * A row belonging to the tenant `ctx` describes. Built from a tenant's OWN
   * context it is a legitimate self-write; built from the OTHER tenant's context
   * it is the smuggling probe. One function serves both because the only thing
   * that differs between them is whose context goes in.
   */
  row: (ctx: TenantContext) => Record<string, unknown>
}

export const ISOLATION_TARGETS: IsolationTarget[] = [
  {
    table: 'profiles',
    ownerColumn: 'id',
    // Account metadata rather than org data, so it stays user-scoped by design.
    provision: 'direct',
    scopeValue: (ctx) => ctx.userId,
    row: (ctx) => ({ id: ctx.userId, display_name: 'rls probe' }),
  },
  {
    table: 'orgs',
    ownerColumn: 'id',
    provision: 'rpc',
    scopeValue: (ctx) => ctx.teamOrgId,
    row: (ctx) => ({ name: 'smuggled', slug: `smuggled-${ctx.userId.slice(0, 8)}` }),
  },
  {
    table: 'memberships',
    ownerColumn: 'user_id',
    // Self-only by necessity: the scope helpers READ this table, so a policy here
    // that called one would be re-entered by it (SQLSTATE 54001 — stack depth, not the tidy 42P17).
    provision: 'rpc',
    scopeValue: (ctx) => ctx.userId,
    row: (ctx) => ({ user_id: ctx.userId, org_id: ctx.teamOrgId, role_rank: 40 }),
  },
  {
    // The JIT elevation (1.0.0). Read-only to authenticated — the row arrives from
    // the elevate() call in the bootstrap, never from a client write. Self-scoped
    // like the seat table and for the same recursion reason; the cross-tenant read
    // that matters here discloses WHO is currently administering an org, which is
    // operational posture another tenant has no business seeing.
    table: 'admin_elevations',
    ownerColumn: 'user_id',
    provision: 'rpc',
    scopeValue: (ctx) => ctx.userId,
    row: (ctx) => ({ user_id: ctx.userId, org_id: ctx.teamOrgId }),
  },
  {
    table: 'invitations',
    ownerColumn: 'org_id',
    provision: 'rpc',
    scopeValue: (ctx) => ctx.teamOrgId,
    row: (ctx) => ({
      org_id: ctx.teamOrgId,
      email: `probe-${ctx.userId.slice(0, 8)}@example.test`,
      role_rank: 20,
      // A literal digest: the probe must not be able to mint a usable token even
      // if the write it is testing were wrongly admitted.
      token_digest: '\\x00',
    }),
  },
  {
    table: 'notes',
    ownerColumn: 'org_id',
    provision: 'direct',
    scopeValue: (ctx) => ctx.teamOrgId,
    row: (ctx) => ({
      org_id: ctx.teamOrgId,
      // Attribution, not authorization: nullable since the org re-scope, and
      // stated explicitly because the column no longer defaults to auth.uid().
      owner_id: ctx.userId,
      title: 'rls probe',
      body: 'seeded by the isolation suite',
    }),
  },
  {
    // The quota counter. 'rpc' rather than 'direct' because it is READ-ONLY to
    // authenticated for the same reason the seat tables are: a tenant that can write
    // its own usage counter has no quota. The row arrives as a side effect of the
    // notes insert above — the statement-level enforcement trigger creates it through
    // app_quota_writer — rather than from an RPC, which is the only way this differs
    // from the seat tables and does not change a single assertion.
    //
    // The cross-tenant read is the one that matters here: a usage counter discloses
    // how much data another tenant holds, which is a business fact even when the rows
    // themselves stay hidden.
    table: 'org_usage',
    ownerColumn: 'org_id',
    provision: 'rpc',
    scopeValue: (ctx) => ctx.teamOrgId,
    row: (ctx) => ({ org_id: ctx.teamOrgId, metric: 'notes', used: 1 }),
  },
]
