import { DataExportPage, EXPORT_MEMBERSHIPS_LIMIT, type OrgSummary } from '@app/contracts'
import { appError } from '@app/errors'
import type { NotesDatabase, PostgrestOutcome, PostgrestQuery, PostgrestTable } from '@app/notes'
import { decodeNotesExportCursor, encodeNotesExportCursor } from '@app/notes'
import { TRPCError } from '@trpc/server'
import { describe, expect, it } from 'vitest'
import { createContext, type Session } from '../context.js'
import { appRouter } from '../index.js'
import { createCallerFactory } from '../trpc.js'

// ---------------------------------------------------------------------------
// `system.exportMyData` — the DSR portability surface, asserted end to end
// through the real router against a scripted PostgREST port.
//
// THE HEADLINE IS THE AUTHORED-ONLY INVARIANT. RLS admits every ORG-MATE's
// notes to this caller, so `owner_id = <the verified actor>` in the query is
// the ONE line between "the subject's archive" and "the whole org's content
// copied into one member's personal archive" — and it is application logic no
// RLS suite can see. The proof RECORDS the filters the DAL builds (the same
// technique the org-gate wiring test uses) rather than trusting the source.
//
// RLS ISOLATION IS INHERITED, NOT DUPLICATED: the procedure runs as the
// caller, so tests/rls/cross-tenant-isolation.test.ts — tenant B cannot read
// A's profile or notes — already bounds everything this surface can return.
// What that suite CANNOT prove is the authored-only projection above, which is
// exactly what this file pins.
// ---------------------------------------------------------------------------

const SERVER_VERSION = '1.2.3'
const ACTOR_ID = '9b2b1c7e-2a44-4a3e-8f5d-6c1a2b3c4d5e'
// Sorted walk order is lexicographic on the org id, so A < B by construction.
const ORG_A_ID = '11111111-2a44-4a3e-8f5d-6c1a2b3c4d51'
const ORG_B_ID = '22222222-2a44-4a3e-8f5d-6c1a2b3c4d52'
const GONE_ORG_ID = '00000000-2a44-4a3e-8f5d-6c1a2b3c4d50'
const TS = '2026-01-01T00:00:00.000000+00:00'

const ORG_A: OrgSummary = { id: ORG_A_ID, name: 'Acme', role: 'owner', slug: 'acme' }
const ORG_B: OrgSummary = { id: ORG_B_ID, name: 'Globex', role: 'member', slug: 'globex' }

const oneOrgMember: Session = {
  actor: { displayName: 'Sam', email: 'sam@example.test', userId: ACTOR_ID },
  orgs: [ORG_A],
}
const twoOrgMember: Session = { actor: oneOrgMember.actor, orgs: [ORG_A, ORG_B] }
const seatless: Session = { actor: oneOrgMember.actor, orgs: [] }

const PROFILE_ROW = {
  created_at: TS,
  display_name: 'Sam',
  id: ACTOR_ID,
  updated_at: TS,
}

const MEMBERSHIP_ROW = {
  created_at: TS,
  org_id: ORG_A_ID,
  role_rank: 40,
  user_id: ACTOR_ID,
}

/** An export-projection notes row (id, org_id, title, body, created_at, updated_at). */
function noteRow(id: string, orgId: string, createdAt = TS) {
  return {
    body: 'hello world',
    created_at: createdAt,
    id,
    org_id: orgId,
    title: 'note',
    updated_at: TS,
  }
}

const NOTE_1 = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const NOTE_2 = '3f2504e0-4f89-41d3-9a0c-0305e82c3302'
const NOTE_3 = '3f2504e0-4f89-41d3-9a0c-0305e82c3303'

type Call = [method: string, ...args: unknown[]]

/**
 * A PostgREST port scripted PER TABLE — each `from(table)` consumes the next
 * outcome queued for that table and records every builder call under the
 * table's name, so a test can assert exactly what each read asked for.
 */
function exportDatabase(script: Record<string, PostgrestOutcome[]>): {
  calls: Map<string, Call[]>
  db: NotesDatabase
} {
  const calls = new Map<string, Call[]>()
  const queues = new Map(Object.entries(script).map(([table, list]) => [table, [...list]]))
  const db: NotesDatabase = {
    from(table: string): PostgrestTable {
      const log = calls.get(table) ?? []
      calls.set(table, log)
      const outcome = queues.get(table)?.shift() ?? { data: [], error: null }
      const record = (method: string, ...args: unknown[]): void => {
        log.push([method, ...args])
      }
      const query: PostgrestQuery = Object.assign(Promise.resolve(outcome), {
        eq: (column: string, value: string): PostgrestQuery => {
          record('eq', column, value)
          return query
        },
        is: (column: string, value: null): PostgrestQuery => {
          record('is', column, value)
          return query
        },
        limit: (count: number): PostgrestQuery => {
          record('limit', count)
          return query
        },
        lte: (column: string, value: string): PostgrestQuery => {
          record('lte', column, value)
          return query
        },
        or: (filters: string): PostgrestQuery => {
          record('or', filters)
          return query
        },
        order: (column: string, options: { readonly ascending: boolean }): PostgrestQuery => {
          record('order', column, options)
          return query
        },
        select: (columns: string): PostgrestQuery => {
          record('select', columns)
          return query
        },
      })
      return {
        delete: (): PostgrestQuery => {
          record('delete')
          return query
        },
        insert: (values: Readonly<Record<string, unknown>>): PostgrestQuery => {
          record('insert', values)
          return query
        },
        select: (columns: string): PostgrestQuery => {
          record('select', columns)
          return query
        },
        update: (values: Readonly<Record<string, unknown>>): PostgrestQuery => {
          record('update', values)
          return query
        },
      }
    },
  }
  return { calls, db }
}

/** The happy-path script: one profile row, one seat, one page of notes. */
function happyScript(
  notes: PostgrestOutcome[] = [{ data: [noteRow(NOTE_1, ORG_A_ID)], error: null }],
) {
  return {
    memberships: [{ data: [MEMBERSHIP_ROW], error: null }],
    notes,
    profiles: [{ data: [PROFILE_ROW], error: null }],
  }
}

async function callerFor(session: Session | null, db: NotesDatabase) {
  const ctx = await createContext({
    createClient: () => db,
    headers: session === null ? {} : { authorization: 'Bearer test-token' },
    resolveSession: () => Promise.resolve(session),
    serverVersion: SERVER_VERSION,
  })
  return createCallerFactory(appRouter)(ctx)
}

describe('the authored-only invariant — the one filter RLS does not provide', () => {
  it('filters notes on owner_id = the VERIFIED caller, in the query itself', async () => {
    // THE RED-PROOF for the invariant: RLS admits org-mates' notes, so an
    // implementation missing this eq() returns a green page of somebody
    // else's data and no other suite in the repo can tell.
    const { calls, db } = exportDatabase(happyScript())
    const caller = await callerFor(oneOrgMember, db)
    await caller.system.exportMyData({})
    expect(calls.get('notes')).toContainEqual(['eq', 'owner_id', ACTOR_ID])
    expect(calls.get('notes')).toContainEqual(['eq', 'org_id', ORG_A_ID])
  })

  it('keeps the filter on a cursor resume — the seek page is not a second code path', async () => {
    const resume = encodeNotesExportCursor({ note: null, orgId: ORG_A_ID })
    const { calls, db } = exportDatabase(happyScript())
    const caller = await callerFor(oneOrgMember, db)
    await caller.system.exportMyData({ cursor: resume })
    expect(calls.get('notes')).toContainEqual(['eq', 'owner_id', ACTOR_ID])
  })
})

describe('page bounds', () => {
  it('respects the requested limit and probes has-more with ONE sentinel row', async () => {
    const rows = [noteRow(NOTE_1, ORG_A_ID), noteRow(NOTE_2, ORG_A_ID), noteRow(NOTE_3, ORG_A_ID)]
    const { calls, db } = exportDatabase(happyScript([{ data: rows, error: null }]))
    const caller = await callerFor(oneOrgMember, db)
    const outcome = await caller.system.exportMyData({ limit: 2 })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.notes.items).toHaveLength(2)
    expect(outcome.data.notes.nextCursor).not.toBeNull()
    expect(calls.get('notes')).toContainEqual(['limit', 3])
  })

  it('bounds the memberships read unconditionally', async () => {
    const { calls, db } = exportDatabase(happyScript())
    const caller = await callerFor(oneOrgMember, db)
    await caller.system.exportMyData({})
    expect(calls.get('memberships')).toContainEqual(['limit', EXPORT_MEMBERSHIPS_LIMIT])
  })
})

describe('the compound cursor round-trips', () => {
  it('resumes INSIDE an org: page 2 seeks from where page 1 stopped', async () => {
    const rows = [noteRow(NOTE_1, ORG_A_ID), noteRow(NOTE_2, ORG_A_ID), noteRow(NOTE_3, ORG_A_ID)]
    const first = await (
      await callerFor(oneOrgMember, exportDatabase(happyScript([{ data: rows, error: null }])).db)
    ).system.exportMyData({ limit: 2 })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const token = first.data.notes.nextCursor
    expect(token).not.toBeNull()
    if (token === null) return
    // The token names the SAME org with a non-null inner keyset.
    expect(decodeNotesExportCursor(token)).toMatchObject({ orgId: ORG_A_ID })

    const { calls, db } = exportDatabase(
      happyScript([{ data: [noteRow(NOTE_3, ORG_A_ID)], error: null }]),
    )
    const second = await (await callerFor(oneOrgMember, db)).system.exportMyData({
      cursor: token,
      limit: 2,
    })
    expect(second.ok).toBe(true)
    // The resumed page carries the RANGE half of the seek — the O(1)-per-page form.
    expect(calls.get('notes')?.some(([method]) => method === 'lte')).toBe(true)
    expect(calls.get('notes')?.some(([method]) => method === 'or')).toBe(true)
  })

  it('walks org to org: a drained org hands the cursor to the NEXT held org', async () => {
    const { db } = exportDatabase(happyScript([{ data: [noteRow(NOTE_1, ORG_A_ID)], error: null }]))
    const first = await (await callerFor(twoOrgMember, db)).system.exportMyData({ limit: 50 })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const token = first.data.notes.nextCursor
    expect(token).not.toBeNull()
    if (token === null) return
    expect(decodeNotesExportCursor(token)).toEqual({ note: null, orgId: ORG_B_ID })

    const { calls, db: db2 } = exportDatabase(happyScript([{ data: [], error: null }]))
    const second = await (await callerFor(twoOrgMember, db2)).system.exportMyData({ cursor: token })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(calls.get('notes')).toContainEqual(['eq', 'org_id', ORG_B_ID])
    // Last held org drained: the walk ends.
    expect(second.data.notes.nextCursor).toBeNull()
  })

  it('a cursor naming an org the caller NO LONGER holds resumes at the next held org', async () => {
    // The org id in the token is a selector, resolved against the REAL seat
    // list — a lost seat is skipped (RLS would return nothing for it anyway),
    // never read and never an error that discloses why.
    const stale = encodeNotesExportCursor({ note: null, orgId: GONE_ORG_ID })
    const { calls, db } = exportDatabase(happyScript())
    const outcome = await (await callerFor(oneOrgMember, db)).system.exportMyData({ cursor: stale })
    expect(outcome.ok).toBe(true)
    expect(calls.get('notes')).toContainEqual(['eq', 'org_id', ORG_A_ID])
    expect(calls.get('notes')).not.toContainEqual(['eq', 'org_id', GONE_ORG_ID])
  })

  it('rejects a cursor this server did not mint, on the data channel', async () => {
    const { db } = exportDatabase(happyScript())
    const outcome = await (await callerFor(oneOrgMember, db)).system.exportMyData({
      cursor: 'not-a-real-token',
    })
    expect(outcome).toEqual({
      ok: false,
      error: appError.validation({
        code: 'invalid_cursor',
        fields: ['cursor'],
        message: 'the page cursor is not one this server minted',
      }),
    })
  })
})

describe('the envelope', () => {
  it('rejects an anonymous caller with the transport UNAUTHORIZED, before any read', async () => {
    const untouchable: NotesDatabase = {
      from: () => {
        throw new Error('the auth rung must reject before any query is built')
      },
    }
    const caller = await callerFor(null, untouchable)
    const thrown: unknown = await caller.system.exportMyData({}).catch((cause: unknown) => cause)
    expect(thrown).toBeInstanceOf(TRPCError)
    if (!(thrown instanceof TRPCError)) return
    expect(thrown.code).toBe('UNAUTHORIZED')
  })

  it('returns a page the CONTRACT accepts, camelCased at the row boundary', async () => {
    const { db } = exportDatabase(happyScript())
    const outcome = await (await callerFor(oneOrgMember, db)).system.exportMyData({})
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // The whole page re-parses against the wire DTO — the closure that keeps
    // this suite honest about the shape, not merely about the values.
    expect(() => DataExportPage.parse(outcome.data)).not.toThrow()
    expect(outcome.data.profile).toEqual({
      createdAt: TS,
      displayName: 'Sam',
      id: ACTOR_ID,
      updatedAt: TS,
    })
    expect(outcome.data.memberships).toEqual([
      { createdAt: TS, orgId: ORG_A_ID, roleRank: 40, userId: ACTOR_ID },
    ])
  })

  it('a seatless caller still gets their profile — and an ended notes walk, not an error', async () => {
    const { calls, db } = exportDatabase({
      memberships: [{ data: [], error: null }],
      profiles: [{ data: [PROFILE_ROW], error: null }],
    })
    const outcome = await (await callerFor(seatless, db)).system.exportMyData({})
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.memberships).toEqual([])
    expect(outcome.data.notes).toEqual({ items: [], nextCursor: null })
    expect(calls.get('notes')).toBeUndefined()
  })

  it('maps a store failure to the envelope — retryable class reads as unavailable', async () => {
    const { db } = exportDatabase({
      profiles: [{ data: null, error: { code: '57014', message: 'canceled' } }],
    })
    const outcome = await (await callerFor(oneOrgMember, db)).system.exportMyData({})
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error.kind).toBe('unavailable')
  })

  it('maps an RLS refusal to rlsDenied — the database said no, not the application', async () => {
    const { db } = exportDatabase({
      memberships: [{ data: null, error: { code: '42501', message: 'denied' } }],
      profiles: [{ data: [PROFILE_ROW], error: null }],
    })
    const outcome = await (await callerFor(oneOrgMember, db)).system.exportMyData({})
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error.kind).toBe('rlsDenied')
  })

  it('reports a drifted row as contract drift, never a parse throw across the wire', async () => {
    const { db } = exportDatabase({
      ...happyScript(),
      profiles: [{ data: [{ ...PROFILE_ROW, created_at: 'not-a-timestamp' }], error: null }],
    })
    const outcome = await (await callerFor(oneOrgMember, db)).system.exportMyData({})
    expect(outcome).toEqual({
      ok: false,
      error: appError.unknown({
        code: 'contract_drift',
        message: 'a profiles row did not match its contract during the export',
      }),
    })
  })

  it('a signed-in caller with NO profiles row is notFound — drift the server must report', async () => {
    const { db } = exportDatabase({ ...happyScript(), profiles: [{ data: [], error: null }] })
    const outcome = await (await callerFor(oneOrgMember, db)).system.exportMyData({})
    expect(outcome).toEqual({ ok: false, error: appError.notFound({ resource: 'profile' }) })
  })
})
