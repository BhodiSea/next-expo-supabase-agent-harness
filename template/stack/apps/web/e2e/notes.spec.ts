import { expect, type Page, test } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'

// The `notes` route, RENDERED for a signed-in member. Until this file the seeded suite
// reached /o/:orgSlug/notes only as an anonymous redirect (tenancy.spec.ts), so nothing in
// any browser had ever drawn the page — and the route-manifest gate now asks, per registered
// route, that some spec here name one of its declared state test ids. This one asserts
// `notes-empty`, the state a brand-new workspace is in.
//
// The identity is minted and removed exactly as authenticated.spec.ts does it, and for the
// reasons that file's header records: one address per worker (Playwright runs these files
// fully parallel, and beforeAll/afterAll are per worker), created through the admin API with
// the email confirmed, signed in through the REAL form, and torn down orgs first. The prefix
// is this file's own, so no other spec can delete the account this one is signed in as.
// SOURCE: apps/web/e2e/authenticated.spec.ts (the fixture identity's lifecycle)

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const PASSWORD = 'web-e2e-notes-pw-1'
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
  email = `web-e2e-notes-w${workerIndex}@example.test`
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

test.describe('the notes route', () => {
  test('a new workspace renders its empty notes state, and a reload renders it again', async ({
    page,
  }) => {
    await signIn(page)
    await expect(page).toHaveURL(/\/o$/)

    // A seatless identity lands on the picker's empty surface. Creating the workspace gives
    // it exactly one seat, and the picker sends a single-seat member straight to that org's
    // notes (app/(protected)/o/page.tsx).
    await page.getByTestId('create-workspace').click()
    await expect(page).toHaveURL(/\/o\/[^/]+\/notes$/)

    // The route's OWN declared empty-state test id (its page.meta.ts), so a rename has to go
    // through the meta and the route-manifest gate rather than silently past this file.
    await expect(page.getByTestId('notes-empty')).toBeVisible()

    // A fresh document request: the org layout resolves the seat on the server, from the
    // cookie, and renders the same state.
    await page.reload()
    await expect(page.getByTestId('notes-empty')).toBeVisible()
  })
})
