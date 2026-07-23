// ---------------------------------------------------------------------------
// @app/notes/client — the METRO-SAFE barrel.
//
// Everything reachable from this file must be bundleable into a native binary:
// pure domain functions, zod schemas, and the DIRECT READS a phone performs
// against its own RLS-scoped Supabase client. Nothing here may reach a
// service-role client, a Next-coupled leaf, or a Node built-in — Metro does not
// tree-shake, so an unreachable-in-practice import is still a shipped one, and
// the first symptom is a red screen on a device rather than a build error.
//
// The split is not stylistic. Reads are safe to run from the client because RLS
// is the authorization boundary and the phone holds a token scoped to one user.
// Writes are NOT on this barrel: they emit events, they set ownership columns,
// and they are the operations where a single implementation shared by both
// surfaces (see ./index.ts) is worth the round trip.
//
// In THIS vertical the write functions happen to be bundle-safe as well — they
// TAKE a client, they never make one — so the barrier here is about API surface,
// not about what ends up in the binary. State it plainly rather than let the
// next slice assume the wall is decorative: in a vertical whose writes need an
// elevated credential, this same barrier is the only thing keeping that
// credential out of an app store binary.
// ---------------------------------------------------------------------------

// Direct reads.
export { getNote, listNotes } from './data/notes.js'
// The database port — a type, so it costs nothing at runtime, and it is what
// lets a caller pass its own RLS-scoped client without importing the DAL's
// internals.
export type {
  NotesDatabase,
  PostgrestFailure,
  PostgrestOutcome,
  PostgrestQuery,
  PostgrestTable,
} from './data/port.js'
// The keyset codec. Both surfaces need it: the server mints cursors, the
// clients hold them, and an optimistic list has to be able to read one back.
export { decodeNotesCursor, encodeNotesCursor, type NoteCursor } from './domain/cursor.js'
// Pure domain — no IO, no clock, fully unit-tested.
export {
  applyNoteUpdate,
  buildExcerpt,
  compareNotesByRecency,
  isArchived,
  isRenderableTitle,
  type NotePatch,
  normalizeTitle,
  toNoteView,
} from './domain/note.js'
export type {
  NoteCreatedPayload,
  NoteDeletedPayload,
  NoteEvent,
  NoteEventBase,
  NoteEventSink,
  NoteField,
  NoteUpdatedPayload,
} from './events.js'
// The event vocabulary. Names and payload shapes are shared so a client-side
// cache can invalidate on the same facts a server-side sink records. The
// CATALOG rides this barrel too: the contracts generator walks it, and a
// catalog reachable only from the server barrel would be invisible to it.
export { noteEvents } from './events.js'
// Input schemas — validated identically wherever a form lives.
export {
  CreateNoteSchema,
  clampPageLimit,
  ListNotesSchema,
  NoteRefSchema,
  UpdateNoteSchema,
} from './schemas.js'
