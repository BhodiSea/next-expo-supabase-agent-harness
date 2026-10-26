import { createClient } from '@supabase/supabase-js'
import { serviceRoleCredentials } from './server-env.js'
import type { SupabaseServiceRoleClient } from './types.js'

// ═══════════════════════════════════════════════════════════════════════════
//   THE ELEVATED FACTORY. IT BYPASSES ROW-LEVEL SECURITY.
//   IF YOU ARE READING THIS BECAUSE AUTOCOMPLETE OFFERED IT, STOP.
// ═══════════════════════════════════════════════════════════════════════════
//
// Row-level security is the authorization boundary in this repository. Web and
// mobile talk to the same database through the same policies, so an
// authorization mistake is a mistake in ONE place and one place only, and
// `supabase/tests/**` proves it for every table on every `db reset`.
//
// `service_role` is outside that boundary. It bypasses row security by ROLE
// ATTRIBUTE, which means no policy in this repository constrains it and the RLS
// suite cannot cover it — there is nothing to cover. Whatever holds this key IS
// the boundary, and the boundary is now hand-reviewed application code.
//
// That is sometimes worth paying for: a webhook that must write on behalf of a
// user who is not present, a nightly reconciliation, a provider callback that
// arrives with a signature instead of a session. It is NEVER worth paying by
// accident, which is what happens when the key is available in-process and
// something is marginally easier to do with it than without it.
//
// ─── THE ONLY SANCTIONED HOME: AN ADR-GOVERNED EDGE FUNCTION ────────────────
// `supabase/functions/<name>/index.ts`, with `docs/adr/NNNN-<slug>.md` merged in
// the same change. Not a Server Action. Not a tRPC procedure. Not a script. Not
// a screen. An Edge Function is a SEPARATE DEPLOYMENT UNIT — its own process,
// its own secret scope, its own invocation surface — so the key is reachable
// from exactly one place, that place has a name, and its blast radius fits in a
// paragraph. In the web app the same key would sit in the same process as every
// request handler; in the mobile bundle it would be extractable by anyone who
// downloads the app.
//
// The database backs this up rather than trusting the comment: the seeded
// migrations `REVOKE ALL` from `service_role` on every table, so a function
// holding this key reaches NOTHING until a migration grants it explicitly, per
// table. That grant is the change the ADR is attached to.
// SOURCE: supabase/functions/README.md (Edge Functions are the one sanctioned
// home for service-role code; every one needs an ADR; grants are per-table)
// SOURCE: template/base/env.example (SUPABASE_SERVICE_ROLE_KEY — "its only
// sanctioned home is an ADR-governed Edge Function")
//
// ─── WHY THIS IS AWKWARD ON PURPOSE ─────────────────────────────────────────
// Three frictions, each aimed at a different way the key gets reached for:
//
//   1. THE NAME. `createServiceRoleClient_BYPASSES_RLS` cannot be typed,
//      autocompleted, imported or reviewed without the consequence being in the
//      same token. It is also the grep that answers "does anything elevated
//      exist in this repo?" in one command.
//   2. THE WARRANT ARGUMENT. You cannot call this without naming a merged ADR
//      and writing a sentence about what RLS cannot express. That converts "I
//      needed it to work" into a decision someone signed, at the moment of use,
//      in the diff — not in a document that drifts.
//   3. THE BARREL. It is on `.` only, never on `./client`, so
//      tools/exports-walls.json plus Metro's inability to tree-shake mean this
//      module is structurally unreachable from the mobile bundle.
//
// None of the three is a security control. The controls are the per-table
// grants and the key never being present in a client environment. These are
// what make a reviewer notice, which is the layer that catches the mistake
// before the controls have to.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The justification a caller must produce to construct an elevated client.
 *
 * Both fields are load-bearing and both are checked. Making them optional, or
 * accepting a free-form string, would turn this into a comment — and a comment
 * is what this argument exists to replace.
 */
export interface ServiceRoleWarrant {
  /**
   * Path to the MERGED decision record, e.g.
   * `docs/adr/0007-billing-webhook.md`. Shape-checked below so a placeholder
   * cannot pass; existence is checked by the `migrations` gate, which is where
   * a filesystem read belongs.
   */
  readonly adr: string
  /**
   * One sentence: what this needs that row-level security cannot express. If
   * the sentence can be rewritten as a policy, a database function running as
   * the invoking user, or an ordinary procedure, then the answer is to write
   * that instead — see supabase/functions/README.md's first ADR question.
   */
  readonly reason: string
}

/** `docs/adr/NNNN-slug.md` — the shape the `migrations` gate also parses. */
const ADR_PATH = /^docs\/adr\/\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/

/** Long enough that "because" and "needed" do not pass as a justification. */
const MIN_REASON_LENGTH = 24

/**
 * ── FACTORY 5 of 5 · SERVICE ROLE · **BYPASSES ROW-LEVEL SECURITY** ─────────
 *
 * WHEN TO USE IT: inside an ADR-governed Supabase Edge Function, for the one
 * operation the ADR names, and nowhere else.
 *
 * FAILURE MODE OF MISUSE: total. Every RLS policy in the repository stops
 * applying to whatever holds this client. A read that should have returned one
 * tenant's rows returns every tenant's; a write that should have been refused
 * succeeds. Nothing errors, nothing logs, and the RLS test suite still passes —
 * because the suite exercises policies, and this client is not subject to them.
 * In a browser or native bundle the key itself is extractable, at which point
 * the breach is not a bug in this repository but a credential in public.
 *
 * It THROWS on a bad warrant or a missing key rather than returning an
 * `ActionOutcome`. The envelope carries DOMAIN failures; this is a deployment
 * that must not start serving. A soft failure here would let an elevated path
 * boot in a degraded state, and "the elevated path silently did nothing" is a
 * worse incident than a crash on the first invocation.
 *
 * @param warrant the merged ADR and the sentence it turns on. Not logged, not
 * sent anywhere: it exists to be written, reviewed, and to sit in the diff.
 */
export function createServiceRoleClient_BYPASSES_RLS(
  warrant: ServiceRoleWarrant,
): SupabaseServiceRoleClient {
  assertWarrant(warrant)
  assertNotClientSide()

  const { secretKey, url } = serviceRoleCredentials()

  // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- @supabase/supabase-js's createClient is untyped by deliberate doctrine (types.ts: no Database generic; rows are re-parsed at the DAL exit). This return is the intentional untyped-client boundary.
  return createClient(url, secretKey, {
    auth: {
      // ALL THREE OFF, and none of them is optional here. This client has no
      // user, so there is no session to refresh and none to persist — and
      // persisting one would write the SERVICE KEY'S OWN credential into shared
      // storage, where the next caller inherits unconstrained database access.
      // That is the single highest-consequence line in this file.
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  })
}

function assertWarrant(warrant: ServiceRoleWarrant): void {
  if (!ADR_PATH.test(warrant.adr)) {
    throw new Error(
      'the service-role client requires a merged ADR path (docs/adr/NNNN-slug.md) — run /adr first; see supabase/functions/README.md',
    )
  }
  if (warrant.reason.trim().length < MIN_REASON_LENGTH) {
    throw new Error(
      'the service-role client requires a written reason naming what row-level security cannot express',
    )
  }
}

/**
 * Refuse to construct in anything that looks like a browser or a bundled app.
 *
 * A last-ditch runtime check, and it is stated as such: by the time this runs,
 * the key would already have had to be present in a client environment, which
 * means the env split has already failed. It is here because the cost is one
 * property lookup and the thing it catches is a published credential.
 *
 * `'document' in globalThis` rather than `typeof window !== 'undefined'`:
 * React Native defines a global `window` (Hermes provides one for compatibility)
 * but no `document`, so the `window` test passes on a device — testing for the
 * wrong global is how this guard would look present and be inert exactly where
 * it matters most.
 */
function assertNotClientSide(): void {
  if ('document' in globalThis) {
    throw new Error(
      'refusing to build a service-role client in a browser or app bundle — its only sanctioned home is an ADR-governed Edge Function',
    )
  }
}
