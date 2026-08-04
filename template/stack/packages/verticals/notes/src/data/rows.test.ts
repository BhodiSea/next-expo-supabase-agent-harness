import { NoteRecord } from '@app/contracts'
import { describe, expect, it } from 'vitest'
import { asRowArray, NOTE_COLUMNS, NOTE_ROW_KEYS, NOTES_TABLE, toNoteRecord } from './rows.js'

const ROW = {
  archived_at: null,
  body: 'the body',
  created_at: '2026-01-01T00:00:00.123456+00:00',
  id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  owner_id: '9b2b1c7e-2a44-4a3e-8f5d-6c1a2b3c4d5e',
  title: 'Ship the vertical',
  updated_at: '2026-02-01T09:30:00+00:00',
}

describe('the projection', () => {
  it('names the table once', () => {
    expect(NOTES_TABLE).toBe('notes')
  })

  it('selects exactly the row schema’s columns — no more, no fewer', () => {
    // Lockstep. A column added to the schema but not the projection reads as a
    // parse failure on live data; a column added to the projection but not the
    // schema is a payload nobody reviewed.
    const projected = NOTE_COLUMNS.split(',')
      .map((column) => column.trim())
      .sort()
    expect(projected).toEqual(NOTE_ROW_KEYS)
  })

  it('is a real projection, not a wildcard', () => {
    expect(NOTE_COLUMNS).not.toContain('*')
    expect(NOTE_ROW_KEYS.length).toBeGreaterThan(0)
  })
})

describe('toNoteRecord', () => {
  it('renames every snake_case column onto the contract', () => {
    expect(toNoteRecord(ROW)).toEqual({
      archivedAt: null,
      body: 'the body',
      createdAt: '2026-01-01T00:00:00.123456+00:00',
      id: ROW.id,
      ownerId: ROW.owner_id,
      title: 'Ship the vertical',
      updatedAt: '2026-02-01T09:30:00+00:00',
    })
  })

  it('produces a value that parses against the contract', () => {
    const record = toNoteRecord(ROW)
    expect(NoteRecord.parse(record)).toEqual(record)
  })

  // THE ORPHANED-ROW CASE, and it is a regression test with a scar.
  //
  // `notes.owner_id` is ON DELETE SET NULL (the B2B attribution demotion: the org owns
  // the data, so removing an employee must not delete the company's rows). Every other
  // fixture in this file stamps an owner, so a non-null contract passed the whole unit
  // suite and only failed against a real database — where it did not fail politely. This
  // parse is inside listNotes' try/catch, so ONE orphaned row turns the entire page into
  // `contractDrift`: a single departed employee blanks their org's notes list.
  //
  // If someone re-tightens `NoteRecord.ownerId` to a bare uuid, this line is what says no.
  it('parses a row whose owner has been deleted — attribution is nullable, not required', () => {
    const orphaned = toNoteRecord({ ...ROW, owner_id: null })
    expect(orphaned.ownerId).toBeNull()
    expect(NoteRecord.parse(orphaned)).toEqual(orphaned)
  })

  it('leaves NO snake_case key on the result — a raw row must never escape', () => {
    for (const key of Object.keys(toNoteRecord(ROW))) {
      expect(key).not.toContain('_')
    }
  })

  it('carries the archive timestamp through when present', () => {
    expect(toNoteRecord({ ...ROW, archived_at: '2026-03-01T00:00:00+00:00' }).archivedAt).toBe(
      '2026-03-01T00:00:00+00:00',
    )
  })

  it('drops columns the contract does not declare', () => {
    // A future internal column (an embedding, a moderation flag) must not ride
    // out to the wire just because someone added it to the table.
    const widened = { ...ROW, internal_score: 0.99 }
    expect(toNoteRecord(widened)).not.toHaveProperty('internal_score')
  })

  it.each([
    { pins: 'a missing column', row: { ...ROW, title: undefined } },
    { pins: 'a null in a NOT NULL column', row: { ...ROW, body: null } },
    { pins: 'a non-uuid id', row: { ...ROW, id: 'note-1' } },
    { pins: 'a timestamp that is not one', row: { ...ROW, created_at: 'yesterday' } },
    { pins: 'a title past the contract bound', row: { ...ROW, title: 'x'.repeat(201) } },
    { pins: 'an empty title', row: { ...ROW, title: '' } },
    { pins: 'not an object at all', row: 'nope' },
    { pins: 'null', row: null },
  ])('throws on $pins (schema drift is loud, never silent)', ({ row }) => {
    expect(() => toNoteRecord(row)).toThrow()
  })
})

describe('asRowArray', () => {
  it('passes an array through', () => {
    expect(asRowArray([ROW])).toEqual([ROW])
    expect(asRowArray([])).toEqual([])
  })

  it.each([
    null,
    undefined,
    'rows',
    0,
    {},
    { data: [] },
  ])('coerces the non-array %j to empty rather than indexing it blindly', (data: unknown) => {
    // `data[0]` on a non-array is `undefined`, which would read as "no rows"
    // instead of "the protocol did something unexpected".
    expect(asRowArray(data)).toEqual([])
  })
})
