import type { NoteDeletion, NoteRecord, NotesPage, NoteView } from '@app/contracts'
import { type ActionOutcome, outcomeErr, outcomeOk } from '@app/errors'
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
  unreadableWrite,
} from './errors.js'
import type { NotesDatabase } from './port.js'
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
// And one absence that is load-bearing: no function here adds an `owner_id`
// filter. Visibility is the RLS policies' job, enforced by the database against
// `auth.uid()`. Filtering in the application too would MASK a policy
// regression — the tests would pass, the isolation suite would pass, and the
// day a policy is dropped the only thing standing between two tenants would be
// a WHERE clause nobody remembered was load-bearing.
// ---------------------------------------------------------------------------

/**
 * What a write needs beyond its input.
 *
 * `now` is an ISO-8601 UTC instant minted ONCE per request by the caller. It
 * exists because a PostgREST request body is literal JSON: there is no `now()`
 * to send, so the archive timestamp has to arrive as a value. Creation does NOT
 * use it — the `created_at` column default keeps the database's own clock,
 * which is authoritative. The asymmetry is deliberate and stated here so nobody
 * "fixes" one path to match the other.
 */
export interface NoteWriteContext {
  readonly actorId: string
  readonly emit: NoteEventSink
  readonly now: string
  readonly workspaceId: string | null
}

/**
 * Keyset seek for `ORDER BY created_at DESC, id DESC`: everything strictly
 * after the cursor position, expressed as PostgREST's `or(...)` of the two
 * lexicographic cases. Never OFFSET — an offset scan re-reads and re-discards
 * every skipped row.
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
function keysetFilter(cursor: NoteCursor): string {
  const at = `"${cursor.createdAt}"`
  return `created_at.lt.${at},and(created_at.eq.${at},id.lt."${cursor.id}")`
}

/**
 * One page of notes, newest first.
 *
 * A sentinel row (limit + 1) is fetched as the has-more probe: cheaper than a
 * COUNT, and exact. The extra row is dropped before the page is built.
 */
export async function listNotes(
  db: NotesDatabase,
  query: ListNotesSchema,
): Promise<ActionOutcome<NotesPage>> {
  const limit = clampPageLimit(query.limit)

  let cursor: NoteCursor | null = null
  if (query.cursor !== undefined) {
    cursor = decodeNotesCursor(query.cursor)
    if (cursor === null) return outcomeErr(invalidCursor())
  }

  let builder = db.from(NOTES_TABLE).select(NOTE_COLUMNS)
  // Archived notes are excluded by default: the list is a working surface, and
  // an archive that keeps showing up is not an archive.
  if (!query.includeArchived) builder = builder.is('archived_at', null)
  if (cursor !== null) builder = builder.or(keysetFilter(cursor))

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
  ref: NoteRefSchema,
): Promise<ActionOutcome<NoteView>> {
  const result = await db.from(NOTES_TABLE).select(NOTE_COLUMNS).eq('id', ref.id).limit(1)
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
      owner_id: context.actorId,
      title: normalizeTitle(input.title),
    })
    .select(NOTE_COLUMNS)
    .limit(1)

  if (result.error !== null) return outcomeErr(mapPostgrestFailure(result.error, 'create'))

  const row = asRowArray(result.data)[0]
  // An INSERT that reports no error and returns no row means the RETURNING
  // projection was filtered by a SELECT policy — the row exists but the caller
  // may not read it back. That is a policy misconfiguration, not a user error.
  if (row === undefined) return outcomeErr(unreadableWrite())

  let record: NoteRecord
  try {
    record = toNoteRecord(row)
  } catch {
    return outcomeErr(contractDrift('create'))
  }

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
    .eq('id', input.id)
    .select(NOTE_COLUMNS)
    .limit(1)

  if (result.error !== null) return outcomeErr(mapPostgrestFailure(result.error, 'update'))

  const row = asRowArray(result.data)[0]
  // No row updated: either it is gone or the UPDATE policy's USING clause
  // filtered it out. Same answer for both — see getNote.
  if (row === undefined) return outcomeErr(missingNote())

  let record: NoteRecord
  try {
    record = toNoteRecord(row)
  } catch {
    return outcomeErr(contractDrift('update'))
  }

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
  const result = await db.from(NOTES_TABLE).delete().eq('id', ref.id).select(NOTE_COLUMNS).limit(1)

  if (result.error !== null) return outcomeErr(mapPostgrestFailure(result.error, 'delete'))

  const row = asRowArray(result.data)[0]
  if (row === undefined) return outcomeErr(missingNote())

  let record: NoteRecord
  try {
    record = toNoteRecord(row)
  } catch {
    return outcomeErr(contractDrift('delete'))
  }

  context.emit(noteDeleted(context, record.id, record.updatedAt))
  return outcomeOk({ id: record.id })
}
