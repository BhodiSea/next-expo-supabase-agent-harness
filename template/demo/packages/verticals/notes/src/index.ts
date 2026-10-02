// ---------------------------------------------------------------------------
// @app/notes — the seeded reference vertical, and the worked example every
// future slice is copied from.
//
// Shape of a vertical:
//
//   src/domain/   pure functions. No IO, no clock, no client. The layer that is
//                 exhaustively testable and therefore the layer where the rules
//                 actually live.
//   src/data/     the DAL. Takes a client, returns DTOs, never rows, never
//                 throws for a domain failure.
//   src/schemas.ts   the input schemas, derived from @app/contracts.
//   src/events.ts    the facts this vertical publishes.
//   src/client.ts    the Metro-safe subset (pure domain + direct reads).
//   src/index.ts     this file: everything on ./client, plus the writes.
//
// One rule this package exists to demonstrate: a vertical MUST NOT import
// another vertical. Cross-vertical logic belongs in packages/shared, promoted
// deliberately. Vertical-to-vertical imports are how a feature-sliced codebase
// quietly becomes a single knot with folders drawn on it.
//
// Dependencies are downward only: @app/contracts (wire shapes), @app/errors
// (the outcome kernel), @app/supabase (the sanctioned client factories — the
// DAL consumes a client, it never constructs one).
// ---------------------------------------------------------------------------

export * from './client.js'

// ---------------------------------------------------------------------------
// The server-only surface. These are NOT on ./client: each one sets an
// ownership column from a verified actor and publishes an event, which makes
// them the operations that must run where the actor was verified.
// ---------------------------------------------------------------------------

export {
  type AuthoredNoteScope,
  type AuthoredNotesQuery,
  createNote,
  deleteNote,
  // The DSR export read. SERVER BARREL ONLY, deliberately: it is invoked by the
  // `system.exportMyData` procedure per docs/runbooks/data-subject-requests.md,
  // and a personal-archive assembler has no business in the mobile bundle —
  // the phone reaches it through the procedure like every other Class-B read.
  listAuthoredNotes,
  type NoteWriteContext,
  updateNote,
} from './data/notes.js'
// The row boundary, exported for the migration/seed tooling that needs to name
// the table and its projections without re-spelling either — the export
// projection rides beside the list projection under the same law.
export {
  NOTE_COLUMNS,
  NOTE_EXPORT_COLUMNS,
  NOTE_EXPORT_ROW_KEYS,
  NOTE_ROW_KEYS,
  NOTES_TABLE,
} from './data/rows.js'
// The export-walk cursor codec, beside the read it positions (server-only for
// the same reason).
export {
  decodeNotesExportCursor,
  encodeNotesExportCursor,
  type NotesExportCursor,
} from './domain/cursor.js'
export { noteCreated, noteDeleted, noteUpdated } from './events.js'
