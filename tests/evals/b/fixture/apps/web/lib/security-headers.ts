// The response security posture, as DATA.
//
// WHY THIS IS A ZERO-IMPORT MODULE. It is evaluated by tools/check-security-headers.mjs
// under `node --experimental-strip-types`, which needs no bundler, no tsx, and no
// node_modules. That is what makes the gate hermetic: it reads the VALUES this file
// actually produces rather than grepping its text for directive names. A gate that
// greps is satisfied by a directive that appears in a comment.
//
// WHY supabaseOrigin IS A PARAMETER. Reading `process.env.NEXT_PUBLIC_SUPABASE_URL`
// here would make `connect-src` evaluate to the string "undefined" whenever the gate
// runs without a populated env — which is every CI static lane. The caller supplies
// it; the gate supplies a fixture value. The env read stays at the one call site that
// already validates it (@app/env).
// SOURCE: https://www.w3.org/TR/CSP3/#strict-dynamic-usage (strict-dynamic propagates trust
// from a nonced script to the scripts it loads — the deployable shape for a framework that
// injects its own bootstrap)
// SOURCE: docs/harness/README.md (policy as reviewable data, asserted by value)

// Deliberately NOT exported. It is the shape of one Next `headers()` entry and nothing
// outside this module names it: next.config.ts spreads the arrays, the gate evaluates
// them under tsx and reads plain objects, and apps/web is a build leaf with
// `declaration: false`, so an unexported type in an exported signature emits nothing to
// be un-nameable. Exporting it would advertise an API surface that has no consumer.
interface SecurityHeader {
  readonly key: string
  readonly value: string
}

/**
 * Headers that do not depend on the request. Applied by next.config.ts `headers()`
 * to every response, so the posture does not depend on a reverse proxy someone
 * remembers to configure.
 *
 * `@public` because next.config.ts is its ONLY consumer and knip's production mode
 * excludes configuration files by design — so `dead-code` reports this as an unused
 * export while the header it installs is on every response in production. The tag
 * records that the consumer is real and lives where the analysis cannot look; deleting
 * it would delete the security posture, which is the opposite of what the gate means.
 * @public
 */
export function staticSecurityHeaders(): readonly SecurityHeader[] {
  return [
    // Two years, subdomains included, preload-list eligible. `preload` is a DECISION:
    // it is close to irreversible (removal from the browser preload list takes
    // months), so it is recorded in tools/security-headers.json rather than left to
    // whoever edits this line next.
    // SOURCE: https://www.rfc-editor.org/rfc/rfc6797#section-6.1 (Strict-Transport-Security
    // grammar: max-age is required, includeSubDomains extends it to every subdomain)
    { key: 'strict-transport-security', value: 'max-age=63072000; includeSubDomains; preload' },

    // A JSON response sniffed as HTML is a stored-XSS delivery vehicle.
    { key: 'x-content-type-options', value: 'nosniff' },

    // Full URL to same origin, origin only cross-origin, nothing over a downgrade.
    // Path segments in this app carry org slugs — a full-URL Referer to a third party
    // leaks tenant identity.
    { key: 'referrer-policy', value: 'strict-origin-when-cross-origin' },

    // Deny by default. Every entry is an empty allowlist, not an omission: a feature
    // absent from this header is permitted by the browser default in some engines.
    {
      key: 'permissions-policy',
      value: [
        'accelerometer=()',
        'autoplay=()',
        'camera=()',
        'display-capture=()',
        'encrypted-media=()',
        'fullscreen=(self)',
        'geolocation=()',
        'gyroscope=()',
        'magnetometer=()',
        'microphone=()',
        'midi=()',
        'payment=()',
        'usb=()',
        'xr-spatial-tracking=()',
        'browsing-topics=()',
        'interest-cohort=()',
      ].join(', '),
    },

    // The legacy companion to CSP frame-ancestors, kept for engines that honour only
    // one of the two. They must agree; the gate asserts that they do.
    { key: 'x-frame-options', value: 'DENY' },

    // Process isolation: a cross-origin opener cannot reach into this window, and a
    // cross-origin document cannot embed this app's subresources.
    { key: 'cross-origin-opener-policy', value: 'same-origin' },
    { key: 'cross-origin-resource-policy', value: 'same-origin' },

    // Cross-Origin-Embedder-Policy is DELIBERATELY ABSENT — see the `coep` decision in
    // tools/security-headers.json. `require-corp` breaks every third-party embed and
    // image that does not send CORP, and a gate that produces a broken app is a gate
    // everyone exempts. Recorded, not forgotten.
  ]
}

/**
 * The Content-Security-Policy for a DOCUMENT response. `nonce` is minted per request
 * in proxy.ts; `supabaseOrigin` is the project URL the browser client talks to.
 *
 * `'strict-dynamic'` is the load-bearing token: it tells a CSP3 browser to trust
 * scripts loaded BY a nonce-trusted script, which is exactly how Next hydrates
 * (one inline bootstrap that pulls the chunk graph). Host allowlists are ignored
 * when it is present, which is the point — an allowlist is what attackers bypass.
 * `'unsafe-inline'` is listed only as the CSP2 fallback that CSP3 browsers ignore in
 * the presence of a nonce; the gate asserts it never appears WITHOUT strict-dynamic.
 */
export function contentSecurityPolicy(nonce: string, supabaseOrigin: string): string {
  const wsOrigin = supabaseOrigin.replace(/^http/, 'ws')
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-inline' https:`,
    // Next injects inline <style> for critical CSS with no nonce hook, so
    // 'unsafe-inline' here is structural. It is a materially smaller risk than on
    // script-src: CSS injection cannot execute, and exfiltration via selectors is
    // bounded by connect-src and img-src below.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    `connect-src 'self' ${supabaseOrigin} ${wsOrigin}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    'upgrade-insecure-requests',
  ].join('; ')
}

/**
 * The report-only twin, pointed at the in-app collector. A violation in production is
 * otherwise invisible until a user reports a blank page — a local Playwright run only
 * proves the routes it visits.
 */
export function contentSecurityPolicyReportOnly(nonce: string, supabaseOrigin: string): string {
  return `${contentSecurityPolicy(nonce, supabaseOrigin)}; report-uri /api/csp-report`
}

/**
 * Responses that carry tenant data must never be stored by a shared cache. `Vary`
 * names every input that changes the body: the session cookie and the acting-org
 * selector. Omitting `x-org-id` from Vary is the shape of a cross-tenant CDN
 * poisoning bug — same URL, same cookie-less edge key, different tenant's rows.
 *
 * `@public` for the same reason as staticSecurityHeaders above: next.config.ts is
 * the only consumer, and knip's production mode does not read configuration files.
 * @public
 */
export function authenticatedCacheHeaders(): readonly SecurityHeader[] {
  return [
    { key: 'cache-control', value: 'private, no-store' },
    { key: 'vary', value: 'Cookie, x-org-id' },
  ]
}
