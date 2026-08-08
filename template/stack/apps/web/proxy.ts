import { webEnv } from '@app/env'
import type { SupabaseCookieAdapter } from '@app/supabase'
import { createServerSupabaseClient } from '@app/supabase'
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { contentSecurityPolicy, contentSecurityPolicyReportOnly } from './lib/security-headers'

// ─────────────────────────────────────────────────────────────────────────────
// THIS FILE IS NOT AN AUTHORIZATION BOUNDARY. IT REFRESHES A SESSION. THAT IS ALL.
// ─────────────────────────────────────────────────────────────────────────────
//
// Read that twice before adding an `if (!user) return NextResponse.redirect(...)` here and
// deleting the check in the page. Next's middleware/proxy layer was bypassable in the wild:
// CVE-2025-29927 let an attacker skip middleware entirely by sending a crafted
// `x-middleware-subrequest` request header, so every app whose ONLY gate was a middleware
// redirect served protected pages to anonymous callers. The patch closed that specific
// hole; it did not change the architecture that made the hole fatal. A proxy runs BEFORE
// routing, sees a request the framework has not yet resolved, and is one framework bug — or
// one CDN rewrite, or one direct-to-origin request — away from not running at all.
//
// The real boundaries in this stack, in order of authority:
//   1. Postgres RLS. Every table FORCEs row-level security; a query with the wrong identity
//      returns zero rows even if every layer above it has been compromised.
//   2. The server-only data layer — lib/app-data/* and the @app/notes barrels reached from
//      Server Components, Server Actions and tRPC procedures. They resolve identity from a
//      VERIFIED claim (getClaims/getUser) on a per-request client, never from this file.
//   3. app/(protected)/layout.tsx, which redirects unauthenticated visitors. That is a UX
//      affordance sitting on top of (1) and (2) — the pleasant version of the answer, not
//      the enforcement.
// A redirect here would be a FOURTH, weakest copy of a rule that already exists twice. What
// this file does instead is the one job the layers above genuinely cannot do: rotate the
// Supabase auth cookie on the way past, so a user with an expiring refresh token stays
// signed in without a round trip through a signed-out render.
// SOURCE: docs/security/sandbox-and-supply-chain.md (defence in depth; the boundary is the
// data layer and RLS, never a request-interception layer) docs/harness/README.md
/**
 * A fresh 128-bit nonce per document response, base64 as CSP requires.
 *
 * Per REQUEST, never per build or per process: a nonce reused across responses is
 * not a nonce, and an attacker who can read one page's nonce could then inject a
 * script that any other page's CSP would accept.
 * SOURCE: https://www.w3.org/TR/CSP3/#security-nonces (nonces must be unpredictable and per-response)
 */
function mintNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
}

export default async function proxy(request: NextRequest): Promise<NextResponse> {
  // The CSP nonce rides DOCUMENT responses only. A nonce on a JSON or asset response
  // governs nothing — the document's policy is what decides whether a script runs —
  // and minting one per subresource is pure cost.
  const isDocument = request.headers.get('sec-fetch-dest') === 'document'
  const nonce = isDocument ? mintNonce() : null
  const csp = nonce === null ? null : contentSecurityPolicy(nonce, webEnv.NEXT_PUBLIC_SUPABASE_URL)

  // The canonical @supabase/ssr dance, and every line of it is load-bearing. `response` is
  // reassigned inside setAll because a refreshed cookie has to reach TWO different places:
  // the downstream render (which reads `request.cookies`, so the request object is mutated
  // first) and the browser (which reads `Set-Cookie`, so a NextResponse rebuilt from the
  // mutated request carries the new value forward). Skip either half and the refresh
  // "works" for exactly one hop before the stale cookie comes back.
  //
  // The nonce is threaded through the REQUEST headers as well as the response, and that
  // half is not optional: Next reads `content-security-policy` off the incoming request to
  // discover the nonce it must stamp onto its own inline bootstrap script. Set it only on
  // the response and the header is correct, the page is blank, and the browser console
  // blames a script Next generated. This is the single most common way a nonce CSP ships
  // broken — the Playwright violation collector in e2e/security-headers.spec.ts exists to
  // make that state unshippable rather than merely documented.
  // SOURCE: https://nextjs.org/docs/app/guides/content-security-policy (nonce propagation via request headers)
  const buildResponse = (): NextResponse => {
    const headers = new Headers(request.headers)
    if (nonce !== null && csp !== null) {
      headers.set('x-nonce', nonce)
      headers.set('content-security-policy', csp)
    }
    return NextResponse.next({ request: { headers } })
  }

  let response = buildResponse()

  // The adapter is the whole of apps/web's obligation to @app/supabase: that package owns
  // the client construction and the env resolution and imports NOTHING framework-specific,
  // so the ONE thing it cannot know is where cookies live on this host. Annotating the
  // literal (rather than inlining it) states the contract at the call site — a shape change
  // upstream reds here, at the wiring, instead of somewhere inside a lambda's inferred type.
  const cookies: SupabaseCookieAdapter = {
    getAll: () => request.cookies.getAll(),
    setAll: (cookiesToSet) => {
      for (const { name, value } of cookiesToSet) request.cookies.set(name, value)
      // buildResponse() re-reads request.headers AFTER the mutation above, so the
      // rebuilt response carries both the refreshed cookie and the nonce.
      response = buildResponse()
      for (const { name, value, options } of cookiesToSet) {
        response.cookies.set({ name, value, ...options })
      }
    },
  }
  // The cookie POSTURE is passed explicitly, not defaulted. This proxy REWRITES the session
  // cookie on every pass, so whatever attributes it omits are attributes it strips: a rotated
  // cookie written without `Secure` silently downgrades the one the browser had set with it,
  // on every request, for the rest of the session. `httpOnly` is deliberately absent and
  // cannot be added — the browser client both writes and reads this cookie, and an HttpOnly
  // cookie is invisible to script by definition (lib/supabase/client.ts states the trade and
  // what mitigates it). `secure` is derived from the scheme rather than hard-coded so that
  // http://localhost development still persists a session; a user agent DROPS a Secure cookie
  // set over plain http.
  // SOURCE: apps/web/lib/supabase/client.ts (the browser half writes the same attributes)
  const supabase = createServerSupabaseClient(cookies, {
    cookieOptions: { secure: request.nextUrl.protocol === 'https:' },
  })

  // getClaims(), never getSession(). getSession() reads the cookie and hands back whatever
  // it finds WITHOUT verifying the JWT signature — on a server that is an unauthenticated
  // read of attacker-controlled input. getClaims() verifies (locally against the project's
  // published asymmetric key, or by asking the auth server) and, as a side effect, performs
  // the refresh this whole file exists for. The return value is deliberately discarded: the
  // decision about WHO the caller is belongs to the data layer, not here.
  // SOURCE: docs/security/sandbox-and-supply-chain.md (never trust an unverified token)
  // apps/web/lib/supabase/server.ts (the same getSession ban, restated at the data seam)
  await supabase.auth.getClaims()

  // The enforcing policy on the way out, plus a report-only twin pointed at the
  // in-app collector. Report-only is not redundant: the enforcing header tells the
  // browser what to block, and nothing tells YOU that it blocked something. A
  // violation in production is otherwise invisible until a user reports a blank page,
  // and a local Playwright run only proves the routes it visits.
  if (nonce !== null && csp !== null) {
    response.headers.set('content-security-policy', csp)
    response.headers.set(
      'content-security-policy-report-only',
      contentSecurityPolicyReportOnly(nonce, webEnv.NEXT_PUBLIC_SUPABASE_URL),
    )
  }

  return response
}

// The matcher. Two of these exclusions are not cosmetic — they are correctness.
//
// `api/trpc` — the tRPC endpoint is the SHARED API surface: apps/mobile calls it with an
// `Authorization: Bearer <access token>` header and no cookies at all. Running a
// cookie-refresh pass over it is wrong in both directions. For the native client it burns a
// token-refresh round trip on every request to rotate a credential the caller does not
// possess, and any `Set-Cookie` it emits is noise a native HTTP client either drops or —
// worse — persists in a shared cookie jar. For a browser caller it opens a genuine race:
// the proxy and the route handler's own per-request client would both attempt a refresh on
// the same refresh token, and Supabase's rotation invalidates the loser's. That is the
// "randomly signed out mid-session" bug, and it is invisible in every test that exercises
// one layer at a time. Cookie middleware and a bearer API can coexist only if they do not
// overlap. The route handler builds its own client — see app/api/trpc/[trpc]/route.ts.
//
// `.well-known` — Apple's CDN fetches /.well-known/apple-app-site-association and Google's
// fetches /.well-known/assetlinks.json cookie-lessly, and they demand a byte-exact 200 with
// no redirect. A proxy pass that attaches Set-Cookie or rewrites the response fails
// universal-link / App-Links verification SILENTLY: deep links simply stop opening the app
// and start opening the browser, with nothing in any log to explain it. ACME HTTP-01
// challenges live under the same prefix and have the same intolerance.
//
// The remaining entries are the ordinary static-asset exclusions: running an auth refresh
// per image is pure latency.
// SOURCE: https://developer.apple.com/documentation/xcode/supporting-associated-domains
// (the AASA file must be served over https with no redirects) and
// https://developer.android.com/training/app-links/verify-android-applinks (assetlinks.json
// must be reachable unmodified) — docs/harness/README.md
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|api/trpc|\\.well-known|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|txt|xml|webmanifest)$).*)',
  ],
}
