import { NewNoteInput, NOTES_PAGE_LIMIT_MAX, NoteDto, NotesPage } from '@app/contracts'
import { notes } from '@app/schema'
import { desc, eq, sql } from 'drizzle-orm'
import { withUserContext } from '../db/context.js'
import type { NotesDal } from '../types.js'
import { encodeNotesCursor, type NoteCursorKey } from './cursor.js'

// Keyset seek for ORDER BY created_at DESC, id DESC: everything strictly after
// the cursor position, via a single row-value comparison the planner turns
// into an index range condition — never OFFSET.
// SOURCE: https://use-the-index-luke.com/no-offset and PostgreSQL row-wise
// comparison https://www.postgresql.org/docs/current/functions-comparisons.html
const afterCursor = (cursor: NoteCursorKey) =>
  sql`(${notes.createdAt}, ${notes.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`

export const notesDal: NotesDal = {
  async list(userId, page) {
    // Defensive clamp (defense in depth below the route's Zod bound): the DAL
    // NEVER issues an unbounded SELECT, whatever a future caller passes.
    const limit = Math.min(Math.max(Math.trunc(page.limit), 1), NOTES_PAGE_LIMIT_MAX)
    return withUserContext(userId, async (tx) => {
      // SOURCE: visibility is enforced by the notes RLS policies via the app.user_id GUC —
      // the DAL adds no owner_id WHERE clause by design, so a policy regression cannot be
      // masked by application-side filtering [corpus: postgres/rls-initplan]
      const rows = await tx
        .select()
        .from(notes)
        .where(page.cursor === undefined ? undefined : afterCursor(page.cursor))
        .orderBy(desc(notes.createdAt), desc(notes.id))
        .limit(limit + 1) // one sentinel row past the page: cheap has-more probe
      const items = rows.slice(0, limit)
      const last = items.at(-1)
      const nextCursor =
        rows.length > limit && last !== undefined
          ? encodeNotesCursor({ createdAt: last.createdAt, id: last.id })
          : null
      // Zod-parse at the DAL exit (BUILD-SPEC DAL law): raw driver rows never escape.
      return NotesPage.parse({ items, nextCursor })
    })
  },

  async create(userId, input) {
    const data = NewNoteInput.parse(input)
    return withUserContext(userId, async (tx) => {
      // owner_id comes from the verified token via the GUC identity — never from the
      // wire — and must equal app.user_id or the INSERT policy rejects the row.
      const rows = await tx
        .insert(notes)
        .values({ body: data.body ?? '', ownerId: userId, title: data.title })
        .returning()
      const row = rows[0]
      if (row === undefined) {
        throw new Error('insert into notes returned no row')
      }
      return NoteDto.parse(row)
    })
  },

  async get(userId, id) {
    return withUserContext(userId, async (tx) => {
      const rows = await tx.select().from(notes).where(eq(notes.id, id)).limit(1)
      const row = rows[0]
      return row === undefined ? null : NoteDto.parse(row)
    })
  },

  async remove(userId, id) {
    return withUserContext(userId, async (tx) => {
      const rows = await tx.delete(notes).where(eq(notes.id, id)).returning({ id: notes.id })
      return rows.length > 0
    })
  },
}
