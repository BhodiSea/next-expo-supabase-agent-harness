// The four notes handlers plus /healthz, driven through app.request with a recording DAL.
// Coverage called these tested — a request that 401s walks none of them, and a request that
// 200s asserted only the status code. What was never pinned is the WIRING, in both
// directions:
//
//   down  — the identity (always the verified subject, never the wire's), the bounded
//           limit, and the DECODED keyset cursor the DAL is handed;
//   back  — 201 + the created row, 200 vs 404 on get, 204 vs 404 on delete.
//
// A handler that dropped the cursor, ignored the limit, or answered 200-with-null instead
// of 404 would break the mobile client's pagination and its empty states, and every
// existing status-only assertion would still be green.
import {
  ApiError,
  type NewNote,
  NOTES_PAGE_LIMIT_DEFAULT,
  type Note,
  NoteDto,
  NotesPage,
  type NotesPageDto,
} from '@app/contracts'
import { describe, expect, it } from 'vitest'
import { type AppOptions, createApp } from './app.js'
import { encodeNotesCursor, type NoteCursorKey } from './dal/cursor.js'
import type { AccountDal, NotesDal } from './types.js'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const NOTE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const authed = { authorization: 'Bearer test-token' }

// createdAt in the Postgres text form at full microsecond precision — the same shape the
// DAL returns, so the cursor round-trip below is the real one.
const stored: Note = {
  body: 'the body',
  createdAt: '2026-01-01 00:00:00.123456+00',
  embedding: null,
  id: NOTE_ID,
  ownerId: USER_ID,
  sourceConfidence: null,
  sourceModel: null,
  title: 'a note',
}

interface DalCalls {
  readonly list: { userId: string; limit: number; cursor: NoteCursorKey | undefined }[]
  readonly create: { userId: string; input: NewNote }[]
  readonly get: { userId: string; id: string }[]
  readonly remove: { userId: string; id: string }[]
  readonly deleteAccount: { userId: string }[]
}

interface DalResults {
  readonly page?: NotesPageDto
  readonly created?: Note
  readonly found?: Note | null
  readonly removed?: boolean
  readonly deletedNotes?: number
}

interface Fixture {
  readonly options: AppOptions
  readonly calls: DalCalls
}

/** A DAL that records every argument the routes hand it and replays canned results. */
function fixture(results: DalResults = {}): Fixture {
  const calls: DalCalls = { list: [], create: [], get: [], remove: [], deleteAccount: [] }
  const notesDal: NotesDal = {
    list: (userId, page) => {
      calls.list.push({ userId, limit: page.limit, cursor: page.cursor })
      return Promise.resolve(results.page ?? { items: [], nextCursor: null })
    },
    create: (userId, input) => {
      calls.create.push({ userId, input })
      return results.created === undefined
        ? Promise.reject(new Error('create was not stubbed for this test'))
        : Promise.resolve(results.created)
    },
    get: (userId, id) => {
      calls.get.push({ userId, id })
      return Promise.resolve(results.found ?? null)
    },
    remove: (userId, id) => {
      calls.remove.push({ userId, id })
      return Promise.resolve(results.removed ?? false)
    },
  }
  const accountDal: AccountDal = {
    deleteAllOwnedData: (userId) => {
      calls.deleteAccount.push({ userId })
      return Promise.resolve({ deletedNotes: results.deletedNotes ?? 0 })
    },
  }
  return {
    options: {
      version: '1.2.3',
      verifyToken: () => Promise.resolve({ userId: USER_ID }),
      notesDal,
      accountDal,
    },
    calls,
  }
}

describe('GET /healthz', () => {
  it('answers { ok: true, version } — the literal the mobile connection indicator polls', async () => {
    const { options } = fixture()

    const res = await createApp(options).request('/healthz')

    expect(res.status).toBe(200)
    // toEqual on the whole body: `ok` must be the literal TRUE (the contract's only legal
    // value) and the version must be the server's, not an empty object shaped like health.
    expect(await res.json()).toEqual({ ok: true, version: '1.2.3' })
  })
})

describe('GET /api/notes — what the route hands the DAL', () => {
  it('passes the identity and the requested limit straight through', async () => {
    const { options, calls } = fixture()

    const res = await createApp(options).request('/api/notes?limit=7', { headers: authed })

    expect(res.status).toBe(200)
    expect(calls.list).toEqual([{ userId: USER_ID, limit: 7, cursor: undefined }])
  })

  it('applies the contract default when no limit is asked for (never an unbounded scan)', async () => {
    const { options, calls } = fixture()

    const res = await createApp(options).request('/api/notes', { headers: authed })

    expect(res.status).toBe(200)
    expect(calls.list[0]?.limit).toBe(NOTES_PAGE_LIMIT_DEFAULT)
  })

  it('DECODES the opaque cursor before the DAL sees it', async () => {
    const key: NoteCursorKey = { createdAt: '2026-01-01 00:00:00.123456+00', id: NOTE_ID }
    const { options, calls } = fixture()

    const res = await createApp(options).request(
      `/api/notes?cursor=${encodeNotesCursor(key)}&limit=2`,
      { headers: authed },
    )

    expect(res.status).toBe(200)
    // The keyset position, not the base64url token: a route that forwarded the raw string
    // (or dropped it) would silently restart pagination at page one, forever.
    expect(calls.list).toEqual([{ userId: USER_ID, limit: 2, cursor: key }])
  })

  it('returns the DAL page verbatim — items and the next-page token', async () => {
    const nextCursor = encodeNotesCursor({ createdAt: stored.createdAt, id: stored.id })
    const page: NotesPageDto = { items: [stored], nextCursor }
    const { options } = fixture({ page })

    const res = await createApp(options).request('/api/notes', { headers: authed })

    expect(res.status).toBe(200)
    expect(NotesPage.parse(await res.json())).toEqual(page)
  })
})

describe('POST /api/notes', () => {
  it('returns 201 with the CREATED row and hands the DAL the verified owner', async () => {
    const { options, calls } = fixture({ created: stored })

    const res = await createApp(options).request('/api/notes', {
      method: 'POST',
      headers: { ...authed, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'a note', body: 'the body' }),
    })

    expect(res.status).toBe(201) // not 200: the mobile create flow keys off it
    expect(NoteDto.parse(await res.json())).toEqual(stored)
    // owner_id comes from the token, never the wire — the DAL gets the verified subject.
    expect(calls.create).toEqual([
      { userId: USER_ID, input: { title: 'a note', body: 'the body' } },
    ])
  })

  it('accepts a body-less note (the column default), still 201', async () => {
    const { options, calls } = fixture({ created: { ...stored, body: '' } })

    const res = await createApp(options).request('/api/notes', {
      method: 'POST',
      headers: { ...authed, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'a note' }),
    })

    expect(res.status).toBe(201)
    expect(calls.create).toEqual([{ userId: USER_ID, input: { title: 'a note' } }])
  })
})

describe('GET /api/notes/{id}', () => {
  it('returns 200 with the note the DAL found, for the id in the path', async () => {
    const { options, calls } = fixture({ found: stored })

    const res = await createApp(options).request(`/api/notes/${NOTE_ID}`, { headers: authed })

    expect(res.status).toBe(200)
    expect(NoteDto.parse(await res.json())).toEqual(stored)
    expect(calls.get).toEqual([{ userId: USER_ID, id: NOTE_ID }])
  })

  it('returns 404 when the DAL sees nothing — RLS invisibility is indistinguishable from absent', async () => {
    const { options, calls } = fixture({ found: null })

    const res = await createApp(options).request(`/api/notes/${NOTE_ID}`, { headers: authed })

    expect(res.status).toBe(404) // never 200-with-null: the client would render an empty note
    expect(calls.get).toEqual([{ userId: USER_ID, id: NOTE_ID }])
  })
})

describe('DELETE /api/notes/{id}', () => {
  it('returns an EMPTY 204 when the row was removed', async () => {
    const { options, calls } = fixture({ removed: true })

    const res = await createApp(options).request(`/api/notes/${NOTE_ID}`, {
      method: 'DELETE',
      headers: authed,
    })

    expect(res.status).toBe(204)
    expect(await res.text()).toBe('') // 204 means NO body — a JSON payload here is a protocol lie
    expect(calls.remove).toEqual([{ userId: USER_ID, id: NOTE_ID }])
  })

  it('returns 404 when the row was not there to remove', async () => {
    const { options, calls } = fixture({ removed: false })

    const res = await createApp(options).request(`/api/notes/${NOTE_ID}`, {
      method: 'DELETE',
      headers: authed,
    })

    expect(res.status).toBe(404) // a delete that deleted nothing is NOT a success
    // The ENVELOPE, not just the status. `code` is the closed ApiErrorCode enum the mobile
    // client maps to user-facing copy (apps/mobile/src/i18n/errors.ts) — blank it and the
    // client falls through to a generic message while the status still reads 404.
    expect(ApiError.parse(await res.json()).error).toMatchObject({
      code: 'not_found',
      message: 'no such note',
    })
    expect(calls.remove).toEqual([{ userId: USER_ID, id: NOTE_ID }])
  })
})

describe('DELETE /api/me — in-app account deletion (Apple 5.1.1(v))', () => {
  it('deletes as the VERIFIED identity and answers 204 with no body', async () => {
    const { options, calls } = fixture({ deletedNotes: 3 })

    const res = await createApp(options).request('/api/me', { method: 'DELETE', headers: authed })

    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
    expect(calls.deleteAccount).toEqual([{ userId: USER_ID }])
  })

  it('is idempotent: deleting an already-empty account is still a completed 204', async () => {
    const { options, calls } = fixture({ deletedNotes: 0 })

    const res = await createApp(options).request('/api/me', { method: 'DELETE', headers: authed })

    expect(res.status).toBe(204)
    expect(calls.deleteAccount).toHaveLength(1)
  })

  it('an unauthenticated deletion never reaches the DAL — 401 envelope', async () => {
    const { options, calls } = fixture()

    const res = await createApp(options).request('/api/me', { method: 'DELETE' })

    expect(res.status).toBe(401)
    expect(ApiError.parse(await res.json()).error.code).toBe('unauthorized')
    expect(calls.deleteAccount).toEqual([])
  })
})
