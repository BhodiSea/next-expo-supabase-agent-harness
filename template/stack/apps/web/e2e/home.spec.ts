import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

// The seeded browser proof for the web surface. It exercises the public landing route
// (app/page.tsx renders anonymously) and runs the ONLY browser-side axe accessibility scan
// in the whole harness — the mobile lane's a11y net is lint + RNTL, and neither sees the DOM.
// A consumer's first web screen inherits a working, non-vacuous smoke + a11y test; extend it
// (a spec per route) rather than delete it — tools/check-web-e2e.mjs reds an empty or
// assertion-free suite, and a11y-less specs, before Playwright ever runs.

test.describe('home', () => {
  test('renders the landing heading for an anonymous visitor', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible()
  })

  test('has no critical or serious accessibility violations', async ({ page }) => {
    await page.goto('/')
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze()
    const blocking = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    )
    expect(blocking).toEqual([])
  })
})
