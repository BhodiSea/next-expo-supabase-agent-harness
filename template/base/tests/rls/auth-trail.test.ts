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
// surface the design refuses. The local stack's postgres credentials are fixed
// by the CLI — the same ones `supabase test db` itself uses; nothing secret
// leaves this file.
import { execFileSync } from 'node:child_process'
import { beforeAll, describe, expect, it } from 'vitest'
import { anonClient, createTenant, RLS_SUITE_READY, serviceClient, type Tenant } from './db-context'

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

// A dedicated identity, so the count is scoped to THIS suite's attempt and a
// re-run against an un-reset database cannot collide with the isolation suite.
const PROBE: Tenant = { email: 'auth-trail@example.test', password: 'auth-trail-pw-x9', id: '' }

function failureCount(userId: string): number {
  const out = execFileSync(
    'psql',
    [
      DB_URL,
      '-tAc',
      `select count(*) from auth_trail.events
        where event_kind = 'password_failure' and user_id = '${userId}'`,
    ],
    { encoding: 'utf8' },
  )
  return Number.parseInt(out.trim(), 10)
}

describe.runIf(RLS_SUITE_READY)('the auth event trail (GoTrue → hook → row)', () => {
  beforeAll(async () => {
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
    const before = failureCount(PROBE.id)

    const attempt = await anonClient().auth.signInWithPassword({
      email: PROBE.email,
      // Wrong on purpose, and unique-ish so the failure is a real verification
      // failure against a real hash — not a transport fault that never reached
      // GoTrue (which would leave the count unchanged and fail below).
      password: `wrong-on-purpose-${PROBE.id.slice(0, 8)}`,
    })
    expect(attempt.error).not.toBeNull()

    expect(failureCount(PROBE.id)).toBe(before + 1)
  })
})
