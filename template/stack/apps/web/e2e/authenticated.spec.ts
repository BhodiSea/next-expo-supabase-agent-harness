import { expect, test } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'

// THE SPEC THAT WOULD HAVE CAUGHT THE SIGN-IN LOOP, and the reason the browser lane is
// allowed to be nine tier rows' compensating control.
//
// Every other spec in this directory is ANONYMOUS. home.spec.ts renders the public landing
// route; security-headers.spec.ts reads `/`; tenancy.spec.ts says in its own header that it
// runs "WITHOUT a seeded session", and the one sign-in it performs submits a deliberately
// WRONG password to prove the error copy is not an account-existence oracle. So until this
// file, no test in the repository had ever completed a successful sign-in — and the lane ran
// green on every PR touching apps/web while the seeded app could not sign anybody in at all.
// The browser client was built with no `storage`, so supabase-js persisted the session to
// localStorage (its documented default) while every server reader took it from the COOKIE
// JAR. Sign-in succeeded, the protected layout's getVerifiedUser() saw nothing, and it
// redirected straight back to /sign-in.
//
// A LANE THAT RUNS IS NOT A LANE THAT COVERS. `docs/harness/enforcement-tiers.md` exempts
// apps/web/app from unit coverage on the grounds that a real browser proves it, and names
// web-e2e as the compensating control on nine rows. That claim is only true of behaviour
// some spec actually exercises, which is why tools/check-web-e2e.mjs now requires this axis
// by name rather than trusting the sentence.
//
// TWO RULES THIS FILE FOLLOWS, both load-bearing:
//   1. THE SESSION IS ESTABLISHED THROUGH THE UI, never planted. `context.addCookies()` with
//      a hand-built session would prove the SERVER reads a cookie and say nothing about what
//      the BROWSER writes — which is precisely the half that was broken. The credentials go
//      into the real form and the real submit handler runs.
//   2. THE PROOF IS A FULL RELOAD. A client-side navigation can render from state the tab is
//      already holding; only a fresh document request makes the server re-read the cookie and
//      re-run the protected layout. `page.reload()` is the assertion, not the setup.
//
// The suite runs against a PRODUCTION build (see playwright.config.ts) and a real local
// Supabase stack, so the identity below is minted through the admin API exactly as
// tests/rls/db-context.ts mints its tenants, and torn down the same way.
// SOURCE: apps/web/lib/supabase/client.ts (the cookie jar the browser writes into)
// SOURCE: docs/harness/gates-catalog.md (web-e2e lane)

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

// ONE IDENTITY PER WORKER, and this is not caution — the first version shared a single
// address and failed on the first real run. `playwright.config.ts` sets `fullyParallel:
// true`, so the three tests below are handed to three workers, and `beforeAll` runs once
// PER WORKER: all three raced to create the same account (two got `duplicate key value
// violates unique constraint "users_email_partial_key"`, surfaced by GoTrue as the useless
// "Database error creating new user"), and the first worker to finish then ran its
// `afterAll` and deleted the account the others were signed in as. Deriving the address
// from the worker index makes the fixture worker-local, which is the scope its lifecycle
// already had. Module state is safe to key it on for the same reason: each worker is its
// own process with its own module instance.
//
// Deliberately NOT an identity from supabase/seed.sql and NOT the RLS suite's tenants, so
// this lane neither depends on nor disturbs state anything else asserts about.
const PASSWORD = 'web-e2e-session-pw-1'
let email = ''

// No session persistence: this client only ever acts as the admin, and a persisted session
// in the test process would be a second store nobody wants.
const admin = () =>
  createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

/**
 * Remove ONE address, never a prefix sweep. A run that deleted every `web-e2e-session-*`
 * account would reintroduce the cross-worker teardown this file just fixed; residue from an
 * aborted run is cleaned by the worker that owns that index, on its next start.
 */
async function removeFixtureUser(address: string): Promise<void> {
  if (address === '') return
  const svc = admin()
  const { data } = await svc.auth.admin.listUsers()
  for (const user of data?.users ?? []) {
    if (user.email !== address) continue
    // Orgs first, then the identity — `public.orgs.created_by` is ON DELETE SET NULL, so
    // deleting the user first would null the only column that says which orgs to remove.
    // Same order, and the same reason, as tests/rls/db-context.ts deleteTenant().
    await svc.from('orgs').delete().eq('created_by', user.id)
    await svc.auth.admin.deleteUser(user.id)
  }
}

// Playwright sets this in every worker process. Read from the environment rather than from
// a `(fixtures, workerInfo)` hook signature because Playwright REJECTS a first argument that
// is not an object destructuring pattern — `async (_fixtures, workerInfo)` throws at collect
// time — and `({}, workerInfo)` is an empty pattern the linters are right to dislike.
const workerIndex = process.env.TEST_WORKER_INDEX ?? '0'

test.beforeAll(async () => {
  // Fail loudly rather than skipping: this lane runs only in CI, where the job exports both
  // of these from `supabase status`. A silent skip here would restore exactly the vacuum
  // this file exists to fill.
  expect(SUPABASE_URL, 'NEXT_PUBLIC_SUPABASE_URL must be exported to the browser lane').not.toBe('')
  expect(
    SERVICE_ROLE_KEY,
    'SUPABASE_SERVICE_ROLE_KEY must be exported to the browser lane so it can mint a fixture identity',
  ).not.toBe('')

  email = `web-e2e-session-w${workerIndex}@example.test`
  await removeFixtureUser(email)
  // email_confirm, so signInWithPassword works with no mail round trip.
  const { error } = await admin().auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  })
  if (error !== null) throw new Error(`createUser failed for ${email}: ${error.message}`)
})

test.afterAll(async () => {
  await removeFixtureUser(email)
})

/** Drive the REAL credential form. Never a planted cookie — see rule 1 in the header. */
async function signIn(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/sign-in')
  await page.getByRole('textbox', { name: 'Email' }).fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

test.describe('an authenticated session', () => {
  test('survives a full page reload — the server reads what the browser wrote', async ({
    page,
  }) => {
    await signIn(page)

    // A brand-new identity holds no seats, so resolveOrgs() returns [] and the picker renders
    // its empty surface. Asserted by the route's OWN declared test id, so a rename has to go
    // through page.meta.ts and the route-manifest gate rather than silently past this file.
    await expect(page).toHaveURL(/\/o$/)
    await expect(page.getByTestId('orgs-empty')).toBeVisible()

    // THE ASSERTION THIS FILE EXISTS FOR. Everything above can pass on a session that lives
    // only in the tab: replace() + refresh() are client-side, and React still holds the
    // signed-in render. A reload is a fresh document request — the protected layout runs on
    // the server, calls getVerifiedUser(), and has nothing but the cookie jar to read. When
    // the browser was persisting to localStorage this line redirected to /sign-in.
    await page.reload()
    await expect(page).toHaveURL(/\/o$/)
    await expect(page.getByTestId('orgs-empty')).toBeVisible()
  })

  test('rides a cookie, because a cookie is the only store a server request carries', async ({
    page,
  }) => {
    await signIn(page)
    await expect(page).toHaveURL(/\/o$/)

    // The transport itself, asserted directly rather than inferred from the render above.
    // localStorage is not sent with a request; this is the store both halves must agree on.
    const session = (await page.context().cookies()).filter((c) => c.name.startsWith('sb-'))
    expect(
      session.length,
      'sign-in must leave a Supabase session cookie in the jar',
    ).toBeGreaterThan(0)
    // `sameSite` is the CSRF half of the posture tools/auth-posture.json reviews. `secure` is
    // NOT asserted: it is derived from the scheme, and this lane serves over http on
    // 127.0.0.1, where a Secure cookie would be dropped by the user agent. Nor is `httpOnly`
    // asserted false — that would red on a future move to server-side sign-in, which would be
    // an improvement; the policy file is where that trade is recorded.
    for (const cookie of session) expect(cookie.sameSite).toBe('Lax')
  })

  test('ends when the user signs out, in the server render too', async ({ page }) => {
    // The mirror of the first test, and the same failure mode inverted: a sign-out that
    // clears only the tab's copy leaves a cookie the server still accepts, so the user stays
    // signed in on the next hard navigation while the UI insists they are not.
    await signIn(page)
    await expect(page.getByTestId('orgs-empty')).toBeVisible()

    await page.getByTestId('sign-out').click()
    await expect(page).toHaveURL(/\/sign-in$/)

    await page.goto('/o')
    await expect(page).toHaveURL(/\/sign-in$/)
    expect((await page.context().cookies()).filter((c) => c.name.startsWith('sb-'))).toEqual([])
  })
})
