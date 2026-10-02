import { DataExportPage, EXPORT_MEMBERSHIPS_LIMIT, type OrgSummary } from '@app/contracts'
import { appError } from '@app/errors'
import { TRPCError } from '@trpc/server'
import { describe, expect, it } from 'vitest'
import type { ApiDatabase, StoreOutcome, StoreQuery, StoreTable } from '../context.js'
import { createContext, type Session } from '../context.js'
import { appRouter } from '../index.js'
import { createCallerFactory } from '../trpc.js'

// ---------------------------------------------------------------------------
// `system.exportMyData` — the DSR portability surface, asserted end to end
// through the real router against a scripted PostgREST port.
//
// RLS ISOLATION IS INHERITED, NOT DUPLICATED: the procedure runs as the
// caller, so tests/rls/cross-tenant-isolation.test.ts — tenant B cannot read
// A's profile — already bounds everything this surface can return. What that
// suite cannot prove is the projection itself (which columns, which filter,
// which order) and the failure taxonomy, which is exactly what this file pins
// by RECORDING the builder calls each read makes rather than trusting the source.
// A vertical that adds a section to the export adds its own cases here (the
// --with-demo notes vertical's authored-only invariant is the worked example).
// ---------------------------------------------------------------------------

const SERVER_VERSION = '1.2.3'
const ACTOR_ID = '9b2b1c7e-2a44-4a3e-8f5d-6c1a2b3c4d5e'
const ORG_A_ID = '11111111-2a44-4a3e-8f5d-6c1a2b3c4d51'
const TS = '2026-01-01T00:00:00.000000+00:00'

const ORG_A: OrgSummary = { id: ORG_A_ID, name: 'Acme', role: 'owner', slug: 'acme' }

const oneOrgMember: Session = {
  actor: { displayName: 'Sam', email: 'sam@example.test', userId: ACTOR_ID },
  orgs: [ORG_A],
}
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

type Call = [method: string, ...args: unknown[]]

/**
 * A PostgREST port scripted PER TABLE — each `from(table)` consumes the next
 * outcome queued for that table and records every builder call under the
 * table's name, so a test can assert exactly what each read asked for.
 */
function exportDatabase(script: Record<string, StoreOutcome[]>): {
  calls: Map<string, Call[]>
  db: ApiDatabase
} {
  const calls = new Map<string, Call[]>()
  const queues = new Map(Object.entries(script).map(([table, list]) => [table, [...list]]))
  const db: ApiDatabase = {
    from(table: string): StoreTable {
      const log = calls.get(table) ?? []
      calls.set(table, log)
      const outcome = queues.get(table)?.shift() ?? { data: [], error: null }
      const record = (method: string, ...args: unknown[]): void => {
        log.push([method, ...args])
      }
      const query: StoreQuery = Object.assign(Promise.resolve(outcome), {
        eq: (column: string, value: string): StoreQuery => {
          record('eq', column, value)
          return query
        },
        limit: (count: number): StoreQuery => {
          record('limit', count)
          return query
        },
        order: (column: string, options: { readonly ascending: boolean }): StoreQuery => {
          record('order', column, options)
          return query
        },
        select: (columns: string): StoreQuery => {
          record('select', columns)
          return query
        },
      })
      return {
        select: (columns: string): StoreQuery => {
          record('select', columns)
          return query
        },
      }
    },
  }
  return { calls, db }
}

/** The happy-path script: one profile row, one seat. */
function happyScript() {
  return {
    memberships: [{ data: [MEMBERSHIP_ROW], error: null }],
    profiles: [{ data: [PROFILE_ROW], error: null }],
  }
}

async function callerFor(session: Session | null, db: ApiDatabase) {
  const ctx = await createContext({
    createClient: () => db,
    headers: session === null ? {} : { authorization: 'Bearer test-token' },
    resolveSession: () => Promise.resolve(session),
    serverVersion: SERVER_VERSION,
  })
  return createCallerFactory(appRouter)(ctx)
}

describe('bounds', () => {
  it('bounds the memberships read unconditionally', async () => {
    const { calls, db } = exportDatabase(happyScript())
    await (await callerFor(oneOrgMember, db)).system.exportMyData({})
    expect(calls.get('memberships')).toContainEqual(['limit', EXPORT_MEMBERSHIPS_LIMIT])
  })

  it('reads the profile row through a LIMIT 1 on the primary key', async () => {
    const { calls, db } = exportDatabase(happyScript())
    await (await callerFor(oneOrgMember, db)).system.exportMyData({})
    expect(calls.get('profiles')).toContainEqual(['limit', 1])
  })
})

describe('the envelope', () => {
  it('rejects an anonymous caller with the transport UNAUTHORIZED, before any read', async () => {
    const untouchable: ApiDatabase = {
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

  it('a seatless caller still gets their profile and an empty seat list, not an error', async () => {
    const { db } = exportDatabase({
      memberships: [{ data: [], error: null }],
      profiles: [{ data: [PROFILE_ROW], error: null }],
    })
    const outcome = await (await callerFor(seatless, db)).system.exportMyData({})
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.memberships).toEqual([])
    expect(outcome.data.profile.id).toBe(ACTOR_ID)
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

describe('the projections and filters each read sends (mutation kills)', () => {
  it('profiles: the reviewed projection verbatim, positioned on the PK', async () => {
    // tools/data-flow.json export.projection.profiles — a projection that drifts to ''
    // is select('') and a page whose columns nobody reviewed.
    const { calls, db } = exportDatabase(happyScript())
    await (await callerFor(oneOrgMember, db)).system.exportMyData({})
    expect(calls.get('profiles')).toContainEqual([
      'select',
      'id, display_name, created_at, updated_at',
    ])
    expect(calls.get('profiles')).toContainEqual(['eq', 'id', ACTOR_ID])
  })

  it('memberships: the reviewed projection, self-filtered, in stable org order', async () => {
    // The user_id filter positions the PK scan; the org_id ASC order is what makes
    // the export byte-stable across runs. Each half is asserted verbatim.
    const { calls, db } = exportDatabase(happyScript())
    await (await callerFor(oneOrgMember, db)).system.exportMyData({})
    expect(calls.get('memberships')).toContainEqual([
      'select',
      'user_id, org_id, role_rank, created_at',
    ])
    expect(calls.get('memberships')).toContainEqual(['eq', 'user_id', ACTOR_ID])
    expect(calls.get('memberships')).toContainEqual(['order', 'org_id', { ascending: true }])
  })
})

describe('the store-failure taxonomy for the export’s own reads (mutation kills)', () => {
  it('a class-08 connection failure reads as unavailable, naming the relation', async () => {
    const { db } = exportDatabase({
      profiles: [{ data: null, error: { code: '08006', message: 'connection failure' } }],
    })
    const outcome = await (await callerFor(oneOrgMember, db)).system.exportMyData({})
    expect(outcome).toEqual({
      ok: false,
      error: appError.unavailable({
        message: 'the profiles store was unreachable during the export',
      }),
    })
  })

  it('a class-53 shedding failure reads as unavailable too', async () => {
    const { db } = exportDatabase({
      profiles: [{ data: null, error: { code: '53300', message: 'too many connections' } }],
    })
    const outcome = await (await callerFor(oneOrgMember, db)).system.exportMyData({})
    expect(outcome).toEqual({
      ok: false,
      error: appError.unavailable({
        message: 'the profiles store was unreachable during the export',
      }),
    })
  })

  it('a non-retryable rejection is unknown, named export_store_rejected', async () => {
    const { db } = exportDatabase({
      profiles: [{ data: null, error: { code: '22000', message: 'data exception' } }],
    })
    const outcome = await (await callerFor(oneOrgMember, db)).system.exportMyData({})
    expect(outcome).toEqual({
      ok: false,
      error: appError.unknown({
        code: 'export_store_rejected',
        message: 'the profiles store rejected the export read',
      }),
    })
  })

  it('a failure with NO code at all is the same unknown — never a crash on code.slice', async () => {
    // The optional-chain on failure.code is load-bearing: PostgREST failures may
    // carry no SQLSTATE, and a bare .slice would turn that into a 500.
    const { db } = exportDatabase({
      profiles: [{ data: null, error: { message: 'no code' } }],
    })
    const outcome = await (await callerFor(oneOrgMember, db)).system.exportMyData({})
    expect(outcome).toEqual({
      ok: false,
      error: appError.unknown({
        code: 'export_store_rejected',
        message: 'the profiles store rejected the export read',
      }),
    })
  })

  it('an RLS refusal carries the relation and the operator-facing message', async () => {
    const { db } = exportDatabase({
      memberships: [{ data: null, error: { code: '42501', message: 'denied' } }],
      profiles: [{ data: [PROFILE_ROW], error: null }],
    })
    const outcome = await (await callerFor(oneOrgMember, db)).system.exportMyData({})
    expect(outcome).toEqual({
      ok: false,
      error: appError.rlsDenied({
        relation: 'memberships',
        message: 'a row-security policy refused the memberships export read',
      }),
    })
  })

  it('a memberships row off its contract is export drift, named', async () => {
    const { db } = exportDatabase({
      memberships: [{ data: [{ ...MEMBERSHIP_ROW, role_rank: 'owner' }], error: null }],
      profiles: [{ data: [PROFILE_ROW], error: null }],
    })
    const outcome = await (await callerFor(oneOrgMember, db)).system.exportMyData({})
    expect(outcome).toEqual({
      ok: false,
      error: appError.unknown({
        code: 'contract_drift',
        message: 'a memberships row did not match its contract during the export',
      }),
    })
  })
})
