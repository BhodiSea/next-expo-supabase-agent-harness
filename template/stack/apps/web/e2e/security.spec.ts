import { expect, type Page, test } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'

// The `security` route, RENDERED for a signed-in user. Until this file no spec in the seeded
// suite visited /security at all, and the route-manifest gate now asks, per registered route,
// that some spec here name one of its declared state test ids. This one asserts
// `security-empty`: a fresh account has no second factor, and the page offers to enrol one.
//
// The factor list is read by the BROWSER client (app/(protected)/security/factors-panel.tsx:
// the list must re-read after every enrol and unenrol without a navigation), so this is also
// the one spec whose assertion depends on the session the browser holds, not the cookie the
// server reads — the half authenticated.spec.ts proves the other way round.
//
// The identity is minted and removed exactly as authenticated.spec.ts does it, and for the
// reasons that file's header records: one address per worker, created through the admin API
// with the email confirmed, signed in through the REAL form, and torn down orgs first. The
// prefix is this file's own, so no other spec can delete the account this one is signed in as.
// SOURCE: apps/web/e2e/authenticated.spec.ts (the fixture identity's lifecycle)

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const PASSWORD = 'web-e2e-security-pw-1'
const workerIndex = process.env.TEST_WORKER_INDEX ?? '0'
let email = ''

const admin = () =>
  createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

/** Remove ONE address: its orgs first (orgs.created_by is ON DELETE SET NULL), then the user. */
async function removeFixtureUser(address: string): Promise<void> {
  if (address === '') return
  const svc = admin()
  const { data } = await svc.auth.admin.listUsers()
  for (const user of data?.users ?? []) {
    if (user.email !== address) continue
    await svc.from('orgs').delete().eq('created_by', user.id)
    await svc.auth.admin.deleteUser(user.id)
  }
}

test.beforeAll(async () => {
  expect(SUPABASE_URL, 'NEXT_PUBLIC_SUPABASE_URL must be exported to the browser lane').not.toBe('')
  expect(
    SERVICE_ROLE_KEY,
    'SUPABASE_SERVICE_ROLE_KEY must be exported to the browser lane so it can mint a fixture identity',
  ).not.toBe('')
  email = `web-e2e-security-w${workerIndex}@example.test`
  await removeFixtureUser(email)
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

async function signIn(page: Page): Promise<void> {
  await page.goto('/sign-in')
  await page.getByRole('textbox', { name: 'Email' }).fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

test.describe('the security route', () => {
  test('a fresh account renders the empty factor list and offers to enrol', async ({ page }) => {
    await signIn(page)
    await expect(page).toHaveURL(/\/o$/)

    await page.goto('/security')
    await expect(page).toHaveURL(/\/security$/)

    // The route's OWN declared empty-state test id (its page.meta.ts). The list starts in
    // its loading state and settles here once the browser client's listFactors() answers.
    await expect(page.getByTestId('security-empty')).toBeVisible()
    await expect(page.getByTestId('security-enrol')).toBeVisible()
  })
})
