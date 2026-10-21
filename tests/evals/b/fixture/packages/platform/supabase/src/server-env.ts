import { parseWebPublicEnv, serverEnv } from '@app/env'
import { isSecretKey, requireCredentials, type SupabaseCredentials } from './credentials.js'

// ---------------------------------------------------------------------------
// The SERVER half of the environment. Imported only from `src/index.ts`'s
// graph — never from `src/client.ts`'s.
//
// That separation is the whole reason this file is not merged into
// `public-env.ts`. `@app/env`'s `.` barrel names every server secret in its
// schema; `client.ts` is bundled by Metro; a single import edge from one to the
// other would put the secret schema into a native binary. Two files, one edge
// each, and the edge that matters is absent by construction rather than by
// review.
// SOURCE: tools/exports-walls.json (@app/env: the `.` barrel parses the full
// server environment) · design/W1-STACK-SPEC.md §4
// ---------------------------------------------------------------------------

/**
 * The credentials a SERVER client uses for ordinary, RLS-scoped work.
 *
 * Note what this is NOT: it is the publishable key, the same one the browser
 * carries. A server request is not privileged because it is a server request —
 * it is privileged exactly as far as the verified identity it forwards, and
 * that is the property RLS is checking. Reaching for the service key here
 * because "it is server-side anyway" is how an authorization boundary becomes
 * decorative in a single commit.
 */
export function serverPublicCredentials(): SupabaseCredentials {
  // The PUBLIC pair, read from the web-public schema — not from serverEnv. The
  // two schemas are disjoint by design: NEXT_PUBLIC_* is inlined into the browser
  // bundle, the service key never is, and merging them would let a server-only
  // secret be requested by name from a module the client also reaches.
  const env = parseWebPublicEnv()
  return requireCredentials(
    {
      publishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE,
      url: env.NEXT_PUBLIC_SUPABASE_URL,
    },
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE',
  )
}

/**
 * The ELEVATED credentials. Called from exactly one place —
 * `createServiceRoleClient_BYPASSES_RLS` — and that is not an accident of the
 * current code but the invariant this function is written to hold.
 *
 * The key is read here rather than passed in so that the service key never
 * appears as a value in application code, where it could be logged, forwarded
 * to a client, or captured in a closure that outlives the call. The only thing
 * a caller can hold is the client.
 */
export function serviceRoleCredentials(): { readonly secretKey: string; readonly url: string } {
  // The project URL is public (it is in every browser request); only the key is
  // elevated. Reading the URL from the public schema keeps ServerEnvSchema down
  // to what is genuinely secret, so a leak of that schema's field list leaks
  // nothing a client could not already see.
  const url = parseWebPublicEnv().NEXT_PUBLIC_SUPABASE_URL
  const secretKey = serverEnv.SUPABASE_SERVICE_ROLE_KEY

  if (url === '' || secretKey === '') {
    throw new Error(
      'the service-role client requires SUPABASE_SERVICE_ROLE_KEY and a project URL — see supabase/functions/README.md',
    )
  }
  // The mirror of the public factories' guard. A PUBLISHABLE key in this slot
  // builds a client that works for everything the caller could already do and
  // fails only on the elevated operation the function exists for — a failure
  // that reads as a policy bug and gets "fixed" by loosening a policy, which is
  // the worst possible outcome of a configuration typo.
  //
  // Prefix-checked, so it is silent for projects still on the legacy key
  // format. That is stated rather than papered over: the real guard for those
  // is that a server-only variable is not reachable from a client bundle at all.
  if (!isSecretKey(secretKey) && secretKey.startsWith('sb_')) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not a secret key — a publishable key cannot perform elevated work',
    )
  }
  return { secretKey, url }
}
