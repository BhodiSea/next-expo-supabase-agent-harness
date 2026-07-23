// ---------------------------------------------------------------------------
// The project credentials, and the one guard that separates the two key kinds.
//
// A Supabase project is addressed by a URL plus a key, and WHICH key is the
// entire security story. The publishable key authenticates the request to the
// API gateway and nothing more — the caller's authority comes from the JWT it
// carries, and RLS is what evaluates it. The secret (service-role) key carries
// authority by ROLE ATTRIBUTE and bypasses row security outright.
//
// Both are strings. Nothing about their TYPE distinguishes them, which is why
// the mix-up this file guards against is a one-character autocomplete away and
// is silent in every test that runs as a privileged user.
// ---------------------------------------------------------------------------

/**
 * A project's public address. `publishableKey` is public BY CONSTRUCTION: it
 * appears in every request a browser makes and is inlined into the native
 * binary at build time. Safety rests on row-level security, never on this
 * value being hard to read.
 *
 * The field is `publishableKey` rather than `anonKey` because that is the name
 * Supabase's current key format uses (`sb_publishable_…`); the legacy JWT-shaped
 * anon key is the same slot under an older name and is accepted unchanged.
 */
export interface SupabaseCredentials {
  readonly publishableKey: string
  readonly url: string
}

/**
 * The prefix on a Supabase SECRET key. Checked as a prefix, never by decoding:
 * a decoder in this package would be a second place that has to be right about
 * key formats, and the prefix is the part Supabase guarantees.
 *
 * STATED LIMIT: this catches the CURRENT key format only. The legacy anon and
 * service-role keys are both signed tokens with the same outward shape and the
 * role in the payload, so a prefix test cannot tell them apart and a decoder
 * that could would be trusting an unverified payload to make a security
 * decision — the exact anti-pattern `verify.ts` exists to forbid. Projects on
 * the legacy keys are covered by the env split (a server-only variable is not
 * reachable from a client bundle at all), not by this check. This is a second
 * line, not the first.
 * SOURCE: Supabase API keys — publishable keys are prefixed `sb_publishable_`
 * and secret keys `sb_secret_`. https://supabase.com/docs/guides/api/api-keys
 */
const SECRET_KEY_PREFIX = 'sb_secret_'

/** A project URL must be absolute and http(s). A relative one turns every
 * request into a same-origin call that reads as a server fault, not as config. */
const ABSOLUTE_HTTP_URL = /^https?:\/\/[^\s/]+/

/**
 * Validate credentials on their way into a PUBLIC factory (browser, native,
 * bearer, cookie-server).
 *
 * It THROWS rather than returning an `ActionOutcome`. That is not a violation
 * of the envelope rule — the envelope carries DOMAIN failures, and a project
 * with no URL is not a domain failure, it is a deployment that cannot serve any
 * request at all. Returning an outcome here would let a misconfigured build
 * boot, answer every call with a uniform "unavailable", and be diagnosed from a
 * dashboard days later instead of from a stack trace on the first request.
 *
 * The failure mode each check prevents:
 *
 *  - EMPTY URL or KEY. `.env.example` ships every value empty on purpose, so
 *    `SUPABASE_URL=` (present, blank) is the overwhelmingly common shape of
 *    "not configured yet". A blank URL yields relative fetches; a blank key
 *    yields a 401 on every call. Both read as a server outage.
 *  - A SECRET KEY IN A PUBLIC FACTORY. This is the one that matters. A secret
 *    key handed to the browser factory is compiled into the JS bundle; handed
 *    to the native factory it is inside a binary already on users' devices,
 *    where the only remedy is rotation. And because it bypasses RLS, every
 *    policy in the repository stops applying to the surface that holds it —
 *    the failure is invisible in testing precisely because everything works.
 */
export function requireCredentials(
  credentials: Partial<SupabaseCredentials>,
  source: string,
): SupabaseCredentials {
  const url = credentials.url ?? ''
  const publishableKey = credentials.publishableKey ?? ''

  if (url === '' || publishableKey === '') {
    throw new Error(
      `Supabase is not configured — ${source} must supply both a project URL and a publishable key`,
    )
  }
  if (!ABSOLUTE_HTTP_URL.test(url)) {
    throw new Error(`Supabase project URL from ${source} must be an absolute http(s) URL`)
  }
  if (publishableKey.startsWith(SECRET_KEY_PREFIX)) {
    throw new Error(
      `refusing to build a public Supabase client with a SECRET key from ${source} — a secret key bypasses row-level security and this client's key ships to the caller`,
    )
  }
  return { publishableKey, url }
}

/**
 * True when a key is the elevated kind. Exported because the service-role
 * factory asserts the MIRROR of `requireCredentials`: the public factories
 * refuse a secret key, and the elevated one refuses a publishable key. A
 * service-role client built with a publishable key is worse than a broken one —
 * it works for everything the caller could already do and fails only on the
 * elevated operation it exists for, which is the hardest kind of bug to read.
 */
export function isSecretKey(key: string): boolean {
  return key.startsWith(SECRET_KEY_PREFIX)
}
