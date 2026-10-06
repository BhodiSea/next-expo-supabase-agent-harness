import type { NotesDatabase } from '@app/notes'
import type { SupabaseServerClient } from '@app/supabase'

// The ONE place apps/web narrows a Supabase client to @app/notes' structural port. The Server
// Action (app/actions/notes.ts), the read seam (lib/app-data/notes.ts) and the tRPC route
// (app/api/trpc/[trpc]/route.ts) each call it, rather than each carrying a cast and its own
// copy of the reason.
//
// The reason, once. Checking a full SupabaseServerClient against the shallow NotesDatabase port
// instantiates supabase-js's vast `.from()` overload set and sends tsc into TS2589 ("excessively
// deep"). The assertion is SOUND, not a lie: NotesDatabase is a hand-authored SUBSET of exactly
// the supabase surface the DAL calls (design/W1-STACK-SPEC.md §3), and the runtime value is a
// real supabase client. RLS is unchanged: the same request-scoped (or bearer-scoped) client,
// viewed through the narrower port. The double-cast, never a single `as NotesDatabase`, is
// deliberate: it says the two types are not directly comparable, which is the whole reason.
// SOURCE: packages/verticals/notes/src/data/port.ts (why the DAL takes a structural port)

/** The caller's client, seen as the port @app/notes' DAL is written against. */
export function toNotesPort(client: SupabaseServerClient): NotesDatabase {
  // On a const, never in the return position: in a contextually typed slot
  // no-unnecessary-type-assertion reads the assertion as redundant, because it does not see the
  // deep check that makes it load-bearing.
  const port = client as unknown as NotesDatabase
  return port
}
