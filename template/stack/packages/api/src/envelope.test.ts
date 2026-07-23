import { appError } from '@app/errors'
import type { NotesDatabase, PostgrestOutcome, PostgrestQuery, PostgrestTable } from '@app/notes'
import { TRPCError } from '@trpc/server'
import { describe, expect, it } from 'vitest'
import { createContext, type Session } from './context.js'
import { appRouter } from './index.js'
import { createCallerFactory } from './trpc.js'

// ---------------------------------------------------------------------------
// The envelope rule, asserted end to end through the real router.
//
//   Transport-level facts (no session, skewed client) THROW.
//   Everything else — including authorization outcomes — is a VALUE on the data
//   channel.
//
// The distinction is the whole reason a screen can say "someone else deleted
// this note" instead of "something went wrong", so it is pinned here rather
// than left to convention.
// ---------------------------------------------------------------------------

const SERVER_VERSION = '1.2.3'
const ACTOR_ID = '9b2b1c7e-2a44-4a3e-8f5d-6c1a2b3c4d5e'
const WORKSPACE_ID = '5c2b1c7e-2a44-4a3e-8f5d-6c1a2b3c4d5f'
const NOTE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const NOW = '2026-06-01T12:00:00.000Z'

const NOTE_ROW = {
  archived_at: null,
  body: 'hello world',
  created_at: '2026-01-01T00:00:00.000000+00:00',
  id: NOTE_ID,
  owner_id: ACTOR_ID,
  title: 'note one',
  updated_at: '2026-01-01T00:00:00.000000+00:00',
}

const member: Session = {
  actor: { displayName: 'Sam', email: 'sam@example.test', userId: ACTOR_ID },
  membership: { role: 'owner', workspaceId: WORKSPACE_ID },
}

const seatless: Session = { actor: member.actor, membership: null }

/** A PostgREST client scripted with one outcome — see the vertical's own tests. */
function fakeDatabase(outcome: PostgrestOutcome): NotesDatabase {
  const query: PostgrestQuery = Object.assign(Promise.resolve(outcome), {
    eq: (): PostgrestQuery => query,
    is: (): PostgrestQuery => query,
    limit: (): PostgrestQuery => query,
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

/** A client that fails the test if a handler ever reaches it. */
const untouchableDb: NotesDatabase = {
  from: () => {
    throw new Error('the gate must reject before any query is built')
  },
}

async function callerFor(session: Session | null, db: NotesDatabase) {
  const ctx = await createContext({
    createClient: () => db,
    headers: session === null ? {} : { authorization: 'Bearer test-token' },
    now: () => NOW,
    resolveSession: () => Promise.resolve(session),
    serverVersion: SERVER_VERSION,
  })
  return createCallerFactory(appRouter)(ctx)
}

describe('health — public, and the one procedure that is not enveloped', () => {
  it('answers with no session and no database', async () => {
    const caller = await callerFor(null, untouchableDb)
    await expect(caller.system.health()).resolves.toEqual({ ok: true, version: SERVER_VERSION })
  })

  it('reports the version the skew gate compares against', async () => {
    const caller = await callerFor(null, untouchableDb)
    const report = await caller.system.health()
    expect(report.version).toBe(SERVER_VERSION)
  })
})

describe('the auth rung THROWS — the one sanctioned transport-level rejection', () => {
  it.each(['system.me', 'notes.list'])('%s rejects an anonymous caller', async (path) => {
    const caller = await callerFor(null, untouchableDb)
    const groups = caller as unknown as Record<
      string,
      Record<string, (input?: unknown) => Promise<unknown>>
    >
    const [namespace, procedure] = path.split('.')
    const call = groups[namespace ?? '']?.[procedure ?? '']

    // Input is irrelevant here: the auth middleware sits BEFORE the input
    // parser, so an anonymous caller is rejected whatever it sends.
    const thrown: unknown = await call?.(undefined).catch((cause: unknown) => cause)
    expect(thrown).toBeInstanceOf(TRPCError)
    if (!(thrown instanceof TRPCError)) return
    expect(thrown.code).toBe('UNAUTHORIZED')
  })

  it('returns the actor view on the envelope once authenticated', async () => {
    const caller = await callerFor(member, untouchableDb)
    await expect(caller.system.me()).resolves.toEqual({
      ok: true,
      data: {
        displayName: 'Sam',
        email: 'sam@example.test',
        id: ACTOR_ID,
        role: 'owner',
        workspaceId: WORKSPACE_ID,
      },
    })
  })

  it('models a signed-in caller with no membership rather than failing', async () => {
    // Invitation pending, seat revoked, trial lapsed — all reachable, none of
    // them a crash.
    const caller = await callerFor(seatless, untouchableDb)
    await expect(caller.system.me()).resolves.toEqual({
      ok: true,
      data: {
        displayName: 'Sam',
        email: 'sam@example.test',
        id: ACTOR_ID,
        role: null,
        workspaceId: null,
      },
    })
  })
})

describe('the member rung does NOT throw — authorization rides the envelope', () => {
  it('returns forbidden on the data channel and never touches the database', async () => {
    const caller = await callerFor(seatless, untouchableDb)
    await expect(caller.notes.create({ title: 'blocked' })).resolves.toEqual({
      ok: false,
      error: appError.forbidden({
        code: 'membership_required',
        message: 'an active workspace membership is required',
      }),
    })
  })

  it('gates every write, not just create', async () => {
    const caller = await callerFor(seatless, untouchableDb)
    const denied = {
      ok: false,
      error: appError.forbidden({
        code: 'membership_required',
        message: 'an active workspace membership is required',
      }),
    }
    await expect(caller.notes.update({ id: NOTE_ID, title: 'x' })).resolves.toEqual(denied)
    await expect(caller.notes.remove({ id: NOTE_ID })).resolves.toEqual(denied)
  })

  it('leaves READS open to any authenticated caller — a lapsed seat keeps its data', async () => {
    const caller = await callerFor(seatless, fakeDatabase({ data: [NOTE_ROW], error: null }))
    const outcome = await caller.notes.list({ includeArchived: false, limit: 50 })
    expect(outcome.ok).toBe(true)
  })
})

describe('domain failures are values, never throws', () => {
  it('reports a missing note on the data channel', async () => {
    const caller = await callerFor(member, fakeDatabase({ data: [], error: null }))
    await expect(caller.notes.get({ id: NOTE_ID })).resolves.toEqual({
      ok: false,
      error: appError.notFound({ resource: 'note' }),
    })
  })

  it('reports an RLS write denial on the data channel as rlsDenied', async () => {
    const caller = await callerFor(
      member,
      fakeDatabase({
        data: null,
        error: { code: '42501', message: 'new row violates row-level security policy' },
      }),
    )
    await expect(caller.notes.create({ title: 'denied' })).resolves.toEqual({
      ok: false,
      // `rlsDenied`, not `forbidden`: the database said no, not the application.
      error: appError.rlsDenied({
        relation: 'notes',
        message: 'a row-security policy refused the create',
      }),
    })
  })

  it('keeps the AppError discriminant intact through the transport', async () => {
    // The point of the rule: a thrown TRPCError would flatten these two
    // distinct `kind` discriminants into one HTTP status, and the screen could
    // no longer tell them apart.
    const emptyCaller = await callerFor(member, fakeDatabase({ data: [], error: null }))
    const deniedCaller = await callerFor(
      member,
      fakeDatabase({ data: null, error: { code: '42501', message: 'denied' } }),
    )
    const missing = await emptyCaller.notes.get({ id: NOTE_ID })
    const denied = await deniedCaller.notes.get({ id: NOTE_ID })

    expect(missing.ok).toBe(false)
    expect(denied.ok).toBe(false)
    expect(missing).not.toEqual(denied)
  })

  it('returns the render shape on success — the DAL never leaks a row', async () => {
    const caller = await callerFor(member, fakeDatabase({ data: [NOTE_ROW], error: null }))
    const outcome = await caller.notes.list({ includeArchived: false, limit: 50 })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.items).toEqual([
      {
        createdAt: '2026-01-01T00:00:00.000000+00:00',
        excerpt: 'hello world',
        hasBody: true,
        id: NOTE_ID,
        isArchived: false,
        title: 'note one',
        updatedAt: '2026-01-01T00:00:00.000000+00:00',
      },
    ])
  })
})

describe('input validation is a CONTRACT violation, not a domain outcome', () => {
  it('throws BAD_REQUEST for input the typed client could not have produced', async () => {
    const caller = await callerFor(member, untouchableDb)
    const groups = caller as unknown as Record<
      string,
      Record<string, (input?: unknown) => Promise<unknown>>
    >
    const thrown: unknown = await groups['notes']
      ?.['get']?.({ id: 'not-a-uuid' })
      .catch((cause: unknown) => cause)

    expect(thrown).toBeInstanceOf(TRPCError)
    if (!(thrown instanceof TRPCError)) return
    expect(thrown.code).toBe('BAD_REQUEST')
  })

  it('rejects a title that is only whitespace — the bound alone cannot see it', async () => {
    const caller = await callerFor(member, untouchableDb)
    const thrown: unknown = await caller.notes
      .create({ title: '   ' })
      .catch((cause: unknown) => cause)
    expect(thrown).toBeInstanceOf(TRPCError)
  })
})
