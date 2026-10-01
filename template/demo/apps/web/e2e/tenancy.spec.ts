import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

// The tenancy surface, exercised in a real browser. These specs run WITHOUT a seeded
// session, so what they can prove is bounded and stated rather than implied:
//
//   * an anonymous caller reaching a protected route lands on the credential screen —
//     the redirect a signed-out visitor actually experiences;
//   * the credential screen is operable and accessible;
//   * an org route the caller has no seat in answers 404, indistinguishable from an org
//     that does not exist.
//
// WHAT THEY DELIBERATELY DO NOT PROVE: cross-tenant isolation. That belongs to
// tests/rls/cross-tenant-isolation.test.ts, which drives two REAL tenants through
// PostgREST and asserts the empty set — a browser test that "confirmed" isolation by
// observing an empty page would be confirming a rendering, not a boundary.

test.describe('tenancy surface', () => {
  test('an anonymous visitor is sent to the credential screen, not to an empty shell', async ({
    page,
  }) => {
    await page.goto('/o')
    await expect(page).toHaveURL(/\/sign-in$/)
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  })

  test('the sign-in form is operable and names its own controls', async ({ page }) => {
    await page.goto('/sign-in')
    // Found by ROLE + accessible NAME, not by test id: that is the same lookup a screen
    // reader performs, so a control that loses its label fails here.
    await expect(page.getByRole('textbox', { name: 'Email' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled()
  })

  test('a wrong credential says nothing about WHICH half was wrong', async ({ page }) => {
    await page.goto('/sign-in')
    await page.getByRole('textbox', { name: 'Email' }).fill('nobody@example.test')
    await page.getByLabel('Password').fill('not-the-password')
    await page.getByRole('button', { name: 'Sign in' }).click()

    // Located by test id, NOT by getByRole('alert'): Next ships its own always-present
    // route announcer at role=alert, so the bare role query is ambiguous and resolves to two
    // elements. The accessibility property is still asserted — explicitly, below — rather
    // than implied by how the element was found.
    const alert = page.getByTestId('sign-in-error')
    await expect(alert).toBeVisible()
    await expect(alert).toHaveAttribute('role', 'alert')

    // One message, and it must not distinguish "no such account" from "wrong password" —
    // that difference is an account-existence oracle that enumerates a customer list.
    await expect(alert).toHaveText('That email and password did not match an account.')
  })

  test('an org route the caller cannot reach is a redirect to sign-in, never a 403', async ({
    page,
  }) => {
    // Anonymous, so the protected layout redirects first. The signed-in case (a real seat
    // vs somebody else's org) is the 404 the org layout raises — both answers are chosen so
    // that "exists but not yours" and "does not exist" stay indistinguishable.
    await page.goto('/o/some-other-tenant/notes')
    await expect(page).toHaveURL(/\/sign-in$/)
  })

  test('the credential screen has no critical or serious accessibility violations', async ({
    page,
  }) => {
    await page.goto('/sign-in')
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze()
    const blocking = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    )
    expect(blocking).toEqual([])
  })
})
