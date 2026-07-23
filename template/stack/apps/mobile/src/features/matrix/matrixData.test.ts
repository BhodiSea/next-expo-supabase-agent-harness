// Matrix data-model suite (pure vitest — matrixData's import closure is the
// contracts type + the i18n store, both node-clean).
import type { NoteView } from '@app/contracts'
import { describe, expect, it } from 'vitest'
import { formatCellValue } from '../../i18n'
import { MATRIX_COLUMNS, makeSyntheticRows, notesToMatrixRows } from './matrixData'

// The RENDER contract, not the persisted one: `NoteView` is what both surfaces
// receive, so it carries an excerpt and a hasBody flag rather than the body and
// no ownerId at all. Typing the fixture as NoteView is what makes a contract
// change red HERE rather than at runtime on a device.
const NOTE: NoteView = {
  createdAt: '2026-01-01T00:00:00.000Z',
  excerpt: 'a b c',
  hasBody: true,
  id: '00000000-0000-4000-8000-000000000001',
  isArchived: false,
  title: 'Hello world',
  updatedAt: '2026-01-01T00:00:00.000Z',
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

  it('projects a NoteView onto the numeric columns', () => {
    const [row] = notesToMatrixRows([NOTE])
    expect(row?.label).toBe('Hello world')
    expect(row?.values.length).toBe(MATRIX_COLUMNS.length)
    // Booleans project as 0/1, never as a 'yes'/'no' string: the grid is numeric
    // by construction, and a text cell would be an English literal in a module
    // the catalog cannot reach.
    expect(row?.values[0]).toBe(1) // hasBody
    expect(row?.values[3]).toBe(3) // word count of the excerpt "a b c"
    expect(row?.values[4]).toBe(0) // isArchived
  })

  it('a synthetic row is column-compatible with a projected one (same arity, same flag ranges)', () => {
    const [synthetic] = makeSyntheticRows(1)
    const [projected] = notesToMatrixRows([NOTE])
    expect(synthetic?.values.length).toBe(projected?.values.length)
    // The two flag columns must stay flags on BOTH paths — the perf subject
    // renders synthetic rows through the same cells a real page uses, so a
    // fractional "hasBody" there would benchmark a layout nobody ships.
    for (const index of [0, 4]) {
      expect([0, 1]).toContain(synthetic?.values[index])
    }
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
