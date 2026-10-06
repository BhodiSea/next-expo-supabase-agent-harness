import type { OrgSummary } from '@app/contracts'
import { outcomeOk } from '@app/errors'
import type * as Notes from '@app/notes'
import {
  createNote,
  type NoteEvent,
  type NotesDatabase,
  type PostgrestQuery,
  type PostgrestTable,
} from '@app/notes'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createNoteAction } from '../app/actions/notes'

// The web write path builds its NoteWriteContext from the host's request ports
// (lib/request-ports.ts), the same sink and clock the tRPC route hands createContext. Before
// #144 the Server Action spelled its own context inline, with a no-op sink and a `new Date()`
// of its own, so a sink wired into the host would have heard every tRPC write and no web one.
//
// apps/web/app/** is outside the web unit lane's coverage, which is why this suite drives the
// exported action through its seams rather than measuring the file: the session lookup, the
// rate-limit seam, next/cache and the request ports are replaced, and @app/notes' createNote
// is the real one behind a spy, so the context it receives is the context the action built.
// SOURCE: apps/web/app/actions/notes.ts · packages/verticals/notes/src/data/write-context.ts

const USER_ID = '9b2b1c7e-2a44-4a3e-8f5d-6c1a2b3c4d5e'
const NOTE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const INSTANT = '2026-06-01T12:00:00.000Z'
const ORG: OrgSummary = {
  id: '5c2b1c7e-2a44-4a3e-8f5d-6c1a2b3c4d5f',
  name: 'Acme',
  role: 'owner',
  slug: 'acme',
}

const NOTE_ROW = {
  archived_at: null,
  body: '',
  created_at: '2026-01-01T00:00:00.000000+00:00',
  id: NOTE_ID,
  owner_id: USER_ID,
  title: 'a web note',
  updated_at: '2026-01-01T00:00:00.000000+00:00',
}

/** A PostgREST client whose every chain resolves one inserted row. */
function insertingDatabase(): NotesDatabase {
  const query: PostgrestQuery = Object.assign(Promise.resolve({ data: [NOTE_ROW], error: null }), {
    eq: (): PostgrestQuery => query,
    is: (): PostgrestQuery => query,
    limit: (): PostgrestQuery => query,
    lte: (): PostgrestQuery => query,
    or: (): PostgrestQuery => query,
    order: (): PostgrestQuery => query,
    select: (): PostgrestQuery => query,
  })
  const table: PostgrestTable = {
    delete: (): PostgrestQuery => query,
    insert: (): PostgrestQuery => query,
    select: (): PostgrestQuery => query,
    update: (): PostgrestQuery => query,
  }
  return { from: (): PostgrestTable => table }
}

// A recording sink. Hoisted with the mocks, because the request-ports mock below hands it out.
const { emitted, sink } = vi.hoisted(() => {
  const emitted: NoteEvent[] = []
  const sink = (event: NoteEvent): void => {
    emitted.push(event)
  }
  return { emitted, sink }
})

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('../lib/rate-limit-runtime', () => ({
  enforceActionRateLimit: vi.fn(() => Promise.resolve(null)),
}))
vi.mock('../lib/auth/session', () => ({
  requireOrgContext: vi.fn(() =>
    Promise.resolve(
      outcomeOk({ client: insertingDatabase() as never, org: ORG, orgs: [ORG], userId: USER_ID }),
    ),
  ),
}))
vi.mock('../lib/request-ports', () => ({
  requestPorts: () => ({ emit: sink, now: INSTANT }),
}))
vi.mock('@app/notes', async (importOriginal) => {
  const actual = await importOriginal<typeof Notes>()
  return { ...actual, createNote: vi.fn(actual.createNote) }
})

beforeEach(() => {
  emitted.length = 0
  vi.mocked(createNote).mockClear()
})

describe('createNoteAction builds its write context from the request ports', () => {
  it('hands createNote the host sink and the request instant', async () => {
    const outcome = await createNoteAction(ORG.slug, { title: 'a web note' })

    expect(outcome.ok).toBe(true)
    expect(createNote).toHaveBeenCalledOnce()
    const context = vi.mocked(createNote).mock.calls[0]?.[1]
    expect(context?.emit).toBe(sink)
    expect(context?.now).toBe(INSTANT)
    // Identity and scope still come from the gate, never from the input.
    expect(context?.actorId).toBe(USER_ID)
    expect(context?.orgId).toBe(ORG.id)
  })

  it('delivers the write’s event to the host sink', async () => {
    await createNoteAction(ORG.slug, { title: 'a web note' })

    expect(emitted.map((event) => event.name)).toEqual(['notes.created'])
    const payload = emitted[0]?.payload
    expect(payload?.actorId).toBe(USER_ID)
    expect(payload?.noteId).toBe(NOTE_ID)
    expect(payload?.orgId).toBe(ORG.id)
  })
})
