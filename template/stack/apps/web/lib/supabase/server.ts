import type { SupabaseCookieAdapter, SupabaseServerClient } from '@app/supabase'
import { createBearerSupabaseClient, createServerSupabaseClient } from '@app/supabase'
import type { User } from '@supabase/supabase-js'
import { cookies } from 'next/headers'

// The server-side Supabase seam for apps/web. @app/supabase owns client construction, the
// typed Database generic and the env resolution, and imports nothing from next/* (the
// reversibility wall — the same package is what a standalone apps/api would consume
// unchanged). What it structurally cannot own is WHERE cookies live on this host, so this
// module supplies exactly that: a SupabaseCookieAdapter over next/headers, and nothing else.
//
// Two factories, because this app has two kinds of caller and they authenticate differently:
//   createRequestScopedClient()  browser sessions — the credential is an httpOnly cookie
//   createBearerScopedClient()   apps/mobile — the credential is an Authorization header
// app/api/trpc/[trpc]/route.ts picks between them per request; everything else in the web
// surface (Server Components, Server Actions, lib/app-data/*) uses the cookie one.

/**
 * A per-request, cookie-backed Supabase client for Server Components, Server Actions and
 * Route Handlers.
 *
 * PER REQUEST, never module-scope. A client hoisted to a module constant is shared by every
 * concurrent request the Node process is serving, which means one user's auth state can be
 * read by another's render — the server-rendering equivalent of a pooled connection leaking
 * a transaction-local identity. Next's `cookies()` is request-scoped by design; building the
 * client from it inside the call is what keeps the identity request-scoped too.
 * SOURCE: docs/security/sandbox-and-supply-chain.md (request-scoped identity, never shared
 * process state) docs/harness/README.md
 */
export async function createRequestScopedClient(): Promise<SupabaseServerClient> {
  const store = await cookies()
  const adapter: SupabaseCookieAdapter = {
    getAll: () => store.getAll(),
    setAll: (cookiesToSet) => {
      try {
        for (const { name, value, options } of cookiesToSet) store.set(name, value, options)
      } catch {
        // Server Components may not write cookies — Next throws here by design, because the
        // response headers are already committed by the time a component renders. This is
        // the EXPECTED path, not an error to report: proxy.ts has already refreshed the
        // session for this request and written the rotated cookie, so the value being
        // dropped here is one the browser already holds. Swallowing it in a Server Action
        // or Route Handler would be a bug — but those contexts CAN write, so they never
        // reach this catch. If sessions start expiring mid-use, the proxy matcher is what
        // to look at, not this block.
      }
    },
  }
  return createServerSupabaseClient(adapter)
}

/**
 * A per-request client authenticated by a raw access token — the apps/mobile path.
 *
 * The native client holds its session in the platform keychain and sends it as
 * `Authorization: Bearer <token>`; there is no cookie jar to adapt. RLS still does the
 * enforcing: the token is forwarded to PostgREST, `auth.uid()` resolves from the verified
 * JWT, and a forged or expired token simply matches no rows.
 */
export function createBearerScopedClient(accessToken: string): SupabaseServerClient {
  return createBearerSupabaseClient(accessToken)
}

/**
 * The verified current user, or null.
 *
 * getUser() — NEVER getSession(). This is the single most consequential line in the file, so
 * it is worth being blunt about why: getSession() decodes whatever JWT it finds in the
 * cookie and hands it back WITHOUT verifying the signature. On the client that is merely
 * optimistic; on the server the cookie is attacker-controlled input, so trusting it means
 * anybody who can craft a JSON payload can claim any `sub` they like. getUser() authenticates
 * the token against the auth server before returning; getClaims() (used in proxy.ts) verifies
 * it locally against the project's published asymmetric key. Both are verifications.
 * getSession() is not a verification at all, and it is one autocomplete away.
 *
 * This function is an affordance for RENDERING decisions — "show the signed-in shell". It is
 * not the authorization boundary: that is RLS plus the server-only data layer, and it holds
 * whether or not anybody remembers to call this.
 * SOURCE: docs/security/sandbox-and-supply-chain.md (verify server-side; never trust an
 * unverified token) docs/harness/README.md
 */
export async function getVerifiedUser(): Promise<User | null> {
  const supabase = await createRequestScopedClient()
  const { data, error } = await supabase.auth.getUser()
  if (error) return null
  return data.user
}
