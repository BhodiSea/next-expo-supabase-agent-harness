// ---------------------------------------------------------------------------
// The database port the DAL is written against.
//
// This is deliberately a STRUCTURAL description of the PostgREST query builder
// that @app/supabase's client factories hand out — not an import of their
// concrete client type. Three reasons, in order of weight:
//
//   1. `data` is typed `unknown`. A generated `Database` type would make the
//      rows look trustworthy at the DAL's ENTRANCE, which is exactly the
//      illusion the DAL law exists to prevent: the row shape is decided by
//      whatever migration is actually deployed, not by the checked-in types, so
//      it is re-parsed against the contract at the exit (see rows.ts) and the
//      compiler is given nothing to short-circuit that with.
//   2. It is fake-able in three lines, so every branch of the DAL — including
//      the RLS-denial and malformed-row branches, which no live database will
//      produce on demand — is reachable from a unit test with no container, no
//      network, and no fixture reset.
//   3. It keeps this file free of `@supabase/*` types, which keeps the ./client
//      barrel free of them too.
//
// The client passed in is ALWAYS a per-request, RLS-scoped client minted by
// @app/supabase. The DAL never constructs one and never reaches for a
// service-role client: a DAL that can choose its own privilege level is a DAL
// where every future caller has to be audited for which one it picked.
// ---------------------------------------------------------------------------

/**
 * The failure half of a PostgREST response. Every field except `message` is
 * optional so that both PostgREST's own error shape and the transport-level
 * errors the client synthesises are assignable without a cast.
 */
export interface PostgrestFailure {
  readonly code?: string | undefined
  readonly details?: string | null | undefined
  readonly hint?: string | null | undefined
  readonly message: string
}

/**
 * PostgREST returns `{ data, error }` and NEVER rejects the promise for a
 * database-level failure. Reading only `data` is therefore how an RLS denial
 * gets silently rendered as an empty list — the DAL must branch on `error`
 * first, every time.
 */
export interface PostgrestOutcome {
  readonly data: unknown
  readonly error: PostgrestFailure | null
}

/**
 * A chainable, awaitable query. Only the operators this vertical actually uses
 * are declared: a port that mirrors the whole builder is a port that has to be
 * maintained in lockstep with a dependency it exists to decouple from.
 */
export interface PostgrestQuery extends PromiseLike<PostgrestOutcome> {
  eq(column: string, value: string): PostgrestQuery
  is(column: string, value: null): PostgrestQuery
  limit(count: number): PostgrestQuery
  or(filters: string): PostgrestQuery
  order(column: string, options: { readonly ascending: boolean }): PostgrestQuery
  select(columns: string): PostgrestQuery
}

export interface PostgrestTable {
  delete(): PostgrestQuery
  insert(values: Readonly<Record<string, unknown>>): PostgrestQuery
  select(columns: string): PostgrestQuery
  update(values: Readonly<Record<string, unknown>>): PostgrestQuery
}

/** The one method the DAL needs from a Supabase client. */
export interface NotesDatabase {
  from(table: string): PostgrestTable
}
