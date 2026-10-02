'use server'

import { type NewNoteInput, type NoteView, OrgSlug } from '@app/contracts'
import type { ActionOutcome } from '@app/errors'
import { appError, outcomeErr } from '@app/errors'
import { CreateNoteSchema, createNote, type NotesDatabase, type NoteWriteContext } from '@app/notes'
import { revalidatePath } from 'next/cache'
import { foldActionResult } from '../../lib/action-outcome'
import { requireOrgContext } from '../../lib/auth/session'
import { enforceActionRateLimit } from '../../lib/rate-limit-runtime'
import { actionClient } from '../../lib/safe-action'

// The web write path. Its twin is the `notes.create` tRPC procedure that apps/mobile calls,
// and the two share EVERYTHING that matters: the same zod contract, the same @app/notes
// implementation, the same ActionOutcome envelope. What differs is only the transport — a
// Server Action for the surface that renders in the same process, an HTTP procedure for the
// surface that does not. Two callers, one operation. The moment a rule lives in only one of
// them ("web trims the title but mobile doesn't") the two surfaces have quietly become two
// products.
//
// 'use server' marks this whole module: every export becomes a POST endpoint with a
// generated id, callable by anyone who can read the client bundle. That is the correct
// mental model for everything below — treat each exported function as a public API, not as
// an internal helper that happens to run on the server.

// The validated core. actionClient.inputSchema parses the untrusted payload against the
// shared contract BEFORE any of it reaches domain code, and actionClient's error boundary
// redacts anything the implementation throws (see lib/safe-action.ts). The schema is
// @app/notes' `CreateNoteSchema` — the SAME one `notes.create` validates over tRPC (it adds
// the renderable-title refinement to the wire contract's `NewNoteInput`), so the two callers
// enforce one rule set. Not exported: a 'use server' module may only export async functions,
// and this is the private half.
const runCreateNote = actionClient
  // The org selector, parsed as strictly as any wire input — anchored shape, bounded
  // length — BEFORE it reaches the seat lookup. A bind arg is still untrusted input; the
  // only thing binding buys is that it cannot be confused with the note's own fields.
  .bindArgsSchemas<[orgSlug: typeof OrgSlug]>([OrgSlug])
  .inputSchema(CreateNoteSchema)
  .action(async ({ parsedInput, bindArgsParsedInputs }): Promise<ActionOutcome<NoteView>> => {
    // THE ORG IS A BOUND ARGUMENT, NOT A PAYLOAD FIELD, and the distinction is the whole
    // point of this line. `CreateNoteSchema` carries no org and never will: a tenant a
    // request can NAME in its body is a tenant the first careless handler will TRUST. What
    // arrives here is a route-derived SLUG — the segment of `/o/[orgSlug]/notes` the form was
    // rendered under — which requireOrgContext looks up in the caller's real seats. The id
    // that reaches the INSERT is the LOOKED-UP org's, never the caller's string, so a forged
    // slug resolves to nothing rather than to somebody else's org.
    //
    // It is a bind arg rather than a second parameter because next-safe-action validates
    // bound arguments with their own schema too — the slug is parsed against
    // `OrgSlugSchema` before this body runs, so a hostile value cannot reach the lookup as
    // an unbounded string.
    const [orgSlug] = bindArgsParsedInputs

    // Identity AND scope in one call, server-side, behind the action's error boundary.
    // getVerifiedUser is inside it (authenticating against the auth server — never
    // getSession), so an anonymous caller is refused on the DATA channel rather than left to
    // be caught by the INSERT policy as an opaque RLS denial, and a caller with no seat in
    // this org gets `org_context_required` rather than a silent empty write.
    const gate = await requireOrgContext(orgSlug)
    if (!gate.ok) return gate

    // Narrowed to the DAL's structural port via `as unknown as`. This is the sanctioned
    // escape for a vendor client that is too deeply generic to check structurally: supabase-js's
    // `.from()` carries an overload set so large that verifying a full SupabaseServerClient
    // satisfies even the shallow NotesDatabase port sends tsc into TS2589 ("excessively deep").
    // The assertion is SOUND, not a lie — NotesDatabase is a hand-authored SUBSET of exactly the
    // supabase surface the DAL calls (design/W1-STACK-SPEC.md §3), and the runtime value is a
    // real supabase client. RLS is unchanged: the same request-scoped client, viewed through the
    // narrower port. The double-cast (never a single `as NotesDatabase`) is deliberate — it
    // documents that the two types are not directly comparable, which is the whole reason.
    const supabase = gate.data.client as unknown as NotesDatabase
    // `orgId` is the RESOLVED org's id; `actorId` is the VERIFIED user's. Neither is reachable
    // from `parsedInput`, which is what makes this function's scope a server fact rather than a
    // request assertion. apps/web wires no event sink, so events are dropped here exactly as
    // createContext's own `dropEvents` default does.
    const context: NoteWriteContext = {
      actorId: gate.data.userId,
      emit: () => undefined,
      now: new Date().toISOString(),
      orgId: gate.data.org.id,
    }
    const outcome = await createNote(supabase, context, parsedInput)
    // Only on success, and only after the write has actually landed. Invalidating on the
    // failure path would refetch identical data and make a rejected write look like a slow
    // one. RLS decides what the refetch can see; this just says the cached answer is stale.
    // The path is the ORG's, so one tenant's write never invalidates another's cache entry.
    if (outcome.ok) revalidatePath(`/o/${gate.data.org.slug}/notes`)
    return outcome
  })

/**
 * Create a note. Returns the SAME envelope shape as `notes.create` over tRPC, so a caller
 * that already knows how to read one knows how to read the other.
 *
 * The fold below is the price of that promise. next-safe-action reports three distinct
 * outcomes — parsed-and-ran, failed-validation, threw — through three optional fields, and a
 * caller left to inspect them itself would re-derive this mapping (differently) at every call
 * site. Collapsing them here means the public signature is honest: one Promise, one union,
 * no framework types leaking into the UI layer.
 */
export async function createNoteAction(
  orgSlug: string,
  input: NewNoteInput,
): Promise<ActionOutcome<NoteView>> {
  // The rate-limit seam. FIRST, before any work and before the identity round trip: an
  // unauthenticated flood at a Server Action id is the flood worth stopping, and a limit
  // applied after `getUser()` still pays an auth call per abusive request.
  const limited = await enforceActionRateLimit('createNoteAction')
  if (limited !== null) return limited
  try {
    // The three next-safe-action channels folded onto the data channel, so the caller only
    // ever sees one shape. The fold itself — including WHY the validation copy stays generic
    // and why `serverError` is lifted rather than re-wrapped — lives in lib/action-outcome.ts,
    // which is a pure function the web unit lane measures; only the two sentences are ours.
    return foldActionResult(await runCreateNote(orgSlug, input), {
      invalid: 'That note is not valid. Check the fields and retry.',
      failed: 'The note could not be created.',
    })
  } catch {
    // Nothing inside runCreateNote should escape (that is what the action client is for), so
    // reaching this catch means the failure happened around it — building the request-scoped
    // client, an unparsed env, a transport fault. Normalizing it to `unknown` keeps the
    // promise this function makes: callers switch on an outcome, they never write a try/catch.
    // The cause is deliberately not forwarded — a driver string on the wire is a leak with no
    // reader; observability owns the cause.
    return outcomeErr(appError.unknown())
  }
}
