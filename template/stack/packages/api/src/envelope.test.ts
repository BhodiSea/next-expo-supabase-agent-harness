import type { OrgSummary } from '@app/contracts'
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
const ORG_ID = '5c2b1c7e-2a44-4a3e-8f5d-6c1a2b3c4d5f'
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

const ORG: OrgSummary = { id: ORG_ID, name: 'Acme', role: 'owner', slug: 'acme' }

// ONE seat, so createContext's "header absent, exactly one org" default resolves it
// without every test having to set an x-org-id header.
const member: Session = {
  actor: { displayName: 'Sam', email: 'sam@example.test', userId: ACTOR_ID },
  orgs: [ORG],
}

const seatless: Session = { actor: member.actor, orgs: [] }

/** A PostgREST client scripted with one outcome — see the vertical's own tests. */
function fakeDatabase(outcome: PostgrestOutcome): NotesDatabase {
  const query: PostgrestQuery = Object.assign(Promise.resolve(outcome), {
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

/** A client that fails the test if a handler ever reaches it. */
const untouchableDb: NotesDatabase = {
  from: () => {
    throw new Error('the gate must reject before any query is built')
  },
}

async function callerFor(
  session: Session | null,
  db: NotesDatabase,
  extraHeaders: Record<string, string> = {},
) {
  const ctx = await createContext({
    createClient: () => db,
    headers:
      session === null ? extraHeaders : { authorization: 'Bearer test-token', ...extraHeaders },
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
        // Resolved by createContext's "header absent, exactly one seat" default —
        // the one case where an absent selector has exactly one possible answer.
        activeOrg: ORG,
        displayName: 'Sam',
        email: 'sam@example.test',
        id: ACTOR_ID,
        orgs: [ORG],
      },
    })
  })

  it('models a signed-in caller with no seat rather than failing', async () => {
    // Invitation pending, seat revoked, trial lapsed — all reachable, none of
    // them a crash. `system.me` stays on authedProcedure precisely so this caller
    // can still ask what orgs they have; a gate here would leave the org switcher
    // with nothing to switch between.
    const caller = await callerFor(seatless, untouchableDb)
    await expect(caller.system.me()).resolves.toEqual({
      ok: true,
      data: {
        activeOrg: null,
        displayName: 'Sam',
        email: 'sam@example.test',
        id: ACTOR_ID,
        orgs: [],
      },
    })
  })

  it('a caller in SEVERAL orgs and no x-org-id header has NO active org', async () => {
    // Not "the first one". Picking one would make the acting tenant a function of
    // array order, and a write landing in whichever org sorted first is a data
    // corruption nobody would think to look for.
    const other: OrgSummary = { id: NOTE_ID, name: 'Globex', role: 'viewer', slug: 'globex' }
    const caller = await callerFor({ ...member, orgs: [ORG, other] }, untouchableDb)
    const outcome = await caller.system.me()
    expect(outcome.ok && outcome.data.activeOrg).toBeNull()
    expect(outcome.ok && outcome.data.orgs).toHaveLength(2)
  })
})

describe('the org rung does NOT throw — authorization rides the envelope', () => {
  const denied = {
    ok: false,
    error: appError.forbidden({
      code: 'org_context_required',
      message: 'an active organization is required',
    }),
  }

  it('returns forbidden on the data channel and never touches the database', async () => {
    const caller = await callerFor(seatless, untouchableDb)
    await expect(caller.notes.create({ title: 'blocked' })).resolves.toEqual(denied)
  })

  it('gates every write, not just create', async () => {
    const caller = await callerFor(seatless, untouchableDb)
    await expect(caller.notes.update({ id: NOTE_ID, title: 'x' })).resolves.toEqual(denied)
    await expect(caller.notes.remove({ id: NOTE_ID })).resolves.toEqual(denied)
  })

  it('gates READS too — under org scope a read without an org is not a narrower read', () => {
    // A CHANGE from the pre-org model, where reads rode authedProcedure because
    // "their own notes are always in that set". With several orgs, RLS admits all
    // of them at once and an ungated read would interleave tenants with no way to
    // tell which row came from where. The acting org is not an extra permission on
    // top of the read — it is WHICH DATA the read is about.
    return callerFor(seatless, untouchableDb).then(async (caller) => {
      await expect(caller.notes.list({ includeArchived: false, limit: 50 })).resolves.toEqual(
        denied,
      )
      await expect(caller.notes.get({ id: NOTE_ID })).resolves.toEqual(denied)
    })
  })

  it('an x-org-id naming an org the caller does not hold is NOT an elevation', async () => {
    // Not an error either: raising would make the header a probe that distinguishes
    // "exists but not yours" from "no such org" — the same existence disclosure the
    // RLS suites refuse one layer down.
    const caller = await callerFor(member, untouchableDb, {
      'x-org-id': '00000000-0000-4000-8000-000000000000',
    })
    await expect(caller.notes.create({ title: 'blocked' })).resolves.toEqual(denied)
  })

  it('a caller WITH a seat reaches the vertical', async () => {
    const caller = await callerFor(member, fakeDatabase({ data: [NOTE_ROW], error: null }))
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

// --- R3c mutation-kill tests (added by triage) ---
describe('seated-member writes reach the vertical (kill: gate short-circuit + writeContext assembly)', () => {
  it('create with a seat resolves ok — writeContext must carry actor/workspace/emit, not {}', async () => {
    // With writeContext() -> {}, ctx.emit is undefined and createNote throws on
    // the emit call, turning this resolve into a reject. Kills e88e9329a73f.
    const caller = await callerFor(member, fakeDatabase({ data: [NOTE_ROW], error: null }))
    await expect(caller.notes.create({ title: 'a seated create' })).resolves.toMatchObject({
      ok: true,
    })
  })

  it('update with a seat returns the vertical outcome, not the membership gate', async () => {
    // Original: no row -> notFound. Mutant `if (true) return gate` leaks the
    // membership success outcome { ok: true, data: membership } instead.
    const caller = await callerFor(member, fakeDatabase({ data: [], error: null }))
    await expect(caller.notes.update({ id: NOTE_ID, title: 'x' })).resolves.toEqual({
      ok: false,
      error: appError.notFound({ resource: 'note' }),
    })
  })

  it('remove with a seat returns the vertical outcome, not the membership gate', async () => {
    const caller = await callerFor(member, fakeDatabase({ data: [], error: null }))
    await expect(caller.notes.remove({ id: NOTE_ID })).resolves.toEqual({
      ok: false,
      error: appError.notFound({ resource: 'note' }),
    })
  })
})

// --- the router hands the DAL the GATED org, not an empty scope --------------
//
// The mutation lane found `{ orgId: gate.data.id }` surviving on both read procedures:
// replacing it with `{}` changed nothing any test noticed. That object is the entire
// mechanical link between "the gate resolved an acting org" and "the query filters by it",
// and the rung above it is a good-error rung, not the boundary — so a break here does not
// leak (RLS still refuses), it silently sends an UNSCOPED query and lets the policy do all
// the work by scanning. This asserts the value actually arrives, by RECORDING what the DAL
// was asked to filter on rather than inspecting the router's source.
describe('the org gate is wired to the DAL, not merely evaluated', () => {
  /** A client that records the `eq` filters the DAL builds on it. */
  function recordingDatabase(outcome: PostgrestOutcome): {
    filters: [string, string][]
    db: NotesDatabase
  } {
    const filters: [string, string][] = []
    const query: PostgrestQuery = Object.assign(Promise.resolve(outcome), {
      eq: (column: string, value: string): PostgrestQuery => {
        filters.push([column, value])
        return query
      },
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
    return { filters, db: { from: (): PostgrestTable => table } }
  }

  it('notes.list filters on the ACTIVE org resolved by the gate', async () => {
    const { filters, db } = recordingDatabase({ data: [], error: null })
    const caller = await callerFor(member, db)
    await caller.notes.list({ includeArchived: false, limit: 50 })
    expect(filters).toContainEqual(['org_id', ORG_ID])
  })

  it('notes.get filters on the ACTIVE org as well as the row id', async () => {
    const { filters, db } = recordingDatabase({ data: [], error: null })
    const caller = await callerFor(member, db)
    await caller.notes.get({ id: NOTE_ID })
    expect(filters).toContainEqual(['org_id', ORG_ID])
    expect(filters).toContainEqual(['id', NOTE_ID])
  })
})
