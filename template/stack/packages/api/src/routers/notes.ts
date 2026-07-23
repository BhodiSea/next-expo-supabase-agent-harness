import {
  CreateNoteSchema,
  createNote,
  deleteNote,
  getNote,
  ListNotesSchema,
  listNotes,
  NoteRefSchema,
  type NoteWriteContext,
  UpdateNoteSchema,
  updateNote,
} from '@app/notes'
import type { MemberContext } from '../trpc.js'
import { authedProcedure, memberProcedure, router } from '../trpc.js'

// ---------------------------------------------------------------------------
// The notes router — the worked example every future slice's router copies.
//
// Every procedure here is three lines or fewer, and that is the point: the
// router's whole job is to pick a rung of the ladder, name an input schema, and
// hand the call to the vertical. Business rules in a router are rules the web
// app's Server Actions cannot reach, and the moment one lands here the two
// surfaces have forked.
//
// The rung split says something real:
//   READS are `authedProcedure` — any signed-in user may read what RLS lets
//   them see, and their own notes are always in that set.
//   WRITES are `memberProcedure` — writing consumes a seat. A user whose
//   membership lapsed keeps their data and their read access, and stops being
//   able to add to it. That is a product decision, stated in one place.
// ---------------------------------------------------------------------------

/**
 * Assemble what a write needs beyond its input. It is a function, not a spread
 * at each call site, so `actorId` can only ever come from the VERIFIED actor —
 * there is no expression here a future edit could accidentally point at the
 * input instead.
 */
function writeContext(ctx: MemberContext, workspaceId: string): NoteWriteContext {
  return {
    actorId: ctx.actor.userId,
    emit: ctx.emit,
    now: ctx.now,
    workspaceId,
  }
}

export const notesRouter = router({
  create: memberProcedure.input(CreateNoteSchema).mutation(({ ctx, input }) => {
    const gate = ctx.member
    if (!gate.ok) return gate
    return createNote(ctx.db, writeContext(ctx, gate.data.workspaceId), input)
  }),

  get: authedProcedure.input(NoteRefSchema).query(({ ctx, input }) => getNote(ctx.db, input)),

  list: authedProcedure.input(ListNotesSchema).query(({ ctx, input }) => listNotes(ctx.db, input)),

  remove: memberProcedure.input(NoteRefSchema).mutation(({ ctx, input }) => {
    const gate = ctx.member
    if (!gate.ok) return gate
    return deleteNote(ctx.db, writeContext(ctx, gate.data.workspaceId), input)
  }),

  update: memberProcedure.input(UpdateNoteSchema).mutation(({ ctx, input }) => {
    const gate = ctx.member
    if (!gate.ok) return gate
    return updateNote(ctx.db, writeContext(ctx, gate.data.workspaceId), input)
  }),
})
