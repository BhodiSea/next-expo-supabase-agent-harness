// Matrix data-model suite (pure vitest — matrixData's import closure is the
// contracts type + the i18n store, both node-clean).
import type { Note } from '@app/contracts'
import { describe, expect, it } from 'vitest'
import { formatCellValue } from '../../i18n'
import { MATRIX_COLUMNS, makeSyntheticRows, notesToMatrixRows } from './matrixData'

const NOTE: Note = {
  id: '00000000-0000-4000-8000-000000000001',
  ownerId: '00000000-0000-4000-8000-0000000000aa',
  title: 'Hello world',
  body: 'a b c',
  createdAt: '2026-01-01T00:00:00.000Z',
  embedding: null,
  sourceConfidence: 0.5,
  sourceModel: null,
}

describe('matrixData', () => {
  it('makeSyntheticRows is deterministic for a given count (seeded PRNG)', () => {
    expect(makeSyntheticRows(50)).toEqual(makeSyntheticRows(50))
  })

  it('produces the requested row count with the right column arity', () => {
    const rows = makeSyntheticRows(10)
    expect(rows.length).toBe(10)
    expect(rows[0]?.values.length).toBe(MATRIX_COLUMNS.length)
  })

  it('is prefix-stable across sizes (a fixed seed)', () => {
    expect(makeSyntheticRows(20).slice(0, 5)).toEqual(makeSyntheticRows(5))
  })

  it('projects a NoteDto onto the numeric columns', () => {
    const [row] = notesToMatrixRows([NOTE])
    expect(row?.label).toBe('Hello world')
    expect(row?.values.length).toBe(MATRIX_COLUMNS.length)
    expect(row?.values[0]).toBe(0.5) // confidence
    expect(row?.values[3]).toBe(3) // word count of "a b c"
  })

  // formatCell() never made it into this port: it did `v.toFixed(2)`, which
  // HARDCODES '.' as the decimal mark, so a German reader saw "0.75" where they
  // write "0,75". The rule survives in formatCellValue — the values below are
  // its `en` rendering, and under `de` the same call yields "0,50".
  it('formatCellValue keeps fractions to 2dp and integers plain', () => {
    expect(formatCellValue(0.5)).toBe('0.50')
    expect(formatCellValue(42)).toBe('42')
  })
})
