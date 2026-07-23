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
export async function signIn(email: string, password: string): Promise<SupabaseClient> {
  const c = createClient(apiUrl, anonKey, noPersist)
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

// Deleting the auth user cascades to public.profiles and public.notes (both FK
// auth.users ON DELETE CASCADE). Idempotent: unknown id is a no-op.
export async function deleteTenant(svc: SupabaseClient, t: Tenant): Promise<void> {
  if (t.id) await svc.auth.admin.deleteUser(t.id)
}

// Clear any residue from a prior aborted run so createTenant never collides on email.
export async function resetTenants(svc: SupabaseClient): Promise<void> {
  const { data } = await svc.auth.admin.listUsers()
  for (const u of data?.users ?? []) {
    if (u.email === TENANT_A.email || u.email === TENANT_B.email) {
      await svc.auth.admin.deleteUser(u.id)
    }
  }
}

// Tables under isolation test — the ONE registry the schema-rls gate closes over
// (tools/check-rls-manifest.mjs parses `table:` immediately followed by `ownerColumn:`;
// keep that key order). Add a row per user-scoped table AND a matching row in
// supabase/tests/rls_structure.test.sql's rls_targets — the gate holds the two in sync.
export interface IsolationTarget {
  table: string
  ownerColumn: string
  /** A row this tenant may legitimately write, keyed by their own id. */
  seedRow: (ownerId: string) => Record<string, unknown>
}

export const ISOLATION_TARGETS: IsolationTarget[] = [
  {
    table: 'profiles',
    ownerColumn: 'id',
    seedRow: (ownerId) => ({ id: ownerId, display_name: 'rls probe' }),
  },
  {
    table: 'notes',
    ownerColumn: 'owner_id',
    seedRow: (ownerId) => ({
      owner_id: ownerId,
      title: 'rls probe',
      body: 'seeded by the isolation suite',
    }),
  },
]
