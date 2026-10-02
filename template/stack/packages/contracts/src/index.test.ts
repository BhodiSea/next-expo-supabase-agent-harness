// Pure contract behaviour — bounds, formats, and the closed code sets. These
// tests exercise WIRE semantics only; anything table- or policy-coupled (column
// types, RLS text, an index) belongs to the database suite, and a vertical's
// Record -> View mapping belongs to that vertical's domain tests. Keeping the split
// means a contract test never needs a database and never needs a router.
import { describe, expect, it } from 'vitest'
import {
  ActorView,
  atLeastRole,
  CLIENT_VERSION_HEADER,
  DataExportPage,
  DISPLAY_NAME_MAX,
  EMAIL_MAX,
  EXPORT_MEMBERSHIPS_LIMIT,
  ExportMyDataSchema,
  HealthReport,
  MembershipExport,
  ORG_ROLE_RANK,
  ORG_SLUG_MAX,
  OrgRole,
  OrgSlug,
  type OrgSummary,
  ProfileExport,
  TransportErrorCode,
  WireTimestamp,
} from './index.js'

const OWNER_ID = '9b2b1c7e-2a44-4a3e-8f5d-6c1a2b3c4d5e'
const ORG_ID = '5c2b1c7e-2a44-4a3e-8f5d-6c1a2b3c4d5f'
const OTHER_ORG_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

describe('WireTimestamp', () => {
  it('keeps the driver text verbatim, microseconds and all', () => {
    // The exact string survives parsing: keyset cursors compare it back against
    // the column, so a millisecond-truncating round trip would skip rows.
    const micro = '2026-01-01T00:00:00.123456+00:00'
    expect(WireTimestamp.parse(micro)).toBe(micro)
    expect(WireTimestamp.parse('2026-01-01 00:00:00+00')).toBe('2026-01-01 00:00:00+00')
  })

  it('rejects anything that is not a timestamp', () => {
    expect(() => WireTimestamp.parse('yesterday')).toThrow()
    expect(() => WireTimestamp.parse('2026-01-01')).toThrow()
    expect(() => WireTimestamp.parse('')).toThrow()
  })
})

describe('actor and orgs', () => {
  const ORG: OrgSummary = { id: ORG_ID, name: 'Acme', role: 'owner', slug: 'acme' }

  it('models "authenticated but seatless" as a reachable state', () => {
    // A user mid-invitation, or one whose last seat was revoked. If this failed to
    // parse, the only screen they could ever see would be a crash screen.
    const stranger: ActorView = {
      activeOrg: null,
      displayName: 'Sam',
      email: 'sam@example.test',
      id: OWNER_ID,
      orgs: [],
    }
    expect(ActorView.parse(stranger)).toEqual(stranger)
  })

  it('models a caller in several orgs with one of them active', () => {
    const other: OrgSummary = { id: OTHER_ORG_ID, name: 'Globex', role: 'viewer', slug: 'globex' }
    const multi: ActorView = {
      activeOrg: ORG,
      displayName: 'Sam',
      email: null,
      id: OWNER_ID,
      orgs: [ORG, other],
    }
    expect(ActorView.parse(multi)).toEqual(multi)
  })

  it('bounds the identity strings', () => {
    const base = { activeOrg: null, displayName: 'Sam', email: null, id: OWNER_ID, orgs: [] }
    expect(() =>
      ActorView.parse({ ...base, email: `${'x'.repeat(EMAIL_MAX)}@example.test` }),
    ).toThrow()
    const tooLong = { ...base, displayName: 'x'.repeat(DISPLAY_NAME_MAX + 1) }
    expect(() => ActorView.parse(tooLong)).toThrow()
    expect(() => ActorView.parse({ ...base, displayName: '' })).toThrow()
  })

  it('keeps the role set closed — an unknown role must fail parsing, not default', () => {
    expect(OrgRole.options).toEqual(['viewer', 'member', 'admin', 'owner'])
    expect(() => OrgRole.parse('superuser')).toThrow()
    expect(() => OrgRole.parse('')).toThrow()
  })

  it('carries a rank for EVERY role — a missing one silently disables a feature', () => {
    // ORG_ROLE_RANK is typed Record<OrgRole, number>, so this is belt-and-braces
    // against a cast; the failure it guards is `undefined >= 30` reading false and
    // hiding an action the database would have allowed.
    for (const role of OrgRole.options) {
      expect(Number.isInteger(ORG_ROLE_RANK[role])).toBe(true)
    }
    // The scale must MATCH tools/tenancy.json, which the tenancy gate holds every
    // policy rank floor against. Drift here is a UI offering an action the database
    // refuses, or hiding one it would have allowed.
    expect(ORG_ROLE_RANK).toEqual({ viewer: 10, member: 20, admin: 30, owner: 40 })
  })

  it('orders roles by rank, not by declaration', () => {
    expect(atLeastRole('admin', 'member')).toBe(true)
    expect(atLeastRole('admin', 'admin')).toBe(true)
    expect(atLeastRole('member', 'admin')).toBe(false)
    expect(atLeastRole('viewer', 'member')).toBe(false)
  })

  it('anchors the org slug at BOTH ends — a loose tail is a near-miss that matches', () => {
    expect(OrgSlug.parse('acme')).toBe('acme')
    expect(OrgSlug.parse('acme-corp-2')).toBe('acme-corp-2')
    expect(() => OrgSlug.parse('Acme')).toThrow()
    expect(() => OrgSlug.parse('-acme')).toThrow()
    expect(() => OrgSlug.parse('acme-')).toThrow()
    expect(() => OrgSlug.parse('acme/../globex')).toThrow()
    expect(() => OrgSlug.parse('a')).toThrow()
    expect(() => OrgSlug.parse('a'.repeat(ORG_SLUG_MAX + 1))).toThrow()
  })
})

describe('transport contract', () => {
  it('pins the client-version header spelling shared by both ends of the wire', () => {
    expect(CLIENT_VERSION_HEADER).toBe('x-client-version')
    // Header names are compared lowercased everywhere; a capitalised literal
    // here would silently miss on a Headers.get() lookup.
    expect(CLIENT_VERSION_HEADER).toBe(CLIENT_VERSION_HEADER.toLowerCase())
  })

  it('keeps the transport code set closed and disjoint from domain failures', () => {
    // The whole set, pinned by value. Each member is a condition rejected BEFORE any
    // handler runs, which is what makes them transport facts rather than domain
    // outcomes — and `rate_limited` earns its place structurally: it is decided in
    // middleware, and middleware has no data channel to return an envelope on.
    expect(TransportErrorCode.options).toEqual(['rate_limited', 'unauthorized', 'version_skew'])
    // Domain failures ride the envelope and must never be spellable here: a `not_found`
    // on this channel would be a screen losing the discriminant it switches on.
    expect(() => TransportErrorCode.parse('not_found')).toThrow()
    expect(() => TransportErrorCode.parse('internal')).toThrow()
    expect(() => TransportErrorCode.parse('conflict')).toThrow()
  })

  it('locks the health contract: ok is a literal true, never a boolean', () => {
    const report = { ok: true, version: '0.1.0' }
    expect(HealthReport.parse(report)).toEqual(report)
    expect(() => HealthReport.parse({ ok: false, version: '0.1.0' })).toThrow()
    expect(() => HealthReport.parse({ ok: true, version: '' })).toThrow()
  })
})

describe('data export (DSR portability)', () => {
  const wire = '2026-01-01T00:00:00.123456+00:00'
  const profile = { createdAt: wire, displayName: 'Sam', id: OWNER_ID, updatedAt: wire }
  const membership = { createdAt: wire, orgId: ORG_ID, roleRank: 40, userId: OWNER_ID }
  const page: DataExportPage = { memberships: [membership], profile }

  it('accepts the reviewed projection shape and nothing unbounded', () => {
    expect(DataExportPage.parse(page)).toEqual(page)
    expect(() =>
      DataExportPage.parse({
        ...page,
        profile: { ...profile, displayName: 'x'.repeat(DISPLAY_NAME_MAX + 1) },
      }),
    ).toThrow()
  })

  it('an empty display name PARSES — the export returns the stored value, not a prettier one', () => {
    // Unlike ActorView.displayName (min(1), a render contract), the export is
    // a portability contract: the column default is '' and an account that
    // never set a name must still be exportable.
    expect(ProfileExport.parse({ ...profile, displayName: '' }).displayName).toBe('')
  })

  it('keeps the rank mirror closed to the tenancy ladder', () => {
    // memberships_rank_known CHECK (role_rank IN (10, 20, 30, 40)) — a rank
    // outside the ladder is drift the export must fail loudly on, not archive.
    expect(() => MembershipExport.parse({ ...membership, roleRank: 50 })).toThrow()
  })

  it('bounds the memberships array', () => {
    const seats = Array.from({ length: EXPORT_MEMBERSHIPS_LIMIT + 1 }, () => membership)
    expect(() => DataExportPage.parse({ ...page, memberships: seats })).toThrow()
  })

  it('the input takes nothing — no org field, and an invented field is a parse failure', () => {
    expect(ExportMyDataSchema.parse({})).toEqual({})
    // The export reads the VERIFIED caller's own rows; an orgId payload field
    // would let the request name its own tenant, which the whole file forbids
    // (see ORG_ID_HEADER), and .strict() refuses it rather than dropping it.
    expect(() => ExportMyDataSchema.parse({ orgId: ORG_ID })).toThrow()
  })
})
