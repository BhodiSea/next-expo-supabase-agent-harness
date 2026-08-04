// ---------------------------------------------------------------------------
// The query PROBES for this vertical — the drivers `tools/gen-query-shapes.mjs`
// runs each DAL function through to record what it actually asks the database
// for. The recording port is harness-owned; this file only decides WHICH
// function runs and with WHAT inputs.
//
// The split matters. If a vertical supplied the observation too, the manifest
// would be a claim about the DAL rather than a measurement of it, and the first
// time a gate reddened, the cheapest repair would be to soften the claim. Here
// there is nothing to soften: the recorder reports the chain the DAL built, and
// `pnpm gen` overwrites the committed manifest with it.
//
// TWO RULES, BOTH ENFORCED BY THE GENERATOR RATHER THAN BY REVIEW:
//
//   1. `DAL` is a NAMESPACE import of the real data module, and generation fails
//      unless every function it exports is named by at least one probe. Adding a
//      query and forgetting a probe is a red, not a silence — which is the hole
//      every hand-maintained coverage list eventually has.
//   2. A probe that issues no query fails generation. An early return (an
//      unparseable cursor, an empty patch) records nothing, and a probe that
//      records nothing would quietly remove a shape from every downstream check
//      while still looking like coverage.
//
// BRANCHES ARE SHAPES. `listNotes` builds three different statements depending
// on its input — first page, cursor seek, and archived-included — and they have
// different plans. Each is probed separately, because a manifest that only ever
// saw the first page would certify an index that the seek does not use.
//
// The values below are fixtures with no meaning: the recorder keeps columns,
// operators and ordering and drops every literal, so nothing here reaches the
// committed manifest. They exist only to get each function past its own input
// validation and into the query builder.
// ---------------------------------------------------------------------------
import { encodeNotesCursor } from '../domain/cursor.js'
import type { NoteScope, NoteWriteContext } from './notes.js'
import * as dal from './notes.js'
import type { NotesDatabase } from './port.js'

/**
 * The DAL under observation, re-exported as a namespace so the generator's
 * coverage closure reads the functions that EXIST rather than a list.
 */
export const DAL = dal

/** One driver: which function, which branch of it, and how to run it. */
export interface QueryProbe {
  /** `<fn>#<branch>` — the stable identity of this shape in the manifest. */
  readonly id: string
  /** The DAL export this drives. Checked against `DAL` at generation time. */
  readonly fn: string
  readonly run: (db: NotesDatabase) => Promise<unknown>
}

const PROBE_ORG = '00000000-0000-4000-8000-0000000000a1'
const PROBE_ACTOR = '00000000-0000-4000-8000-0000000000b1'
const PROBE_NOTE = '00000000-0000-4000-8000-0000000000c1'
const PROBE_INSTANT = '2026-02-01T00:00:00.000Z'

const scope: NoteScope = { orgId: PROBE_ORG }

/** Writes need an actor, a clock and a sink; none of the three touch the query. */
const writeContext: NoteWriteContext = {
  actorId: PROBE_ACTOR,
  emit: () => undefined,
  now: PROBE_INSTANT,
  orgId: PROBE_ORG,
}

/**
 * A REAL cursor, minted by the encoder the DAL decodes with. A hand-written
 * token would fail `decodeNotesCursor`, `listNotes` would return
 * `invalidCursor()` before building anything, and the seek shape — the one that
 * actually needs the index's ordering tail — would vanish from the manifest.
 */
const seekCursor = encodeNotesCursor({ createdAt: PROBE_INSTANT, id: PROBE_NOTE })

export const QUERY_PROBES: readonly QueryProbe[] = [
  {
    fn: 'listNotes',
    id: 'listNotes#page',
    run: async (db) => await dal.listNotes(db, scope, { includeArchived: false, limit: 20 }),
  },
  {
    fn: 'listNotes',
    id: 'listNotes#seek',
    run: async (db) =>
      await dal.listNotes(db, scope, { cursor: seekCursor, includeArchived: false, limit: 20 }),
  },
  {
    fn: 'listNotes',
    id: 'listNotes#archived',
    run: async (db) => await dal.listNotes(db, scope, { includeArchived: true, limit: 20 }),
  },
  {
    fn: 'getNote',
    id: 'getNote#byId',
    run: async (db) => await dal.getNote(db, scope, { id: PROBE_NOTE }),
  },
  {
    fn: 'createNote',
    id: 'createNote#insert',
    run: async (db) => await dal.createNote(db, writeContext, { body: 'b', title: 't' }),
  },
  {
    fn: 'updateNote',
    id: 'updateNote#patch',
    run: async (db) => await dal.updateNote(db, writeContext, { id: PROBE_NOTE, title: 't' }),
  },
  {
    fn: 'deleteNote',
    id: 'deleteNote#byId',
    run: async (db) => await dal.deleteNote(db, writeContext, { id: PROBE_NOTE }),
  },
]
