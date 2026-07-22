// Pure contract behavior — bounds, formats, and the closed error-code set.
// These tests exercise the WIRE semantics only; everything table- or
// migration-coupled (RLS text, keyset index, drift against the drizzle
// derivation) lives in packages/schema/src/schema.test.ts.
import { describe, expect, it } from 'vitest'
import type { NewNote, Note } from './index.js'
import {
  ApiError,
  EMBEDDING_DIM,
  HealthResponse,
  NewNoteInput,
  NOTE_BODY_MAX,
  NOTE_TITLE_MAX,
  NOTES_PAGE_LIMIT_DEFAULT,
  NOTES_PAGE_LIMIT_MAX,
  NoteDto,
  NotesListQuery,
  NotesPage,
} from './index.js'

const sample: Note = {
  body: '',
  createdAt: '2026-01-01 00:00:00+00',
  embedding: null,
  id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  ownerId: '9b2b1c7e-2a44-4a3e-8f5d-6c1a2b3c4d5e',
  sourceConfidence: null,
  sourceModel: null,
  title: 'RLS smoke note',
}

describe('DTOs', () => {
  it('round-trips a Note through NoteDto', () => {
    expect(NoteDto.parse(sample)).toEqual(sample)
  })

  it('keeps the driver timestamptz text verbatim and rejects non-timestamp shapes', () => {
    // Both the Postgres text form (microsecond precision) and ISO-8601 pass;
    // the exact string survives parsing — keyset cursors depend on it.
    const micro = { ...sample, createdAt: '2026-01-01 00:00:00.123456+00' }
    expect(NoteDto.parse(micro).createdAt).toBe('2026-01-01 00:00:00.123456+00')
    expect(NoteDto.parse({ ...sample, createdAt: '2026-01-01T00:00:00.000Z' })).toBeTruthy()
    expect(() => NoteDto.parse({ ...sample, createdAt: 'yesterday' })).toThrow()
  })

  it('enforces the embedding dimension contract', () => {
    const full: Note = {
      ...sample,
      embedding: Array.from({ length: EMBEDDING_DIM }, () => 0.5),
    }
    expect(NoteDto.parse(full)).toEqual(full)
    expect(() => NoteDto.parse({ ...sample, embedding: [0.1, 0.2] })).toThrow()
  })

  it('bounds every wire string and number (no unbounded input)', () => {
    expect(() => NoteDto.parse({ ...sample, title: 'x'.repeat(NOTE_TITLE_MAX + 1) })).toThrow()
    expect(() => NoteDto.parse({ ...sample, body: 'x'.repeat(NOTE_BODY_MAX + 1) })).toThrow()
    expect(() => NoteDto.parse({ ...sample, sourceModel: 'm'.repeat(129) })).toThrow()
    // confidence is a probability: [0, 1]
    expect(NoteDto.parse({ ...sample, sourceConfidence: 0.5 }).sourceConfidence).toBe(0.5)
    expect(() => NoteDto.parse({ ...sample, sourceConfidence: 1.5 })).toThrow()
    expect(() => NewNoteInput.parse({ title: 'x'.repeat(NOTE_TITLE_MAX + 1) })).toThrow()
    expect(() => NewNoteInput.parse({ title: 'ok', body: 'x'.repeat(NOTE_BODY_MAX + 1) })).toThrow()
  })

  it('accepts client fields only in NewNoteInput and rejects an empty title', () => {
    const input: NewNote = { body: 'world', title: 'hello' }
    expect(NewNoteInput.parse(input)).toEqual(input)
    expect(NewNoteInput.parse({ title: 'body is optional' })).toEqual({ title: 'body is optional' })
    expect(() => NewNoteInput.parse({ title: '' })).toThrow()
    // owner_id must never be accepted from the wire — it is not part of the shape.
    expect(NewNoteInput.parse({ ownerId: sample.ownerId, title: 'x' })).toEqual({ title: 'x' })
  })

  it('locks the health contract', () => {
    const health = { ok: true, version: '0.1.0' }
    expect(HealthResponse.parse(health)).toEqual(health)
    expect(() => HealthResponse.parse({ ok: false, version: '0.1.0' })).toThrow()
  })

  it('locks the error envelope: nested code/message(/requestId), closed code set', () => {
    const body = {
      error: {
        code: 'version_skew',
        message: 'client major version does not match the server',
        requestId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      },
    }
    expect(ApiError.parse(body)).toEqual(body)
    expect(ApiError.parse({ error: { code: 'not_found', message: 'gone' } })).toBeTruthy()
    // The flat pre-envelope shape and undeclared codes are contract violations.
    expect(() => ApiError.parse({ error: 'version_skew' })).toThrow()
    expect(() => ApiError.parse({ error: { code: 'teapot', message: 'no' } })).toThrow()
    expect(() => ApiError.parse({ error: { code: 'internal', message: '' } })).toThrow()
  })

  it('locks the keyset pagination contracts', () => {
    expect(NotesListQuery.parse({})).toEqual({ limit: NOTES_PAGE_LIMIT_DEFAULT })
    expect(NotesListQuery.parse({ limit: '25', cursor: 'abc_-123' })).toEqual({
      limit: 25,
      cursor: 'abc_-123',
    })
    expect(() => NotesListQuery.parse({ limit: String(NOTES_PAGE_LIMIT_MAX + 1) })).toThrow()
    expect(() => NotesListQuery.parse({ limit: '0' })).toThrow()
    expect(() => NotesListQuery.parse({ cursor: 'not+base64url!' })).toThrow()
    expect(() => NotesListQuery.parse({ cursor: 'x'.repeat(300) })).toThrow()

    const page = { items: [sample], nextCursor: null }
    expect(NotesPage.parse(page)).toEqual(page)
    expect(NotesPage.parse({ items: [], nextCursor: 'abc' }).nextCursor).toBe('abc')
  })
})
