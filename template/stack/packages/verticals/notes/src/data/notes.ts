import type { NoteDeletion, NoteRecord, NotesPage, NoteView } from '@app/contracts'
import { type ActionOutcome, type AppError, outcomeErr, outcomeOk } from '@app/errors'
import { decodeNotesCursor, encodeNotesCursor, type NoteCursor } from '../domain/cursor.js'
import { normalizeTitle, toNoteView } from '../domain/note.js'
import {
  type NoteEventSink,
  type NoteField,
  noteCreated,
  noteDeleted,
  noteUpdated,
} from '../events.js'
import {
  type CreateNoteSchema,
  clampPageLimit,
  type ListNotesSchema,
  type NoteRefSchema,
  type UpdateNoteSchema,
} from '../schemas.js'
import {
  contractDrift,
  emptyPatch,
  invalidCursor,
  mapPostgrestFailure,
  missingNote,
  type NoteOperation,
  unreadableWrite,
} from './errors.js'
import type { NotesDatabase, PostgrestOutcome } from './port.js'
import { asRowArray, NOTE_COLUMNS, NOTES_TABLE, toNoteRecord } from './rows.js'

// ---------------------------------------------------------------------------
// The notes DAL.
//
// Three laws, all visible in every function below:
//
//   1. It takes a client, it never makes one. The client handed in is the
//      per-request, RLS-scoped one; a DAL that could reach for a service-role
//      client would make every caller a privilege decision.
//   2. It returns DTOs, never rows. `toNoteRecord` is the only door out of the
//      driver's world (rows.ts), and `toNoteView` is the only door into the
//      surfaces' world (domain/note.ts).
//   3. It returns outcomes, never throws for a domain failure. Callers get a
//      value they can switch on; the transport layer stays uniform.
//
// And one distinction that is load-bearing, which the org re-scope makes subtle
// enough to be worth spelling out — because the wrong reading of it is how a
// tenant boundary quietly becomes decorative.
//
// EVERY FUNCTION HERE FILTERS BY `org_id`. NO FUNCTION HERE FILTERS BY
// `owner_id`. Those look like the same kind of statement and are opposites.
//
//   `org_id` is a SELECTOR. Its value originates at the client (the `x-org-id`
//   header), is resolved server-side against the caller's real memberships
//   before it reaches this file, and can only ever NARROW the set the policies
//   already admit — a user in three orgs is looking at one of them. Remove the
//   filter and nothing becomes visible that was not visible before; the user
//   simply sees three orgs' notes at once. It is a product decision, enforced
//   where product decisions belong.
//
//   `owner_id` would be an AUTHORIZATION DERIVATION. Its value would come from
//   the verified identity, and it would restate — in TypeScript — exactly what
//   the RLS policy already says in SQL. That is the dangerous shape: with it in
//   place, the day a policy is dropped or widened, every test still passes, the
//   isolation suite still passes, and the only thing between two tenants is a
//   WHERE clause nobody remembered was load-bearing. The application must not be
//   able to compensate for a broken policy, because a compensation that works is
//   indistinguishable from a boundary that works.
//
// The test: could this filter be deleted and the database still refuse? For
// `org_id`, no — and it does not need to, because the policies already refuse
// the rows it is not narrowing. For `owner_id`, yes — which is exactly why it is
// absent.
// ---------------------------------------------------------------------------

/**
 * The acting organization, resolved from the caller's real seats. Non-nullable
 * by construction: the rung above (`orgProcedure` / `requireOrgContext`) turns
 * "no active org" into a returned outcome, so by the time a call reaches this
 * file the question has already been answered. A nullable field here would push
 * that decision into five call sites that would each answer it differently.
 */
export interface NoteScope {
  readonly orgId: string
}

/**
 * What a write needs beyond its input.
 *
 * `now` is an ISO-8601 UTC instant minted ONCE per request by the caller. It
 * exists because a PostgREST request body is literal JSON: there is no `now()`
 * to send, so the archive timestamp has to arrive as a value. Creation does NOT
 * use it — the `created_at` column default keeps the database's own clock,
 * which is authoritative. The asymmetry is deliberate and stated here so nobody
 * "fixes" one path to match the other.
 *
 * `actorId` remains ATTRIBUTION, not authorization, and the org re-scope is what
 * made that literal: `notes.owner_id` is now nullable and `ON DELETE SET NULL`,
 * because in B2B the data controller is the org — an employee leaving must not
 * delete the company's rows. It still comes from the verified actor and never
 * from the wire.
 */
export interface NoteWriteContext extends NoteScope {
  readonly actorId: string
  readonly emit: NoteEventSink
  readonly now: string
}

/**
 * The TIE-BREAK half of the keyset seek. It is deliberately not the whole
 * predicate, and the split is the single most load-bearing thing in this file.
 *
 * The obvious spelling — one disjunction covering both lexicographic cases,
 * `created_at.lt.X, and(created_at.eq.X, id.lt.Y)` — is correct, portable, and
 * quietly O(page number). PostgreSQL cannot turn a top-level OR into an index
 * range, so the whole thing lands in `Filter:` and the scan still starts at the
 * tenant's newest row. Measured against 1.1M seeded rows, page 1000:
 *
 *   one disjunction     Index Cond: (org_id = $1)
 *                       Rows Removed by Filter: 1115     39 buffers
 *   range + disjunction Index Cond: (org_id = $1 AND created_at <= $2)
 *                       Rows Removed by Filter: 3         6 buffers
 *
 * The first form re-reads and discards every row it has already shown — which
 * is exactly the OFFSET cost this function's name says it avoids, wearing a
 * keyset costume. Nothing about it looks wrong; it is fast on a seeded test
 * database and gets slower with every page a real customer scrolls.
 *
 * So the seek is written as TWO predicates, and `listNotes` sends both:
 *
 *   created_at <= X            an indexable range that positions the scan
 *   AND (created_at < X OR id < Y)   the tie-break, evaluated on the few rows
 *                                    the range could not already exclude
 *
 * which is exactly equivalent to `(created_at, id) < (X, Y)`: a row with
 * `created_at < X` satisfies the disjunction by its first arm whatever its id,
 * and a row at the cursor's instant survives only if its id sorts below the
 * cursor's. The row-constructor form PostgreSQL would prefer is not reachable
 * from here — PostgREST's filter grammar has no row comparison — so this is the
 * closest expressible thing, and `tools/check-query-shapes.mjs` reds a keyset
 * seek that carries no range predicate on its leading sort column.
 * SOURCE: https://use-the-index-luke.com/no-offset
 *
 * The interpolated values are safe for a reason that has to stay true:
 * `decodeNotesCursor` has already parsed both against anchored schemas (a
 * calendar-valid timestamp and a uuid), so neither can contain the `,`, `.`,
 * `(`, `)` or `"` that would break out of this filter grammar. They are quoted
 * as well, because defence that depends on an upstream invariant should not
 * depend on it ALONE.
 * SOURCE: https://docs.postgrest.org/en/v12/references/api/tables_views.html#logical-operators
 */
function keysetTieBreak(cursor: NoteCursor): string {
  return `created_at.lt."${cursor.createdAt}",id.lt."${cursor.id}"`
}

/**
 * One page of notes, newest first.
 *
 * A sentinel row (limit + 1) is fetched as the has-more probe: cheaper than a
 * COUNT, and exact. The extra row is dropped before the page is built.
 */
export async function listNotes(
  db: NotesDatabase,
  scope: NoteScope,
  query: ListNotesSchema,
): Promise<ActionOutcome<NotesPage>> {
  const limit = clampPageLimit(query.limit)

  let cursor: NoteCursor | null = null
  if (query.cursor !== undefined) {
    cursor = decodeNotesCursor(query.cursor)
    if (cursor === null) return outcomeErr(invalidCursor())
  }

  // org_id FIRST, before the archive predicate and the keyset seek, because it
  // is the leading column of notes_org_id_created_at_id_idx — the index that
  // serves the policy, the sort and the cursor range in one pass. PostgREST
  // sends filters in call order and the planner is free to reorder them, but the
  // ordering here matches the index so the intended plan is the readable one.
  let builder = db.from(NOTES_TABLE).select(NOTE_COLUMNS).eq('org_id', scope.orgId)
  // Archived notes are excluded by default: the list is a working surface, and
  // an archive that keeps showing up is not an archive.
  if (!query.includeArchived) builder = builder.is('archived_at', null)
  // The range FIRST: it is the half the planner can push into the Index Cond, and
  // sending it separately from the tie-break is what keeps the seek O(1) per page
  // rather than O(page number). See keysetTieBreak.
  if (cursor !== null) {
    builder = builder.lte('created_at', cursor.createdAt).or(keysetTieBreak(cursor))
  }

  const result = await builder
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1)

  // `error` FIRST, always: PostgREST resolves rather than rejects, so reading
  // `data` before `error` renders an RLS denial as an empty list.
  if (result.error !== null) return outcomeErr(mapPostgrestFailure(result.error, 'list'))

  let records: NoteRecord[]
  try {
    records = asRowArray(result.data).map(toNoteRecord)
  } catch {
    return outcomeErr(contractDrift('list'))
  }

  const items = records.slice(0, limit)
  const last = items.at(-1)
  const nextCursor =
    records.length > limit && last !== undefined
      ? encodeNotesCursor({ createdAt: last.createdAt, id: last.id })
      : null

  return outcomeOk({ items: items.map(toNoteView), nextCursor })
}

/**
 * A single note, or `notFound`.
 *
 * There is no `forbidden` branch here BY DESIGN. RLS filters SELECT rather than
 * failing it, so "you may not see this" and "this does not exist" arrive as the
 * same empty result — and reporting them differently would turn every uuid into
 * an existence oracle. See errors.ts.
 */
export async function getNote(
  db: NotesDatabase,
  scope: NoteScope,
  ref: NoteRefSchema,
): Promise<ActionOutcome<NoteView>> {
  const result = await db
    .from(NOTES_TABLE)
    .select(NOTE_COLUMNS)
    .eq('org_id', scope.orgId)
    .eq('id', ref.id)
    .limit(1)
  if (result.error !== null) return outcomeErr(mapPostgrestFailure(result.error, 'read'))

  const row = asRowArray(result.data)[0]
  if (row === undefined) return outcomeErr(missingNote())

  try {
    return outcomeOk(toNoteView(toNoteRecord(row)))
  } catch {
    return outcomeErr(contractDrift('read'))
  }
}

/**
 * Create.
 *
 * `owner_id` comes from the verified actor on the context and NEVER from the
 * input — the contract does not even carry the field. The INSERT policy then
 * re-checks it against `auth.uid()`, so an application bug here is caught by
 * the database rather than silently writing a row into someone else's account.
 */
/**
 * The tail every write path shares: driver outcome → one row → a `NoteRecord`.
 *
 * All three writers (`createNote`, `updateNote`, `deleteNote`) issue a different statement
 * and emit a different event, but the four steps BETWEEN those two ends are identical and
 * order-critical:
 *
 *   1. branch on `error` FIRST — PostgREST never rejects the promise, so reading `data`
 *      without checking `error` is how an RLS denial renders as "nothing happened";
 *   2. take the first row through `asRowArray`, which tolerates a non-array `data`;
 *   3. no row is a DOMAIN answer, and which one differs per operation — hence `onEmpty`;
 *   4. `toNoteRecord` is the only door out of the driver's world, and it THROWS on a row
 *      that no longer matches the contract, which is drift rather than a user error.
 *
 * `onEmpty` is a parameter rather than a branch on `operation` because the two answers are
 * not variants of one rule. A create that returns no row means the RETURNING projection was
 * filtered by a SELECT policy — the row exists and the caller may not read it back, a policy
 * misconfiguration (`unreadableWrite`). An update or delete that returns no row means the
 * row is gone or the USING clause filtered it, which is indistinguishable on purpose and is
 * an ordinary `missingNote`. Collapsing them would report a misconfigured policy as a 404.
 * SOURCE: packages/verticals/notes/src/data/port.ts (PostgREST returns `{data, error}` and
 * never rejects — branch on `error` first, every time)
 */
function materializeWrittenRow(
  result: PostgrestOutcome,
  operation: NoteOperation,
  onEmpty: () => AppError,
): ActionOutcome<NoteRecord> {
  if (result.error !== null) return outcomeErr(mapPostgrestFailure(result.error, operation))

  const row = asRowArray(result.data)[0]
  if (row === undefined) return outcomeErr(onEmpty())

  try {
    return outcomeOk(toNoteRecord(row))
  } catch {
    return outcomeErr(contractDrift(operation))
  }
}

export async function createNote(
  db: NotesDatabase,
  context: NoteWriteContext,
  input: CreateNoteSchema,
): Promise<ActionOutcome<NoteView>> {
  const result = await db
    .from(NOTES_TABLE)
    .insert({
      // The column default ('') stands in for an omitted body — mirrored here
      // rather than left to the database so the returned row is the same shape
      // whichever path inserted it.
      body: input.body ?? '',
      // The tenant key, from the RESOLVED acting org — never from `input`, which
      // carries no org field and never will (see @app/contracts ORG_ID_HEADER).
      // The INSERT policy re-checks it against the caller's real memberships, so
      // a bug here is a 42501 from the database, not a row in someone else's org.
      org_id: context.orgId,
      // Attribution. Nullable and ON DELETE SET NULL since the org re-scope, so
      // it is stated explicitly rather than left to a column default that no
      // longer exists.
      owner_id: context.actorId,
      title: normalizeTitle(input.title),
    })
    .select(NOTE_COLUMNS)
    .limit(1)

  // `unreadableWrite` rather than `missingNote`: an INSERT that reports no error and
  // returns no row means the RETURNING projection was filtered by a SELECT policy — the
  // row exists but the caller may not read it back, which is a policy misconfiguration.
  const written = materializeWrittenRow(result, 'create', unreadableWrite)
  if (!written.ok) return written
  const record = written.data

  // The event carries the DATABASE's timestamp, not the request's: event order
  // and row order then agree by construction.
  context.emit(noteCreated(context, record.id, record.createdAt))
  return outcomeOk(toNoteView(record))
}

/**
 * Partial update. Only the fields present in the patch are sent, so two
 * concurrent edits to different fields do not clobber each other.
 */
export async function updateNote(
  db: NotesDatabase,
  context: NoteWriteContext,
  input: UpdateNoteSchema,
): Promise<ActionOutcome<NoteView>> {
  const patch: Record<string, unknown> = { updated_at: context.now }
  const fields: NoteField[] = []

  if (input.title !== undefined) {
    patch['title'] = normalizeTitle(input.title)
    fields.push('title')
  }
  if (input.body !== undefined) {
    patch['body'] = input.body
    fields.push('body')
  }
  if (input.isArchived !== undefined) {
    patch['archived_at'] = input.isArchived ? context.now : null
    fields.push('isArchived')
  }

  // Unreachable through the contract (`NoteUpdateInput` refuses an empty
  // patch), reachable from a script that skipped it.
  if (fields.length === 0) return outcomeErr(emptyPatch())

  const result = await db
    .from(NOTES_TABLE)
    .update(patch)
    .eq('org_id', context.orgId)
    .eq('id', input.id)
    .select(NOTE_COLUMNS)
    .limit(1)

  // No row updated: either it is gone or the UPDATE policy's USING clause filtered it out.
  // Same answer for both, deliberately — see getNote.
  const written = materializeWrittenRow(result, 'update', missingNote)
  if (!written.ok) return written
  const record = written.data

  context.emit(noteUpdated(context, record.id, record.updatedAt, [...fields]))
  return outcomeOk(toNoteView(record))
}

/**
 * Hard delete, returning the removed row so the event can carry the database's
 * own timestamp — a delete has no surviving row to read one from afterwards.
 */
export async function deleteNote(
  db: NotesDatabase,
  context: NoteWriteContext,
  ref: NoteRefSchema,
): Promise<ActionOutcome<NoteDeletion>> {
  const result = await db
    .from(NOTES_TABLE)
    .delete()
    .eq('org_id', context.orgId)
    .eq('id', ref.id)
    .select(NOTE_COLUMNS)
    .limit(1)

  const written = materializeWrittenRow(result, 'delete', missingNote)
  if (!written.ok) return written
  const record = written.data

  context.emit(noteDeleted(context, record.id, record.updatedAt))
  return outcomeOk({ id: record.id })
}
