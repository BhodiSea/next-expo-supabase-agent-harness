import type { HeaderSource } from './context.js'
import { readHeader } from './context.js'

// ---------------------------------------------------------------------------
// CSRF: the one guard the AMBIENT-credential transport needs and the bearer
// transport does not.
//
// A bearer token is NOT ambient. A cross-site page cannot read it out of the
// keychain, so it cannot attach it, so a forged cross-site request to a bearer
// endpoint carries no credential and RLS answers it with zero rows. The bearer
// surface (apps/mobile) therefore needs nothing here.
//
// A cookie IS ambient: the browser attaches it to ANY request to its origin,
// including one a malicious page triggers. So a cookie-authenticated mutation
// endpoint that trusts "the cookie is present" trusts the attacker's page as
// much as the user's. That is CSRF, and it is why apps/web's route handler
// applies this check on — and ONLY on — the cookie path.
//
// THE SIGNAL IS FETCH METADATA, NOT A TOKEN. `Sec-Fetch-Site` is set by the
// browser and is a FORBIDDEN header name: page JavaScript cannot set or forge it
// (https://fetch.spec.whatwg.org/#forbidden-header-name). A cross-site request
// therefore cannot lie about being cross-site, which makes this a stronger guard
// than a double-submit token (readable by a same-site subdomain XSS) and one
// that needs no per-session server state. The `Origin` fallback covers the
// shrinking set of clients that predate Fetch Metadata.
//
// THE CHECK RUNS BEFORE ANY VERIFICATION. The host applies it on the raw
// request, before it builds a cookie client or calls getUser(). That ordering is
// load-bearing: getUser() on a cookie client refreshes the session as a side
// effect, and a refresh rotates the token server-side. If a cross-site request
// could reach that refresh, an attacker could rotate a victim's token — then
// withhold the new value, since the request is about to be rejected — and sign
// the victim out. Refuse first; verify only what survives.
// SOURCE: https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Sec-Fetch-Site
// (the browser sets it; scripts cannot) · docs/security/sandbox-and-supply-chain.md
// ---------------------------------------------------------------------------

/**
 * The stable code the host stamps on a rejected request's body.
 *
 * Deliberately NOT a member of @app/contracts' `TransportErrorCode`: those are
 * the conditions rejected INSIDE the tRPC router, and they ride a tRPC error's
 * `data.appCode`. A CSRF rejection is refused by the HOST before the router is
 * ever reached, so it is a plain 403 that never passes through the error
 * formatter — folding it into the router's code set would imply a code path that
 * does not exist.
 */
export const CSRF_REJECTED_CODE = 'csrf_failed'

/**
 * The `Sec-Fetch-Site` values that are NOT a cross-site attack:
 *   · same-origin  scheme+host+port match — a first-party request.
 *   · same-site    a sibling on the same registrable domain (app.example.com →
 *                  api.example.com). A first party in this deployment, not an
 *                  attacker's page.
 *   · none         user-initiated with no initiating document (a typed URL, a
 *                  bookmark, the browser itself). A CSRF needs an attacker
 *                  DOCUMENT, so there is nothing here to forge.
 * The only other value the header takes is `cross-site`, which is exactly what
 * this guard exists to refuse.
 */
const SAME_PARTY_FETCH_SITES = new Set(['same-origin', 'same-site', 'none'])

/**
 * The @supabase/ssr session cookie: `sb-<project-ref>-auth-token`, optionally
 * chunked (`…auth-token.0`, `.1`). `[^;=]*` stays inside a single cookie NAME —
 * it cannot cross the `;` between cookies or the `=` into a value — so this
 * matches the presence of the auth cookie and nothing accidental around it.
 *
 * Presence is ALL this reads: never the value, which is unverified here by
 * design (see the header note — verification happens after this gate). A loose
 * match errs the safe way: a false positive only enforces CSRF on a request that
 * already carries a session-shaped cookie, which is precisely when it should be
 * enforced; a false negative — missing a real credential — is the dangerous
 * direction, and the anchored name shape closes it.
 */
const SUPABASE_AUTH_COOKIE = /(?:^|;\s*)sb-[^;=]*auth-token/i

/**
 * True when the request presents an ambient session cookie — the only case in
 * which CSRF applies. A request with no such cookie is anonymous over this
 * transport (a curl health check, a signed-out browser): there is no ambient
 * credential to abuse, so the guard is moot and skipping it keeps the anonymous
 * path — health included — free of both the check and the auth round trip that
 * follows a positive result.
 */
export function hasAmbientSessionCookie(headers: HeaderSource): boolean {
  const cookie = readHeader(headers, 'cookie')
  return cookie !== null && SUPABASE_AUTH_COOKIE.test(cookie)
}

/**
 * True when a request must be refused as cross-site. The host applies it ONLY
 * after `hasAmbientSessionCookie` and ONLY on the cookie path.
 *
 * `selfOrigin` is the bare origin this endpoint is served from (scheme+host+port,
 * no path) — the host derives it from the request URL. It is the allowlist for
 * the Origin fallback, and in this stack the web app serves its own API, so
 * same-origin is the whole of the legitimate set.
 */
export function isCrossSiteRequest(headers: HeaderSource, selfOrigin: string): boolean {
  const site = readHeader(headers, 'sec-fetch-site')
  if (site !== null) {
    // The browser stated it directly, and it cannot be made to lie: refuse iff
    // the value is outside the same-party set. This is the path virtually every
    // real browser takes.
    return !SAME_PARTY_FETCH_SITES.has(site)
  }
  // No Fetch Metadata (an older or non-browser client). Fall back to Origin,
  // which a browser still sends on any cross-origin request and on every
  // state-changing same-origin one.
  const origin = readHeader(headers, 'origin')
  if (origin === null) {
    // Neither signal on a cookie-bearing request. A legitimate same-origin
    // browser request carries at least one of the two; the absence of both is a
    // shape a first party does not produce, so an ambient-credential endpoint
    // fails closed rather than trusting it.
    return true
  }
  return origin !== selfOrigin
}
