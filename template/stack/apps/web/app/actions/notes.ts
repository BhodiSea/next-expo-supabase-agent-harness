'use server'

import type { NewNoteInput, NoteView } from '@app/contracts'
import type { ActionOutcome } from '@app/errors'
import { appError, outcomeErr } from '@app/errors'
import { createNote, CreateNoteSchema, type NotesDatabase, type NoteWriteContext } from '@app/notes'
import { revalidatePath } from 'next/cache'
import { actionClient } from '../../lib/safe-action'
import { createRequestScopedClient, getVerifiedUser } from '../../lib/supabase/server'

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
  .inputSchema(CreateNoteSchema)
  .action(async ({ parsedInput }): Promise<ActionOutcome<NoteView>> => {
    // The DAL's create takes THREE arguments — the client, a NoteWriteContext, and the input —
    // because `owner_id` comes from the VERIFIED actor and never from the wire (the contract
    // does not even carry the field). So identity is resolved here, server-side, behind the
    // action's error boundary: getVerifiedUser() authenticates against the auth server
    // (getUser under the hood — never getSession), and an anonymous caller is refused on the
    // data channel rather than left to be caught by the INSERT policy as an opaque RLS denial.
    const user = await getVerifiedUser()
    if (user === null) return outcomeErr(appError.unauthorized())

    // Narrowed to the DAL's structural port via `as unknown as`. This is the sanctioned
    // escape for a vendor client that is too deeply generic to check structurally: supabase-js's
    // `.from()` carries an overload set so large that verifying a full SupabaseServerClient
    // satisfies even the shallow NotesDatabase port sends tsc into TS2589 ("excessively deep").
    // The assertion is SOUND, not a lie — NotesDatabase is a hand-authored SUBSET of exactly the
    // supabase surface the DAL calls (design/W1-STACK-SPEC.md §3), and the runtime value is a
    // real supabase client. RLS is unchanged: the same request-scoped client, viewed through the
    // narrower port. The double-cast (never a single `as NotesDatabase`) is deliberate — it
    // documents that the two types are not directly comparable, which is the whole reason.
    const supabase = (await createRequestScopedClient()) as unknown as NotesDatabase
    // workspaceId is null and events are dropped BY DESIGN on this host: the seed ships no
    // workspace/membership vertical (so there is no seat to resolve — the same null the
    // `me` procedure returns), and apps/web wires no event sink, mirroring createContext's
    // own `dropEvents` default. createNote uses neither for the write itself — it sets
    // owner_id from actorId and takes the database's own created_at — so a null workspace and
    // a no-op sink change nothing about the row that lands, only the event nobody consumes yet.
    const context: NoteWriteContext = {
      actorId: user.id,
      emit: () => undefined,
      now: new Date().toISOString(),
      workspaceId: null,
    }
    const outcome = await createNote(supabase, context, parsedInput)
    // Only on success, and only after the write has actually landed. Invalidating on the
    // failure path would refetch identical data and make a rejected write look like a slow
    // one. RLS decides what the refetch can see; this just says the cached answer is stale.
    if (outcome.ok) revalidatePath('/notes')
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
export async function createNoteAction(input: NewNoteInput): Promise<ActionOutcome<NoteView>> {
  try {
    const result = await runCreateNote(input)
    // `data` is the action's own return — already the ActionOutcome<NoteView> envelope — so it
    // rides back unchanged. The other two arms are next-safe-action's out-of-band channels,
    // and this is where they are folded ONTO the data channel so the caller only ever sees one
    // shape. `outcomeErr`, not `toOutcome`: `toOutcome(fn)` RUNS a thunk and wraps its result,
    // catching a throw — it is not a way to lift an already-built AppError. Lifting is exactly
    // what `outcomeErr(error)` is for.
    if (result.data !== undefined) return result.data
    if (result.validationErrors !== undefined) {
      // The message stays generic ON PURPOSE. Field-level detail belongs to the form, which
      // holds the same zod contract and can validate before submitting; echoing the server's
      // per-field report back through this envelope would define a second error vocabulary
      // for screens to learn. `validation` is the kernel's kind for a contract violation.
      return outcomeErr(
        appError.validation({ message: 'That note is not valid. Check the fields and retry.' }),
      )
    }
    // handleServerError (lib/safe-action.ts) already returns an AppError, so serverError IS one
    // — lift it verbatim rather than re-wrapping and losing its code.
    if (result.serverError !== undefined) return outcomeErr(result.serverError)
    // Unreachable by construction — but "unreachable" is a claim about a dependency, not a
    // fact, and the alternative to a defensive arm here is returning undefined into a
    // signature that promises an outcome.
    return outcomeErr(appError.unknown({ message: 'The note could not be created.' }))
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
