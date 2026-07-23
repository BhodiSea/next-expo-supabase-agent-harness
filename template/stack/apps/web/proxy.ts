import type { SupabaseCookieAdapter } from '@app/supabase'
import { createServerSupabaseClient } from '@app/supabase'
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

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
export default async function proxy(request: NextRequest): Promise<NextResponse> {
  // The canonical @supabase/ssr dance, and every line of it is load-bearing. `response` is
  // reassigned inside setAll because a refreshed cookie has to reach TWO different places:
  // the downstream render (which reads `request.cookies`, so the request object is mutated
  // first) and the browser (which reads `Set-Cookie`, so a NextResponse rebuilt from the
  // mutated request carries the new value forward). Skip either half and the refresh
  // "works" for exactly one hop before the stale cookie comes back.
  let response = NextResponse.next({ request })

  // The adapter is the whole of apps/web's obligation to @app/supabase: that package owns
  // the client construction and the env resolution and imports NOTHING framework-specific,
  // so the ONE thing it cannot know is where cookies live on this host. Annotating the
  // literal (rather than inlining it) states the contract at the call site — a shape change
  // upstream reds here, at the wiring, instead of somewhere inside a lambda's inferred type.
  const cookies: SupabaseCookieAdapter = {
    getAll: () => request.cookies.getAll(),
    setAll: (cookiesToSet) => {
      for (const { name, value } of cookiesToSet) request.cookies.set(name, value)
      response = NextResponse.next({ request })
      for (const { name, value, options } of cookiesToSet) {
        response.cookies.set({ name, value, ...options })
      }
    },
  }
  const supabase = createServerSupabaseClient(cookies)

  // getClaims(), never getSession(). getSession() reads the cookie and hands back whatever
  // it finds WITHOUT verifying the JWT signature — on a server that is an unauthenticated
  // read of attacker-controlled input. getClaims() verifies (locally against the project's
  // published asymmetric key, or by asking the auth server) and, as a side effect, performs
  // the refresh this whole file exists for. The return value is deliberately discarded: the
  // decision about WHO the caller is belongs to the data layer, not here.
  // SOURCE: docs/security/sandbox-and-supply-chain.md (never trust an unverified token)
  // apps/web/lib/supabase/server.ts (the same getSession ban, restated at the data seam)
  await supabase.auth.getClaims()

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
