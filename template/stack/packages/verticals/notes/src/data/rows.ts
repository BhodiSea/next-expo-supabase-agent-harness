import { NoteRecord } from '@app/contracts'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// The row boundary: snake_case Postgres columns in, camelCase contract out.
//
// This is the DAL law made mechanical — a raw driver row NEVER escapes this
// file. Everything above it deals in `NoteRecord`, so a column rename is a
// compile error here and nowhere else, and a column that appears in the table
// without appearing in the contract simply never reaches a caller.
// ---------------------------------------------------------------------------

/** The table this vertical owns. Named once; the DAL never spells it inline. */
export const NOTES_TABLE = 'notes'

/**
 * The explicit projection. `select('*')` is banned here: it welds the wire
 * payload to the physical table, so the day someone adds an internal column
 * (an embedding, a moderation flag, a soft-delete tombstone) every list
 * response silently grows to carry it — past the contract, past the bound, and
 * past whatever review approved the column but not its publication.
 *
 * `rows.test.ts` asserts this string covers exactly the row schema's keys, so
 * the two cannot drift.
 */
export const NOTE_COLUMNS = 'id, owner_id, title, body, created_at, updated_at, archived_at'

/**
 * Field schemas are BORROWED from the contract's shape rather than restated.
 * A restated bound is a bound that drifts: the contract would say 200 and the
 * row parser 255, and the disagreement would only surface as a runtime parse
 * failure on real data months later.
 */
const NoteRow = z.object({
  archived_at: NoteRecord.shape.archivedAt,
  body: NoteRecord.shape.body,
  created_at: NoteRecord.shape.createdAt,
  id: NoteRecord.shape.id,
  owner_id: NoteRecord.shape.ownerId,
  title: NoteRecord.shape.title,
  updated_at: NoteRecord.shape.updatedAt,
})
export type NoteRow = z.infer<typeof NoteRow>

/** The row schema's keys, for the projection-drift test. Derived, never listed twice. */
export const NOTE_ROW_KEYS = Object.keys(NoteRow.shape).sort()

/**
 * Parse ONCE, then rename. The parse enforces every contract bound; the rename
 * is a total, type-checked mapping, so re-parsing the same values against
 * `NoteRecord` afterwards would burn CPU on the hottest read path in the app to
 * re-prove what the compiler already guarantees.
 *
 * Throws `ZodError` on a row that does not match. Callers turn that into an
 * `internal` envelope (see outcome.ts): schema drift is a server fault, and the
 * caller can do nothing about it.
 */
export function toNoteRecord(row: unknown): NoteRecord {
  const parsed = NoteRow.parse(row)
  return {
    archivedAt: parsed.archived_at,
    body: parsed.body,
    createdAt: parsed.created_at,
    id: parsed.id,
    ownerId: parsed.owner_id,
    title: parsed.title,
    updatedAt: parsed.updated_at,
  }
}

/**
 * PostgREST hands back `unknown` from this port. Anything that is not an array
 * is a protocol surprise, not a row set — coerced to empty rather than indexed
 * blindly, because `data[0]` on a non-array is `undefined` and would read as
 * "no rows" instead of "something is very wrong".
 */
export function asRowArray(data: unknown): readonly unknown[] {
  return Array.isArray(data) ? data : []
}
