// tests/rls/auth-trail.test.ts — the half only a REAL auth server can prove.
//
// The pgTAP twin (supabase/tests/auth_trail.test.sql) synthesizes the hook
// payloads as supabase_auth_admin and proves the whole privilege path, the
// vocabulary, the four immutability layers and the never-deny-sign-in wrap.
// What it cannot prove is the WIRING: that GoTrue, on a live attempt, actually
// calls auth_trail.password_verification_hook. This suite performs a real
// FAILED signInWithPassword over HTTP — the credential-stuffing shape the trail
// exists to record, and the one no client-side seam can see — then counts the
// row.
//
// The count goes through psql as the local superuser, deliberately: the trail
// has NO client read path by design (the migration header records the no-reader
// posture), so asserting through a client would require adding the exact read
// surface the design refuses. The URL is the running stack's own, from
// `supabase status -o env` (DB_URL), which tests/rls/run-rls.mjs hands this suite
// as SUPABASE_DB_URL (1.0.4). Through 1.0.3 it was a literal naming the default
// Postgres port: a project that moved the port in supabase/config.toml, or a
// machine where another stack held it, sent psql to another database or to none.
import { execFileSync } from 'node:child_process'
import { beforeAll, describe, expect, it } from 'vitest'
import { anonClient, createTenant, RLS_SUITE_READY, serviceClient, type Tenant } from './db-context'

// Read when the suite RUNS, never at module scope: the `rls` vitest project loads this
// file on every `unit` Stop step, where no URL is set and the suite is skipped, and a
// module-scope throw would block every turn. There is no fallback URL.
function stackDbUrl(): string {
  const url = process.env['SUPABASE_DB_URL'] ?? ''
  if (url === '') {
    throw new Error(
      'SUPABASE_DB_URL is not set. Run this suite through `node tests/rls/run-rls.mjs` (`pnpm test:rls`), which reads it from `supabase status -o env`; a forked runner must pass it too.',
    )
  }
  return url
}

// A dedicated identity, so the count is scoped to THIS suite's attempt and a
// re-run against an un-reset database cannot collide with the isolation suite.
const PROBE: Tenant = { email: 'auth-trail@example.test', password: 'auth-trail-pw-x9', id: '' }

function failureCount(dbUrl: string, userId: string): number {
  const out = execFileSync(
    'psql',
    [
      dbUrl,
      '-tAc',
      `select count(*) from auth_trail.events
        where event_kind = 'password_failure' and user_id = '${userId}'`,
    ],
    { encoding: 'utf8' },
  )
  return Number.parseInt(out.trim(), 10)
}

describe.runIf(RLS_SUITE_READY)('the auth event trail (GoTrue → hook → row)', () => {
  let dbUrl = ''

  beforeAll(async () => {
    dbUrl = stackDbUrl()
    const svc = serviceClient()
    try {
      await createTenant(svc, PROBE)
    } catch {
      // An un-reset database still holds the probe from a prior run. Resolve its
      // id instead — the count below is delta-based, so old rows cannot confound.
      const { data } = await svc.auth.admin.listUsers()
      const existing = data.users.find((u) => u.email === PROBE.email)
      if (!existing) throw new Error('auth-trail probe user neither creatable nor findable')
      PROBE.id = existing.id
    }
  })

  it('records a REAL failed password attempt — the half no client seam can see', async () => {
    const before = failureCount(dbUrl, PROBE.id)

    const attempt = await anonClient().auth.signInWithPassword({
      email: PROBE.email,
      // Wrong on purpose, and unique-ish so the failure is a real verification
      // failure against a real hash — not a transport fault that never reached
      // GoTrue (which would leave the count unchanged and fail below).
      password: `wrong-on-purpose-${PROBE.id.slice(0, 8)}`,
    })
    expect(attempt.error).not.toBeNull()

    expect(failureCount(dbUrl, PROBE.id)).toBe(before + 1)
  })
})
