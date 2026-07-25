import { createClient } from '@supabase/supabase-js'
import { requireCredentials, type SupabaseCredentials } from './credentials.js'
import { publicCredentials } from './public-env.js'
import type { SupabaseServerClient } from './types.js'

/**
 * ── FACTORY 3 of 5 · ACCESS TOKEN (bearer) ──────────────────────────────────
 *
 * WHEN TO USE IT: on a server, for a caller whose credential arrived in an
 * `Authorization: Bearer <token>` header rather than in a cookie jar. That is
 * every request from `apps/mobile` — the native app holds its session in the
 * platform keychain, there is no cookie jar on that host, and a `Set-Cookie`
 * aimed at it is either ignored or, in a shared jar, actively harmful.
 *
 * The token is FORWARDED, not trusted. This function does not decode it, does
 * not read a `sub` out of it, and does not decide anything from it. PostgREST
 * verifies the signature at the far end and `auth.uid()` resolves from the
 * verified claims, so a forged or expired token does not produce an error page:
 * it matches no rows. That is the empty-set principle arriving from the other
 * direction, and it is why this factory can accept an arbitrary string safely.
 *
 * FAILURE MODES OF MISUSE:
 *
 *   1. HOISTED TO MODULE SCOPE. The header is baked in at construction, so
 *      every subsequent request served by that warm process runs as the FIRST
 *      caller. This is the cross-tenant read that is invisible under any load
 *      the developer generates alone. Per request, always.
 *   2. `persistSession` LEFT ON (the library default). The server has no
 *      per-user storage, so the session lands in whatever shared storage the
 *      runtime provides and the next caller inherits it. Explicitly false below.
 *   3. USED FOR A COOKIE-BEARING BROWSER REQUEST. The cookie client and this
 *      one would both attempt to refresh the same rotating token, and Supabase
 *      invalidates the loser's — the "randomly signed out mid-session" bug.
 *      One credential shape per request; apps/web's route handler chooses.
 *      SOURCE: apps/web/proxy.ts (the matcher excludes /api/trpc for exactly
 *      this reason) · apps/web/app/api/trpc/[trpc]/route.ts
 *
 * NOTE ON VERIFICATION: because no session is persisted, `client.auth.getUser()`
 * with no argument has nothing to read. Pass the token —
 * `getVerifiedUser(client, accessToken)` does — so the JWT is verified against
 * the auth server rather than assumed.
 */
export function createBearerSupabaseClient(
  accessToken: string,
  credentials?: SupabaseCredentials,
): SupabaseServerClient {
  if (accessToken === '') {
    // An empty bearer would build a client that sends `Authorization: Bearer `
    // — a malformed header PostgREST rejects wholesale, which reads as a broken
    // deployment rather than as the missing credential it is. Callers with no
    // token want the anonymous path, and asking for it explicitly is the point.
    throw new Error('createBearerSupabaseClient requires a non-empty access token')
  }
  const { publishableKey, url } = credentials
    ? requireCredentials(credentials, 'the caller')
    : publicCredentials()

  // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- @supabase/supabase-js's createClient is untyped by deliberate doctrine (types.ts: no Database generic; rows are re-parsed at the DAL exit). This return is the intentional untyped-client boundary.
  return createClient(url, publishableKey, {
    auth: {
      // All three off. This client is a courier for one request's credential and
      // owns no session: nothing to refresh, nothing to persist, no URL to read.
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: {
      // The header, not `setSession()`. `setSession` mutates the client's own
      // auth state, which is process-shared the moment anyone caches a client;
      // a header is per-instance data that cannot leak into another request even
      // if the instance escapes.
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  })
}
