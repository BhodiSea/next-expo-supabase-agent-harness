import { NOTE_EXCERPT_MAX, type NoteRecord, NoteView } from '@app/contracts'
import { describe, expect, it } from 'vitest'
import {
  applyNoteUpdate,
  buildExcerpt,
  compareNotesByRecency,
  isArchived,
  isRenderableTitle,
  normalizeTitle,
  toNoteView,
} from './note.js'

const NOTE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const OWNER_ID = '9b2b1c7e-2a44-4a3e-8f5d-6c1a2b3c4d5e'
const AT = '2026-01-01T00:00:00.123456+00:00'

const record: NoteRecord = {
  archivedAt: null,
  body: '',
  createdAt: AT,
  id: NOTE_ID,
  ownerId: OWNER_ID,
  title: 'Ship the vertical',
  updatedAt: AT,
}

describe('normalizeTitle', () => {
  it('collapses every kind of gap to one space and trims the ends', () => {
    expect(normalizeTitle('  hello   world  ')).toBe('hello world')
    expect(normalizeTitle('hello\nworld')).toBe('hello world')
    expect(normalizeTitle('hello\t\tworld')).toBe('hello world')
    // NBSP and the ideographic space render as gaps but are not ASCII spaces —
    // a title pasted from a document is full of them.
    expect(normalizeTitle('hello world')).toBe('hello world')
    expect(normalizeTitle('hello　world')).toBe('hello world')
  })

  it('is idempotent (running it twice must not keep changing the title)', () => {
    const once = normalizeTitle(' a \n b  c ')
    expect(normalizeTitle(once)).toBe(once)
  })

  it('leaves an already-clean title byte-identical', () => {
    expect(normalizeTitle('Ship the vertical')).toBe('Ship the vertical')
  })
})

describe('isRenderableTitle', () => {
  it.each([
    { pins: 'ordinary text', raw: 'note', renderable: true },
    { pins: 'leading/trailing space does not disqualify', raw: '  note  ', renderable: true },
    { pins: 'a single visible glyph is enough', raw: 'x', renderable: true },
    { pins: 'the empty string', raw: '', renderable: false },
    { pins: 'spaces only — passes min(1), renders as nothing', raw: '   ', renderable: false },
    { pins: 'a newline only', raw: '\n', renderable: false },
    { pins: 'NBSP only — invisible, and min(1) never notices', raw: ' ', renderable: false },
  ])('$pins', ({ raw, renderable }) => {
    expect(isRenderableTitle(raw)).toBe(renderable)
  })
})

describe('buildExcerpt', () => {
  it('returns a short body unchanged, flattened to one line', () => {
    expect(buildExcerpt('a short note')).toBe('a short note')
    expect(buildExcerpt('two\nlines')).toBe('two lines')
    expect(buildExcerpt('   padded   ')).toBe('padded')
    expect(buildExcerpt('')).toBe('')
  })

  it('never exceeds the contract bound, ellipsis included', () => {
    const long = 'word '.repeat(200)
    const excerpt = buildExcerpt(long)
    expect(excerpt.length).toBeLessThanOrEqual(NOTE_EXCERPT_MAX)
    expect(excerpt.endsWith('…')).toBe(true)
  })

  it('prefers a word boundary when one sits late enough in the budget', () => {
    // 40 chars of budget; the last space is well past the halfway floor.
    const excerpt = buildExcerpt('alpha bravo charlie delta echo foxtrot golf hotel', 40)
    expect(excerpt.endsWith('…')).toBe(true)
    expect(excerpt).not.toMatch(/ …$/) // the boundary is trimmed, not left dangling
    expect(excerpt.slice(0, -1).split(' ').at(-1)).not.toBe('')
  })

  it('hard-cuts when the only word boundary is absurdly early', () => {
    // One space at position 2, then a 60-character run: honouring that boundary
    // would throw away almost everything, so the hard cut wins.
    const excerpt = buildExcerpt(`ab ${'x'.repeat(60)}`, 20)
    expect(excerpt).toHaveLength(20)
    expect(excerpt.startsWith('ab x')).toBe(true)
  })

  it('exactly at the bound is not truncated (the boundary is inclusive)', () => {
    const exact = 'x'.repeat(NOTE_EXCERPT_MAX)
    expect(buildExcerpt(exact)).toBe(exact)
    expect(buildExcerpt(`${exact}y`)).toHaveLength(NOTE_EXCERPT_MAX)
  })
})

describe('isArchived', () => {
  it('derives the flag from the timestamp column, once', () => {
    expect(isArchived({ archivedAt: null })).toBe(false)
    expect(isArchived({ archivedAt: AT })).toBe(true)
  })
})

describe('toNoteView — THE Record -> View mapping', () => {
  it('produces a value that parses against the wire contract', () => {
    const view = toNoteView({ ...record, body: 'the body' })
    expect(NoteView.parse(view)).toEqual(view)
  })

  it('drops ownerId: the render shape carries no identifiers the UI cannot use', () => {
    expect(toNoteView(record)).not.toHaveProperty('ownerId')
    expect(Object.keys(toNoteView(record)).sort()).toEqual([
      'createdAt',
      'excerpt',
      'hasBody',
      'id',
      'isArchived',
      'title',
      'updatedAt',
    ])
  })

  it('normalises the title on the way out so both surfaces render the same string', () => {
    expect(toNoteView({ ...record, title: '  Ship\n the  vertical ' }).title).toBe(
      'Ship the vertical',
    )
  })

  it('reports hasBody on VISIBLE content, not on length', () => {
    expect(toNoteView({ ...record, body: '' }).hasBody).toBe(false)
    expect(toNoteView({ ...record, body: '   \n  ' }).hasBody).toBe(false)
    expect(toNoteView({ ...record, body: 'x' }).hasBody).toBe(true)
  })

  it('carries the timestamps through verbatim — microseconds and all', () => {
    const view = toNoteView(record)
    expect(view.createdAt).toBe(AT)
    expect(view.updatedAt).toBe(AT)
  })

  it('surfaces the archived flag', () => {
    expect(toNoteView(record).isArchived).toBe(false)
    expect(toNoteView({ ...record, archivedAt: AT }).isArchived).toBe(true)
  })

  it('bounds the excerpt even for a maximal body', () => {
    const view = toNoteView({ ...record, body: 'x'.repeat(20_000) })
    expect(() => NoteView.parse(view)).not.toThrow()
  })
})

describe('compareNotesByRecency', () => {
  const older = { createdAt: '2026-01-01T00:00:00+00:00', id: 'aaaa' }
  const newer = { createdAt: '2026-02-01T00:00:00+00:00', id: 'bbbb' }

  it('orders newest first', () => {
    expect(compareNotesByRecency(newer, older)).toBeLessThan(0)
    expect(compareNotesByRecency(older, newer)).toBeGreaterThan(0)
  })

  it('breaks ties on id descending — the same total order the keyset index uses', () => {
    const a = { createdAt: older.createdAt, id: 'aaaa' }
    const b = { createdAt: older.createdAt, id: 'bbbb' }
    expect(compareNotesByRecency(b, a)).toBeLessThan(0)
    expect(compareNotesByRecency(a, b)).toBeGreaterThan(0)
  })

  it('is 0 only for the same key (a stable total order, not a partial one)', () => {
    expect(compareNotesByRecency(older, { ...older })).toBe(0)
    expect(compareNotesByRecency(older, { createdAt: older.createdAt, id: 'zzzz' })).not.toBe(0)
  })

  it('sorts a shuffled page back into the DAL order', () => {
    const rows = [
      { createdAt: '2026-01-01T00:00:00+00:00', id: 'b' },
      { createdAt: '2026-03-01T00:00:00+00:00', id: 'a' },
      { createdAt: '2026-01-01T00:00:00+00:00', id: 'c' },
    ]
    expect([...rows].sort(compareNotesByRecency).map((row) => row.id)).toEqual(['a', 'c', 'b'])
  })

  it('compares microsecond precision that a Date round trip would lose', () => {
    const fine = { createdAt: '2026-01-01T00:00:00.000001+00:00', id: 'a' }
    const coarse = { createdAt: '2026-01-01T00:00:00.000000+00:00', id: 'a' }
    expect(compareNotesByRecency(fine, coarse)).toBeLessThan(0)
  })
})

describe('applyNoteUpdate', () => {
  const LATER = '2026-06-01T12:00:00+00:00'

  it('does not mutate its input', () => {
    const before = { ...record }
    applyNoteUpdate(record, { title: 'renamed' }, LATER)
    expect(record).toEqual(before)
  })

  it('applies only the fields present in the patch', () => {
    const next = applyNoteUpdate({ ...record, body: 'keep' }, { title: 'renamed' }, LATER)
    expect(next.title).toBe('renamed')
    expect(next.body).toBe('keep')
  })

  it('normalises a patched title exactly as the write path will', () => {
    expect(applyNoteUpdate(record, { title: ' a  b ' }, LATER).title).toBe('a b')
  })

  it('archives with the supplied instant and un-archives to null', () => {
    const archived = applyNoteUpdate(record, { isArchived: true }, LATER)
    expect(archived.archivedAt).toBe(LATER)
    expect(applyNoteUpdate(archived, { isArchived: false }, LATER).archivedAt).toBeNull()
  })

  it('keeps the ORIGINAL archive instant when re-archiving an archived note', () => {
    // Re-archiving is a no-op on the timestamp: the note was archived when it
    // was archived, and overwriting that loses the only record of when.
    const already = { ...record, archivedAt: AT }
    expect(applyNoteUpdate(already, { isArchived: true }, LATER).archivedAt).toBe(AT)
  })

  it('leaves archivedAt untouched when the patch says nothing about it', () => {
    const already = { ...record, archivedAt: AT }
    expect(applyNoteUpdate(already, { title: 'x' }, LATER).archivedAt).toBe(AT)
    expect(applyNoteUpdate(record, { title: 'x' }, LATER).archivedAt).toBeNull()
  })

  it('does NOT advance updatedAt — this layer has no clock and must not invent one', () => {
    // A client-invented updatedAt disagrees with the server's on reconciliation
    // and makes the row jump position in the list twice.
    expect(applyNoteUpdate(record, { title: 'renamed' }, LATER).updatedAt).toBe(record.updatedAt)
  })

  it('accepts an empty body as a real value, not as "absent"', () => {
    expect(applyNoteUpdate({ ...record, body: 'gone' }, { body: '' }, LATER).body).toBe('')
  })

  it('preserves identity columns', () => {
    const next = applyNoteUpdate(record, { body: 'x' }, LATER)
    expect(next.id).toBe(record.id)
    expect(next.ownerId).toBe(record.ownerId)
    expect(next.createdAt).toBe(record.createdAt)
  })
})
