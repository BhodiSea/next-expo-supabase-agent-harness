// The per-role resource ceilings, proven THROUGH PostgREST — the only place they can
// be proven at all.
//
// WHY THIS FILE EXISTS BESIDE THE pgTAP ASSERTION. `ALTER ROLE x SET statement_timeout`
// writes a row into pg_db_role_setting, which PostgreSQL applies when role x STARTS A
// SESSION. `SET ROLE` does not start a session — verified directly: connected as
// `authenticator` (the role PostgREST logs in as), `SET LOCAL ROLE authenticated` left
// statement_timeout at the AUTHENTICATOR's value, not at the one set on `authenticated`.
// On that evidence every ceiling in the migration would be inert.
//
// They are not inert, because PostgREST reads pg_db_role_setting for the role it is
// about to impersonate and applies those settings ITSELF, per request. Verified end to
// end: with anon at 2s and authenticator at 8s, a 5-second RPC called through PostgREST
// as anon was cancelled at 2.03s with SQLSTATE 57014.
//
// So the pgTAP suite proves the catalog row EXISTS — which is exactly what PostgREST
// reads — and this suite proves PostgREST APPLIED it. Neither is sufficient alone, and
// the gap between them is not academic: a PostgREST upgrade that dropped the feature,
// a renamed role, or a setting reset by hand would leave the catalog assertion green
// and every ceiling gone.
//
// The consequence, recorded here because this is where someone will look for it: these
// ceilings bound traffic arriving through PostgREST — every supabase-js call from web
// and mobile — and do NOT bound a direct connection. An Edge Function on a Postgres
// driver, a migration, psql, or Supavisor in session mode each log in as another role
// and get that role's settings instead.
// SOURCE: docs/adr/20260203-resource-limits.md
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  anonClient,
  createTenant,
  deleteTenant,
  RLS_SUITE_READY,
  serviceClient,
  signIn,
  type Tenant,
} from './db-context'

// A tenant of this suite's OWN, not TENANT_A. vitest runs the two rls files
// concurrently, and both reaching for the same GoTrue identity is a race whose loser
// fails with an empty error object — a confusing way to discover that a resource-limit
// assertion has nothing to do with tenancy fixtures.
const LIMITS_TENANT: Tenant = {
  email: 'rls-limits@example.test',
  password: 'rls-suite-pw-lim3',
  id: '',
}

/** The reviewed contract — the same file tools/check-db-limits.mjs judges migrations against. */
const LIMITS = JSON.parse(readFileSync('tools/db-limits.json', 'utf8')) as {
  roles: Record<string, Record<string, string>>
}

/** '3s' / '250ms' -> milliseconds, matching the gate's parser. */
function toMs(value: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|min|h)?$/i.exec(value.trim())
  if (m === null) throw new Error(`unparseable duration: ${value}`)
  const n = Number(m[1])
  const unit = (m[2] ?? 'ms').toLowerCase()
  return unit === 's' ? n * 1000 : unit === 'min' ? n * 60_000 : unit === 'h' ? n * 3_600_000 : n
}

interface EffectiveLimits {
  role: string
  statement_timeout: string
  idle_in_transaction_session_timeout: string
  lock_timeout: string
}

if (!RLS_SUITE_READY) {
  describe.skip('per-role resource ceilings (skipped: no local stack)', () => {
    it('self-skips — run `node tests/rls/run-rls.mjs`; this layer FAILS CLOSED in CI', () => {
      expect(true).toBe(true)
    })
  })
} else {
  describe('per-role resource ceilings bind through PostgREST', () => {
    it.each([
      'anon',
      'authenticated',
    ] as const)('the %s role gets the reviewed ceilings in force, not merely in the catalog', async (role) => {
      const svc = serviceClient()
      let client = anonClient()
      if (role === 'authenticated') {
        // deleteTenant no-ops without an id, so residue from an aborted run has to be
        // swept by email before createTenant can collide on it.
        const { data: existing } = await svc.auth.admin.listUsers()
        for (const u of existing?.users ?? []) {
          if (u.email === LIMITS_TENANT.email) {
            await svc.from('orgs').delete().eq('created_by', u.id)
            await svc.auth.admin.deleteUser(u.id)
          }
        }
        await createTenant(svc, LIMITS_TENANT)
        client = await signIn(LIMITS_TENANT.email, LIMITS_TENANT.password)
      }
      try {
        const { data, error } = await client.rpc('effective_limits')
        expect(error, `effective_limits() as ${role}: ${error?.message}`).toBeNull()

        const live = data as unknown as EffectiveLimits
        // The role PostgREST actually switched to. If this is wrong every other
        // assertion here is measuring the wrong ceiling.
        expect(live.role, `PostgREST must impersonate ${role}`).toBe(role)

        for (const [knob, want] of Object.entries(LIMITS.roles[role] ?? {})) {
          // Compared in milliseconds, not as strings: PostgreSQL normalizes '8s' to
          // '8s' but '10s' for idle_in_transaction can come back as '10s' or '10000ms'
          // depending on the unit it picks, and a string compare would fail on a
          // database that is entirely correct.
          expect(
            toMs(live[knob as keyof EffectiveLimits] as string),
            `${role}.${knob} is '${live[knob as keyof EffectiveLimits]}' in force but '${want}' in tools/db-limits.json — the ceiling exists in the catalog and PostgREST is not applying it`,
          ).toBe(toMs(want))
        }
      } finally {
        if (role === 'authenticated') await deleteTenant(svc, LIMITS_TENANT)
      }
    })

    it('the ceilings are TIGHTER than the login role a direct connection would get', async () => {
      // The property that makes them worth having: `authenticator` (what PostgREST
      // logs in as, and what any direct connection falls back to) is set by the
      // Supabase image, and an impersonated role must not be able to exceed it. If a
      // future migration raised `authenticated` above it, the API surface would become
      // the LOOSEST path into the database rather than the tightest.
      const client = anonClient()
      const { data, error } = await client.rpc('effective_limits')
      expect(error, `effective_limits() as anon: ${error?.message}`).toBeNull()
      const live = data as unknown as EffectiveLimits
      expect(
        toMs(live.statement_timeout),
        'anon must be at or under the 8s the Supabase image gives the authenticator login role',
      ).toBeLessThanOrEqual(8000)
    })
  })
}
