import type { SupabaseBrowserClient } from '@app/supabase/client'

// DSR ERASE, WEB HALF (0.11.0). The mobile surface has shipped since 0.7.0 — the
// `session.deleteAccount` command plus the `delete-account` Edge Function behind it — and
// `expo-policy` REQUIRES it there, because Apple 5.1.1(v) refuses an auth-bearing app with
// no in-app deletion. Nothing made the same demand of the web app, so for four releases the
// rail existed and only one of the two surfaces could reach it. `tools/data-flow.json` now
// carries an `erase` record with a `clients` closure naming BOTH initiators, so the gate
// that holds export to a delivered surface holds erase to one too.
// SOURCE: https://developer.apple.com/app-store/review/guidelines/#5.1.1 (in-app deletion)
// SOURCE: supabase/functions/README.md (Edge Functions are the one sanctioned home for
// service-role code)
//
// WHY THIS IS A PLAIN FUNCTION AND NOT THE COMPONENT. `apps/web/app/**` is excluded from the
// unit lane and from diff-coverage (see docs/harness/enforcement-tiers.md), so logic written
// inside the button is logic no floor can hold. The choreography that MATTERS — server-side
// deletion first, local session torn down only after it succeeds, and a failure that leaves
// the session intact — lives here, where `apps/web/__tests__/delete-account.test.ts` runs it
// under the `unit` Stop step. The component is the two-step confirm and nothing else.
//
// WHY AN EDGE FUNCTION AND NOT A tRPC PROCEDURE — the same reason the mobile half records:
// deleting a user is the one operation RLS cannot express, because the row being removed IS
// the identity the policies are evaluated against. It needs the service-role client, whose
// only sanctioned home is an ADR-governed Edge Function. `functions.invoke` carries the
// caller's own bearer token, so the function deletes the CALLER and has no user id to be
// tricked about.

/** What the caller must do next. `deleted` is the only state that may end the session. */
export type EraseOutcome =
  | { readonly status: 'deleted' }
  | { readonly status: 'failed'; readonly detail: string | null }

/**
 * Erase the signed-in account, server first.
 *
 * ORDER IS THE WHOLE CONTRACT and it is asserted in the proof: the Edge Function runs, and
 * only on success does the local session drop. Signing out first would discard the bearer
 * token the function authenticates with, so a failure after that point would leave an
 * account that is still live and a client that can no longer ask to delete it — a state the
 * user cannot get out of without signing in again to retry.
 *
 * NOTHING HALF-DELETES: on failure the session is untouched and the caller reports it.
 */
export async function deleteAccount(client: SupabaseBrowserClient): Promise<EraseOutcome> {
  // The browser client is the UNTYPED `Client` (the @app/supabase types.ts doctrine), so
  // `invoke` hands back `any`. Narrow it ONCE here rather than disabling the unsafe-* rules
  // at each use below: everything after this line reads `error` through this shape, and
  // nothing in this function trusts `data` at all.
  const { error } = (await client.functions.invoke<never>('delete-account')) as {
    error: { message?: unknown } | null
  }
  // `!== null` alone: the narrowing above declares the shape supabase-js actually returns
  // ({ data, error }, error being an Error subclass or null), so an `undefined` arm would be
  // a branch the types say cannot happen — which the shipped config reds as unnecessary.
  if (error !== null) {
    // A FunctionsError is not an AppError, so there is no envelope `code` to key copy off.
    // The honest report is "the server could not be reached or refused", with the provider's
    // own text carried as detail rather than promoted to the headline — the mobile half
    // makes the identical choice through translateError's fallback.
    return { status: 'failed', detail: typeof error.message === 'string' ? error.message : null }
  }
  await client.auth.signOut()
  return { status: 'deleted' }
}
