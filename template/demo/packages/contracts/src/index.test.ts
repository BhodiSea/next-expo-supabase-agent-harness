// Pure contract behaviour — bounds, formats, and the closed code sets. These
// tests exercise WIRE semantics only; anything table- or policy-coupled (column
// types, RLS text, the keyset index) belongs to the database suite, and the
// Record -> View mapping belongs to @app/notes' domain tests. Keeping the split
// means a contract test never needs a database and never needs a router.
import { describe, expect, it } from 'vitest'
import {
  ActorView,
  atLeastRole,
  CLIENT_VERSION_HEADER,
  DataExportPage,
  DISPLAY_NAME_MAX,
  EMAIL_MAX,
  EXPORT_CURSOR_MAX,
  EXPORT_MEMBERSHIPS_LIMIT,
  ExportMyDataSchema,
  HealthReport,
  MembershipExport,
  NewNoteInput,
  NOTE_BODY_MAX,
  NOTE_EXCERPT_MAX,
  NOTE_TITLE_MAX,
  NOTES_CURSOR_MAX,
  NOTES_PAGE_LIMIT_DEFAULT,
  NOTES_PAGE_LIMIT_MAX,
  NoteDeletion,
  NoteRecord,
  NoteRef,
  NotesListQuery,
  NotesPage,
  NoteUpdateInput,
  NoteView,
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
const NOTE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const ORG_ID = '5c2b1c7e-2a44-4a3e-8f5d-6c1a2b3c4d5f'

const record: NoteRecord = {
  archivedAt: null,
  body: '',
  createdAt: '2026-01-01T00:00:00.123456+00:00',
  id: NOTE_ID,
  ownerId: OWNER_ID,
  title: 'RLS smoke note',
  updatedAt: '2026-01-01T00:00:00.123456+00:00',
}

const view: NoteView = {
  createdAt: record.createdAt,
  excerpt: '',
  hasBody: false,
  id: NOTE_ID,
  isArchived: false,
  title: 'RLS smoke note',
  updatedAt: record.updatedAt,
}

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

describe('NoteRecord', () => {
  it('round-trips the persisted shape', () => {
    expect(NoteRecord.parse(record)).toEqual(record)
  })

  it('carries a nullable archivedAt (lifecycle is a column, not a second table)', () => {
    const archived = { ...record, archivedAt: '2026-02-02T09:00:00+00:00' }
    expect(NoteRecord.parse(archived).archivedAt).toBe('2026-02-02T09:00:00+00:00')
  })

  it('bounds every wire string (no unbounded input)', () => {
    expect(() => NoteRecord.parse({ ...record, title: 'x'.repeat(NOTE_TITLE_MAX + 1) })).toThrow()
    expect(() => NoteRecord.parse({ ...record, body: 'x'.repeat(NOTE_BODY_MAX + 1) })).toThrow()
    expect(NoteRecord.parse({ ...record, title: 'x'.repeat(NOTE_TITLE_MAX) }).title).toHaveLength(
      NOTE_TITLE_MAX,
    )
  })

  it('rejects an empty title and a non-uuid id', () => {
    expect(() => NoteRecord.parse({ ...record, title: '' })).toThrow()
    expect(() => NoteRecord.parse({ ...record, id: 'note-1' })).toThrow()
  })
})

describe('NoteView', () => {
  it('round-trips the render shape', () => {
    expect(NoteView.parse(view)).toEqual(view)
  })

  it('does NOT carry ownerId — the render shape leaks no identifiers', () => {
    const withOwner = NoteView.parse({ ...view, ownerId: OWNER_ID })
    expect(withOwner).not.toHaveProperty('ownerId')
  })

  it('bounds the excerpt so neither surface has to re-truncate', () => {
    expect(NoteView.parse({ ...view, excerpt: 'x'.repeat(NOTE_EXCERPT_MAX) })).toBeTruthy()
    expect(() => NoteView.parse({ ...view, excerpt: 'x'.repeat(NOTE_EXCERPT_MAX + 1) })).toThrow()
  })
})

describe('write inputs', () => {
  it('accepts client fields only in NewNoteInput and rejects an empty title', () => {
    expect(NewNoteInput.parse({ body: 'world', title: 'hello' })).toEqual({
      body: 'world',
      title: 'hello',
    })
    expect(NewNoteInput.parse({ title: 'body is optional' })).toEqual({ title: 'body is optional' })
    expect(() => NewNoteInput.parse({ title: '' })).toThrow()
  })

  it('never accepts ownerId from the wire', () => {
    // Stripped, not honoured: an owner-bearing create input is an
    // account-takeover primitive dressed as a convenience.
    expect(NewNoteInput.parse({ ownerId: OWNER_ID, title: 'x' })).toEqual({ title: 'x' })
  })

  it('rejects an empty patch (a no-op UPDATE still bumps updated_at)', () => {
    expect(NoteUpdateInput.parse({ id: NOTE_ID, title: 'renamed' })).toEqual({
      id: NOTE_ID,
      title: 'renamed',
    })
    expect(NoteUpdateInput.parse({ id: NOTE_ID, isArchived: true }).isArchived).toBe(true)
    expect(NoteUpdateInput.parse({ body: '', id: NOTE_ID }).body).toBe('')
    expect(() => NoteUpdateInput.parse({ id: NOTE_ID })).toThrow()
  })

  it('bounds the patch fields exactly as the record bounds them', () => {
    expect(() =>
      NoteUpdateInput.parse({ id: NOTE_ID, title: 'x'.repeat(NOTE_TITLE_MAX + 1) }),
    ).toThrow()
    expect(() =>
      NoteUpdateInput.parse({ body: 'x'.repeat(NOTE_BODY_MAX + 1), id: NOTE_ID }),
    ).toThrow()
  })

  it('locks the single-note addressing shapes', () => {
    expect(NoteRef.parse({ id: NOTE_ID })).toEqual({ id: NOTE_ID })
    expect(NoteDeletion.parse({ id: NOTE_ID })).toEqual({ id: NOTE_ID })
    expect(() => NoteRef.parse({ id: '1' })).toThrow()
  })
})

describe('keyset pagination', () => {
  it('defaults the page size and the archived filter', () => {
    expect(NotesListQuery.parse({})).toEqual({
      includeArchived: false,
      limit: NOTES_PAGE_LIMIT_DEFAULT,
    })
  })

  it('coerces a string limit (query strings are strings) inside the bounds', () => {
    expect(NotesListQuery.parse({ cursor: 'abc_-123', limit: '25' })).toEqual({
      cursor: 'abc_-123',
      includeArchived: false,
      limit: 25,
    })
    expect(() => NotesListQuery.parse({ limit: String(NOTES_PAGE_LIMIT_MAX + 1) })).toThrow()
    expect(() => NotesListQuery.parse({ limit: '0' })).toThrow()
    expect(() => NotesListQuery.parse({ limit: '1.5' })).toThrow()
  })

  it('accepts only base64url cursors, bounded', () => {
    expect(() => NotesListQuery.parse({ cursor: 'not+base64url!' })).toThrow()
    expect(() => NotesListQuery.parse({ cursor: 'x'.repeat(NOTES_CURSOR_MAX + 1) })).toThrow()
    expect(() => NotesListQuery.parse({ cursor: '' })).toThrow()
  })

  it('locks the page envelope', () => {
    const page = { items: [view], nextCursor: null }
    expect(NotesPage.parse(page)).toEqual(page)
    expect(NotesPage.parse({ items: [], nextCursor: 'abc' }).nextCursor).toBe('abc')
    expect(() =>
      NotesPage.parse({
        items: Array.from({ length: NOTES_PAGE_LIMIT_MAX + 1 }, () => view),
        nextCursor: null,
      }),
    ).toThrow()
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
    const other: OrgSummary = { id: NOTE_ID, name: 'Globex', role: 'viewer', slug: 'globex' }
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
  const exportedNote = {
    body: 'hello',
    createdAt: wire,
    id: NOTE_ID,
    orgId: ORG_ID,
    title: 'a note',
    updatedAt: wire,
  }
  const page: DataExportPage = {
    memberships: [membership],
    notes: { items: [exportedNote], nextCursor: null },
    profile,
  }

  it('accepts the reviewed projection shape and nothing unbounded', () => {
    expect(DataExportPage.parse(page)).toEqual(page)
    // Every string on the page is bounded — the body bound is the biggest and
    // therefore the one worth pinning: one char over NOTE_BODY_MAX fails.
    const oversize = { ...exportedNote, body: 'x'.repeat(NOTE_BODY_MAX + 1) }
    expect(() =>
      DataExportPage.parse({ ...page, notes: { items: [oversize], nextCursor: null } }),
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

  it('bounds the page arrays and the compound cursor', () => {
    const notes = { items: [exportedNote], nextCursor: 'A'.repeat(EXPORT_CURSOR_MAX + 1) }
    expect(() => DataExportPage.parse({ ...page, notes })).toThrow()
    const seats = Array.from({ length: EXPORT_MEMBERSHIPS_LIMIT + 1 }, () => membership)
    expect(() => DataExportPage.parse({ ...page, memberships: seats })).toThrow()
  })

  it('the input takes only an opaque cursor and a clamped limit — no org field exists to send', () => {
    expect(ExportMyDataSchema.parse({})).toEqual({ limit: NOTES_PAGE_LIMIT_DEFAULT })
    expect(() => ExportMyDataSchema.parse({ cursor: 'not base64url!' })).toThrow()
    expect(() => ExportMyDataSchema.parse({ limit: NOTES_PAGE_LIMIT_MAX + 1 })).toThrow()
    // The walk position travels INSIDE the opaque cursor; an orgId payload
    // field would let the request name its own tenant, which the whole file
    // forbids (see ORG_ID_HEADER).
    expect('orgId' in ExportMyDataSchema.shape).toBe(false)
  })
})
