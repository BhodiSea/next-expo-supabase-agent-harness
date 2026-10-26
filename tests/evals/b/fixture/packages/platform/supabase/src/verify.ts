import type { Client } from './types.js'

// ═══════════════════════════════════════════════════════════════════════════
//   THE AUTH DOCTRINE, IN CODE:
//   SERVER-SIDE, USE getClaims() OR getUser(). NEVER getSession().
// ═══════════════════════════════════════════════════════════════════════════
//
// `getSession()` reads the stored session — a cookie, or a keychain entry — and
// HANDS BACK WHATEVER IT FINDS WITHOUT VERIFYING THE JWT SIGNATURE. In a
// browser that is merely optimistic: the user is the one who would be lying to
// themselves, and the database still refuses anything the real token does not
// grant.
//
// On a server it is an AUTHENTICATION BYPASS. The cookie is attacker-controlled
// input. Anyone who can write a cookie can write a JSON payload, so anyone can
// claim any `sub` they like — and `getSession()` will return it, complete with
// a plausible `user.id`, with no error. Code that derives an identity from that
// value and then queries on it has authenticated nobody. Every RLS policy
// downstream becomes decorative, because the query is already scoped by a `sub`
// the attacker chose.
//
// The two verified alternatives, and the difference between them:
//   · `getClaims()` — verifies the token LOCALLY against the project's
//     published asymmetric key (falling back to the auth server when it must).
//     No network round trip on the common path, so it is the right one for a
//     per-request hot path like the session-refresh proxy.
//   · `getUser()` — authenticates the token against the auth server and returns
//     the canonical user record. A round trip, but it also reflects a user who
//     was deleted or banned since the token was minted, which a signature check
//     cannot.
// Both are verifications. `getSession()` is not a verification at all, and it
// is one autocomplete entry away from both of them.
//
// WHY A HELPER RATHER THAN A LINT RULE ALONE: a rule can only forbid. This
// gives the sanctioned call a name, so the correct thing is also the shortest
// thing to write — which is the only reliable way to keep the wrong thing from
// being reached for under time pressure. The lint rule and the reviewer are
// still the enforcement; this is what makes complying free.
// SOURCE: apps/web/proxy.ts and apps/web/lib/supabase/server.ts (the same ban,
// restated at both web seams) · docs/security/sandbox-and-supply-chain.md
// (verify server-side; never trust an unverified token)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The minimum this module needs from a client, declared STRUCTURALLY.
 *
 * Same reasoning as @app/notes' database port: a structural interface is
 * fake-able in three lines, so the null branch, the error branch and the
 * happy path are all reachable from a unit test with no network, no container
 * and no live project — and every one of those branches is a security
 * behaviour that must not regress silently.
 *
 * Note what is absent: there is no `getSession` member. A fake built against
 * this interface CANNOT accidentally exercise the forbidden call, because the
 * port does not describe it.
 */
export interface VerifiedIdentitySource {
  readonly auth: {
    getUser(jwt?: string): Promise<{
      data: { user: { id: string; email?: string | undefined } | null }
      error: unknown
    }>
  }
}

// The real client satisfies the port. This assignment is the compile-time lock:
// if @supabase/supabase-js changes `getUser`'s shape, THIS line reds — at the
// one seam that declares the dependency — rather than every call site
// discovering it separately, or worse, the port quietly widening to `any`.
// Same device as @app/errors' kind-closure constant, for the same reason.
const _clientSatisfiesPort: (client: Client) => VerifiedIdentitySource = (client) => client

/** The verified caller. Nothing here was read from an unverified token. */
export interface VerifiedUser {
  readonly email: string | null
  readonly userId: string
}

/**
 * The verified current user, or null.
 *
 * Pass `accessToken` when the client is a BEARER client: that factory sets
 * `persistSession: false`, so there is no stored session for a no-argument
 * `getUser()` to read and it would answer null for a perfectly valid caller.
 * Cookie clients read their own jar and need no argument.
 *
 * Returns null on error rather than throwing. An unverifiable token is not an
 * exception — it is the ordinary, expected state of "not signed in", and it
 * arrives on every anonymous request. Throwing would make the common path an
 * exception path and invite a `catch` that swallows a real failure with it.
 *
 * This is an affordance for RENDERING and for scoping a query. It is NOT the
 * authorization boundary: that is RLS plus the server-only data layer, and it
 * holds whether or not anybody remembers to call this.
 */
export async function getVerifiedUser(
  client: VerifiedIdentitySource,
  accessToken?: string,
): Promise<VerifiedUser | null> {
  const { data, error } = await client.auth.getUser(accessToken)
  if (error !== null && error !== undefined) return null
  const user = data.user
  if (user === null) return null
  return { email: user.email ?? null, userId: user.id }
}

/**
 * The verified user id, or null — the one field a query needs to scope itself.
 *
 * Separate from `getVerifiedUser` because a data path that only needs `sub`
 * should not be handed an object with an email on it: the narrower the value a
 * layer receives, the less of it can end up somewhere it was not meant to go.
 */
export async function getVerifiedUserId(
  client: VerifiedIdentitySource,
  accessToken?: string,
): Promise<string | null> {
  return (await getVerifiedUser(client, accessToken))?.userId ?? null
}

// Exported so no linter can prune the compile-time lock above as dead code —
// the whole mechanism is the type annotation on a value that has to survive.
/** Compile-time only: reds `tsc -b` if the Supabase client stops satisfying the
 * verification port this package is written against. */
export const CLIENT_SATISFIES_VERIFICATION_PORT: boolean =
  typeof _clientSatisfiesPort === 'function'
