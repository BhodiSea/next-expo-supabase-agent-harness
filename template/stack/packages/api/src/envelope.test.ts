import type { OrgSummary } from '@app/contracts'
import { appError, outcomeOk } from '@app/errors'
import { TRPCError } from '@trpc/server'
import { describe, expect, it } from 'vitest'
import type { ApiDatabase, StoreOutcome, StoreQuery, StoreTable } from './context.js'
import { createContext, type Session } from './context.js'
import { systemRouter } from './routers/system.js'
import { createCallerFactory, orgProcedure, router } from './trpc.js'

// ---------------------------------------------------------------------------
// The envelope rule, asserted end to end through the real router.
//
//   Transport-level facts (no session, skewed client) THROW.
//   Everything else — including authorization outcomes — is a VALUE on the data
//   channel.
//
// The distinction is the whole reason a screen can say "you are not acting in an
// organization" instead of "something went wrong", so it is pinned here rather
// than left to convention.
// ---------------------------------------------------------------------------

const SERVER_VERSION = '1.2.3'
const ACTOR_ID = '9b2b1c7e-2a44-4a3e-8f5d-6c1a2b3c4d5e'
const ORG_ID = '5c2b1c7e-2a44-4a3e-8f5d-6c1a2b3c4d5f'
const OTHER_ORG_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const NOW = '2026-06-01T12:00:00.000Z'
const WIRE = '2026-01-01T00:00:00.000000+00:00'

const ORG: OrgSummary = { id: ORG_ID, name: 'Acme', role: 'owner', slug: 'acme' }

// ONE seat, so createContext's "header absent, exactly one org" default resolves it
// without every test having to set an x-org-id header.
const member: Session = {
  actor: { displayName: 'Sam', email: 'sam@example.test', userId: ACTOR_ID },
  orgs: [ORG],
}

const seatless: Session = { actor: member.actor, orgs: [] }

/**
 * The org rung, mounted the way a vertical's router mounts it. A default scaffold
 * mounts no vertical, so nothing in appRouter sits on `orgProcedure`; this probe is
 * the smallest procedure that does, with the same two-line gate every org procedure
 * opens with. Mounted beside the real system router, so the rungs below it are the
 * real ones.
 */
const probedRouter = router({
  system: systemRouter,
  probe: router({
    actingOrg: orgProcedure.query(({ ctx }) => {
      const gate = ctx.org
      if (!gate.ok) return gate
      return outcomeOk({ orgId: gate.data.id })
    }),
  }),
})

/** A PostgREST client scripted with one outcome per table, in call order. */
function fakeDatabase(outcomes: Record<string, StoreOutcome>): ApiDatabase {
  const table = (outcome: StoreOutcome): StoreTable => {
    const query: StoreQuery = Object.assign(Promise.resolve(outcome), {
      eq: (): StoreQuery => query,
      limit: (): StoreQuery => query,
      order: (): StoreQuery => query,
      select: (): StoreQuery => query,
    })
    return { select: (): StoreQuery => query }
  }
  return {
    from: (name: string): StoreTable => table(outcomes[name] ?? { data: [], error: null }),
  }
}

/** A client that fails the test if a handler ever reaches it. */
const untouchableDb: ApiDatabase = {
  from: () => {
    throw new Error('the gate must reject before any query is built')
  },
}

async function callerFor(
  session: Session | null,
  db: ApiDatabase,
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
  return createCallerFactory(probedRouter)(ctx)
}

const PROFILE_ROW = { created_at: WIRE, display_name: 'Sam', id: ACTOR_ID, updated_at: WIRE }

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
  it.each([
    'system.me',
    'system.exportMyData',
    'probe.actingOrg',
  ])('%s rejects an anonymous caller', async (path) => {
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
    const other: OrgSummary = { id: OTHER_ORG_ID, name: 'Globex', role: 'viewer', slug: 'globex' }
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
    await expect(caller.probe.actingOrg()).resolves.toEqual(denied)
  })

  it('an x-org-id naming an org the caller does not hold is NOT an elevation', async () => {
    // Not an error either: raising would make the header a probe that distinguishes
    // "exists but not yours" from "no such org" — the same existence disclosure the
    // RLS suites refuse one layer down.
    const caller = await callerFor(member, untouchableDb, {
      'x-org-id': '00000000-0000-4000-8000-000000000000',
    })
    await expect(caller.probe.actingOrg()).resolves.toEqual(denied)
  })

  it('a caller in SEVERAL orgs acts only where x-org-id selects a seat they hold', async () => {
    const other: OrgSummary = { id: OTHER_ORG_ID, name: 'Globex', role: 'viewer', slug: 'globex' }
    const twoSeats = { ...member, orgs: [ORG, other] }
    await expect((await callerFor(twoSeats, untouchableDb)).probe.actingOrg()).resolves.toEqual(
      denied,
    )
    const selected = await callerFor(twoSeats, untouchableDb, { 'x-org-id': OTHER_ORG_ID })
    await expect(selected.probe.actingOrg()).resolves.toEqual({
      ok: true,
      data: { orgId: OTHER_ORG_ID },
    })
  })

  it('a caller WITH a seat passes the gate with the RESOLVED org', async () => {
    const caller = await callerFor(member, untouchableDb)
    await expect(caller.probe.actingOrg()).resolves.toEqual({ ok: true, data: { orgId: ORG_ID } })
  })
})

describe('domain failures are values, never throws', () => {
  it('reports an RLS read denial on the data channel as rlsDenied', async () => {
    const caller = await callerFor(
      member,
      fakeDatabase({ profiles: { data: null, error: { code: '42501', message: 'denied' } } }),
    )
    await expect(caller.system.exportMyData({})).resolves.toEqual({
      ok: false,
      // `rlsDenied`, not `forbidden`: the database said no, not the application.
      error: appError.rlsDenied({
        relation: 'profiles',
        message: 'a row-security policy refused the profiles export read',
      }),
    })
  })

  it('keeps the AppError discriminant intact through the transport', async () => {
    // The point of the rule: a thrown TRPCError would flatten these two distinct
    // `kind` discriminants into one HTTP status, and the screen could no longer
    // tell them apart.
    const missing = await (await callerFor(member, fakeDatabase({}))).system.exportMyData({})
    const denied = await (
      await callerFor(
        member,
        fakeDatabase({ profiles: { data: null, error: { code: '42501', message: 'denied' } } }),
      )
    ).system.exportMyData({})
    expect(missing).toEqual({ ok: false, error: appError.notFound({ resource: 'profile' }) })
    expect(denied.ok).toBe(false)
    expect(missing).not.toEqual(denied)
  })

  it('returns the projection on success — the read never leaks a row', async () => {
    const caller = await callerFor(
      member,
      fakeDatabase({ profiles: { data: [PROFILE_ROW], error: null } }),
    )
    await expect(caller.system.exportMyData({})).resolves.toEqual({
      ok: true,
      data: {
        memberships: [],
        profile: { createdAt: WIRE, displayName: 'Sam', id: ACTOR_ID, updatedAt: WIRE },
      },
    })
  })
})

describe('input validation is a CONTRACT violation, not a domain outcome', () => {
  it('throws BAD_REQUEST for input the typed client could not have produced', async () => {
    const caller = await callerFor(member, untouchableDb)
    const groups = caller as unknown as Record<
      string,
      Record<string, (input?: unknown) => Promise<unknown>>
    >
    const thrown: unknown = await groups['system']
      ?.['exportMyData']?.({ orgId: ORG_ID })
      .catch((cause: unknown) => cause)

    expect(thrown).toBeInstanceOf(TRPCError)
    if (!(thrown instanceof TRPCError)) return
    expect(thrown.code).toBe('BAD_REQUEST')
  })
})
