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
import type { OrgContext } from '../trpc.js'
import { orgProcedure, router } from '../trpc.js'

// ---------------------------------------------------------------------------
// The notes router — the worked example every future slice's router copies.
//
// Every procedure here is three lines or fewer, and that is the point: the
// router's whole job is to pick a rung of the ladder, name an input schema, and
// hand the call to the vertical. Business rules in a router are rules the web
// app's Server Actions cannot reach, and the moment one lands here the two
// surfaces have forked.
//
// EVERY PROCEDURE IS `orgProcedure`, READS INCLUDED — and that is a change from
// the pre-org model, where reads rode `authedProcedure` because "their own notes
// are always in that set". Under org scope that sentence stops being true in a
// useful way: a user in three orgs has three sets, RLS admits all of them at
// once, and a read with no active org would return them interleaved with no way
// to tell which org a row came from. The acting org is not an extra permission
// on top of the read — it is WHICH DATA the read is about.
//
// The gate is still an outcome on the data channel, never a throw, so a caller
// with no active org gets a `forbidden(org_context_required)` it can render as
// "pick an organization" instead of an empty page that looks like data loss.
// ---------------------------------------------------------------------------

/**
 * Assemble what a write needs beyond its input. It is a function, not a spread
 * at each call site, so `actorId` can only ever come from the VERIFIED actor and
 * `orgId` from the RESOLVED gate — there is no expression here a future edit
 * could accidentally point at the input instead.
 */
function writeContext(ctx: OrgContext, orgId: string): NoteWriteContext {
  return {
    actorId: ctx.actor.userId,
    emit: ctx.emit,
    now: ctx.now,
    orgId,
  }
}

export const notesRouter = router({
  create: orgProcedure.input(CreateNoteSchema).mutation(({ ctx, input }) => {
    const gate = ctx.org
    if (!gate.ok) return gate
    return createNote(ctx.db, writeContext(ctx, gate.data.id), input)
  }),

  get: orgProcedure.input(NoteRefSchema).query(({ ctx, input }) => {
    const gate = ctx.org
    if (!gate.ok) return gate
    return getNote(ctx.db, { orgId: gate.data.id }, input)
  }),

  list: orgProcedure.input(ListNotesSchema).query(({ ctx, input }) => {
    const gate = ctx.org
    if (!gate.ok) return gate
    return listNotes(ctx.db, { orgId: gate.data.id }, input)
  }),

  remove: orgProcedure.input(NoteRefSchema).mutation(({ ctx, input }) => {
    const gate = ctx.org
    if (!gate.ok) return gate
    return deleteNote(ctx.db, writeContext(ctx, gate.data.id), input)
  }),

  update: orgProcedure.input(UpdateNoteSchema).mutation(({ ctx, input }) => {
    const gate = ctx.org
    if (!gate.ok) return gate
    return updateNote(ctx.db, writeContext(ctx, gate.data.id), input)
  }),
})
