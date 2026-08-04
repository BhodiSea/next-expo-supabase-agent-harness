import { ListNotesSchema, listNotes, type NotesDatabase } from '@app/notes'
import { requireOrgContext } from '../auth/session'
import type { NotesPageModel } from './notes-model'
import { toNotesPageModel } from './notes-model'

// The RSC read seam. The whole chain, in one place and in this order:
//
//   per-request Supabase client  ->  @app/notes barrel  ->  match the outcome  ->  *View
//   (lib/supabase/server.ts)         (the vertical)         (notes-model.ts)      (the page)
//
// Read it as a set of prohibitions, because that is what earns it a module of its own:
//
//   * A Server Component NEVER queries Supabase directly. The table access, the column
//     selection and the ordering belong to @app/notes, which is the one implementation the
//     tRPC procedure and the Server Action also call. One operation, three callers — the
//     alternative is three subtly different `select()` chains that drift the moment the
//     schema does.
//   * The barrel NEVER constructs its own client. It receives a request-scoped one, which is
//     what keeps the vertical package free of next/* and free of ambient identity, and what
//     makes it reusable from the mobile-facing bearer path unchanged.
//   * No fetch() and no HTTP hop. This runs in the same process as the API, so a Server
//     Component calling its own /api/trpc endpoint over the network would be pure latency
//     plus a second copy of the auth story. The mobile client crosses the network because it
//     must; web does not.
//
// Caching is deliberately absent: no `cache()`, no `revalidate`, no `use cache`. Every read
// here is RLS-scoped to the calling user, and a cache keyed on anything less specific than
// the verified identity is a cross-tenant data leak wearing a performance costume. Add
// caching per query, with the identity in the key, or not at all.
// SOURCE: docs/harness/README.md (one implementation per operation; RLS-scoped reads are
// never cached on a shared key) docs/security/sandbox-and-supply-chain.md

/**
 * Load one org's notes page for the CURRENT request's user.
 *
 * `orgSlug` comes from the route segment (`/o/[orgSlug]/notes`) and is resolved against the
 * caller's REAL seats by requireOrgContext — so a slug naming somebody else's org yields the
 * org-context error, never that org's rows. This is the same rule the tRPC path applies to
 * the `x-org-id` header; the spelling differs because a Server Component has a route and a
 * mobile request has a header.
 *
 * Domain failures come back inside the model (`status: 'error' | 'missing'`). An
 * infrastructure throw — Supabase unreachable, the env unparsed — is deliberately NOT caught
 * here: it belongs to the route family's error.tsx boundary, which can offer a retry. A
 * try/catch at this level would flatten "the database is down" into the same grey box as "you
 * do not have access to this note", and the two need different words and different actions.
 */
export async function loadNotesPage(orgSlug: string): Promise<NotesPageModel> {
  const gate = await requireOrgContext(orgSlug)
  // The gate's failure IS a domain outcome, so it rides the same model the DAL's failures do.
  // A signed-out or seatless caller therefore renders the page's error state rather than
  // throwing into error.tsx — the layout above has already decided whether to redirect.
  if (!gate.ok) return toNotesPageModel(gate)

  // `as unknown as NotesDatabase`: the DAL's port is a deliberate hand-authored subset of
  // supabase-js's surface (design/W1-STACK-SPEC.md §3), and checking a full
  // SupabaseServerClient against it instantiates supabase-js's vast `.from()` overload set —
  // TS2589. The assertion is sound (the runtime value IS a supabase client) and matches the
  // Server Action and the tRPC route, which narrow the identical way.
  const supabase = gate.data.client as unknown as NotesDatabase
  // The FIRST page, newest first: no cursor. Parsing an empty object rather than hand-writing
  // `{ includeArchived: false, limit: 50 }` keeps the contract the single source of the page
  // size and the archived-default — `listNotes` requires a parsed `ListNotesSchema`, not a
  // bare client, and the two defaults live in @app/contracts where the mobile list reads them
  // too. A later paginated screen threads `nextCursor` (now carried on the ready model) back
  // in here as `{ cursor }`.
  const query = ListNotesSchema.parse({})
  // The scope is the RESOLVED org's id — never the slug the caller supplied.
  return toNotesPageModel(await listNotes(supabase, { orgId: gate.data.org.id }, query))
}
