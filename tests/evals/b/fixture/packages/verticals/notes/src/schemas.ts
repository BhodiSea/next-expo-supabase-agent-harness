import {
  NewNoteInput,
  NOTES_PAGE_LIMIT_MAX,
  NoteRef,
  NotesListQuery,
  NoteUpdateInput,
} from '@app/contracts'
import { z } from 'zod'
import { isRenderableTitle } from './domain/note.js'

// ---------------------------------------------------------------------------
// The vertical's INPUT schemas — what a procedure or a server action validates
// before anything touches the database.
//
// They are derived from @app/contracts rather than redefined: the wire bounds
// live in exactly one place, and this layer only ADDS the refinements that need
// domain knowledge. A refinement that could have been a bound belongs upstream,
// in the contract, where the client sees it too.
// ---------------------------------------------------------------------------

/**
 * A title that is only whitespace clears every wire bound (`min(1)` counts
 * characters) and then renders as an empty list row on both surfaces. The
 * emptiness test has to run on the NORMALISED form, which is domain knowledge,
 * so it lands here rather than in the contract.
 */
const renderableTitle = { message: 'title must contain at least one visible character' }

export const CreateNoteSchema = NewNoteInput.refine(
  (input) => isRenderableTitle(input.title),
  renderableTitle,
)
export type CreateNoteSchema = z.infer<typeof CreateNoteSchema>

export const UpdateNoteSchema = NoteUpdateInput.refine(
  (patch) => patch.title === undefined || isRenderableTitle(patch.title),
  renderableTitle,
)
export type UpdateNoteSchema = z.infer<typeof UpdateNoteSchema>

/** Addressing a single note — reads, archives and deletes all share it. */
export const NoteRefSchema = NoteRef
export type NoteRefSchema = z.infer<typeof NoteRefSchema>

/** The list query, unchanged from the wire contract: nothing here needs domain knowledge. */
export const ListNotesSchema = NotesListQuery
export type ListNotesSchema = z.infer<typeof ListNotesSchema>

/**
 * The DAL's own defensive clamp, exported so the bound is stated once. Defense
 * in depth BELOW the schema above: the DAL must never issue an unbounded SELECT
 * whatever a future caller passes it, including a caller that skipped the
 * schema entirely (a script, a migration backfill, a test).
 */
export function clampPageLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 1
  return Math.min(Math.max(Math.trunc(limit), 1), NOTES_PAGE_LIMIT_MAX)
}
