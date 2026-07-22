import { readFileSync } from 'node:fs'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Table } from './index.js'
import { parseTable, serializeTable } from './index.js'

// Deterministic PBT: a FIXED seed and run count, so a red here reproduces
// byte-identically on every machine and in CI — a randomly-seeded property
// test is a flake generator wearing a rigor costume. Explore new seeds
// DELIBERATELY (fc.assert override in a scratch run), then pin what you keep.
// SOURCE: fast-check runner parameters (seed/numRuns)
// https://fast-check.dev/docs/configuration/user-definable-values/
const FC_PARAMS = { seed: 420, numRuns: 200 } as const

// Cells drawn from plain strings plus strings dense in the characters that
// exercise the grammar: quotes, both delimiters, and record separators.
const trickyChar = fc.constantFrom('"', ',', '\t', '\r', '\n', 'x', 'é')
const cellArb = fc.oneof(fc.string(), fc.string({ unit: trickyChar }))
const delimiterArb = fc.constantFrom(',', '\t')
const anyTextArb = fc.oneof(
  fc.string(),
  fc.string({ unit: trickyChar }),
  fc.string({ unit: 'binary' }),
)

// Well-formed tables: non-empty header, every row exactly header-width.
const tableArb = fc.array(cellArb, { minLength: 1, maxLength: 4 }).chain((header) =>
  fc
    .array(fc.array(cellArb, { minLength: header.length, maxLength: header.length }), {
      maxLength: 5,
    })
    .map((rows): Table => ({ header, rows })),
)

describe('parseTable properties', () => {
  it('inverts serializeTable for every well-formed table', () => {
    fc.assert(
      fc.property(tableArb, delimiterArb, (table, delimiter) => {
        expect(parseTable(serializeTable(table, { delimiter }), { delimiter })).toEqual(table)
      }),
      FC_PARAMS,
    )
  })

  it('is total: never throws, for any input string', () => {
    fc.assert(
      fc.property(anyTextArb, delimiterArb, (text, delimiter) => {
        expect(() => parseTable(text, { delimiter })).not.toThrow()
      }),
      FC_PARAMS,
    )
  })

  it('keeps the cell-count invariant: every row is exactly header-width', () => {
    fc.assert(
      fc.property(anyTextArb, delimiterArb, (text, delimiter) => {
        const { header, rows } = parseTable(text, { delimiter })
        expect(header.length).toBeGreaterThan(0)
        for (const row of rows) expect(row).toHaveLength(header.length)
      }),
      FC_PARAMS,
    )
  })
})

describe('parseTable examples', () => {
  it('parses plain CSV', () => {
    expect(parseTable('a,b\n1,2\n')).toEqual({ header: ['a', 'b'], rows: [['1', '2']] })
  })

  it('parses quoted fields containing delimiters, escaped quotes, and newlines', () => {
    const text = 'name,note\r\n"Doe, Jane","said ""hi""\nthen left"\r\n'
    expect(parseTable(text)).toEqual({
      header: ['name', 'note'],
      rows: [['Doe, Jane', 'said "hi"\nthen left']],
    })
  })

  it('normalizes ragged rows to header width (pad short, drop surplus)', () => {
    expect(parseTable('h1,h2\r\na\r\nb,c,d\r\n')).toEqual({
      header: ['h1', 'h2'],
      rows: [
        ['a', ''],
        ['b', 'c'],
      ],
    })
  })

  it('parses TSV when the delimiter is a tab', () => {
    expect(parseTable('x\ty\n1\t"a\tb"\n', { delimiter: '\t' })).toEqual({
      header: ['x', 'y'],
      rows: [['1', 'a\tb']],
    })
  })

  it('parses empty input to a single empty header cell and no rows', () => {
    expect(parseTable('')).toEqual({ header: [''], rows: [] })
  })

  it('treats stray quotes as literal text instead of throwing', () => {
    expect(parseTable('a"b,c\n"unterminated')).toEqual({
      header: ['a"b', 'c'],
      rows: [['unterminated', '']],
    })
  })
})

describe('serializeTable examples', () => {
  it('quotes per RFC 4180 and terminates every record', () => {
    expect(serializeTable({ header: ['a', 'b'], rows: [['1,5', 'plain']] })).toBe(
      'a,b\r\n"1,5",plain\r\n',
    )
  })

  it('escapes embedded quotes by doubling', () => {
    expect(serializeTable({ header: ['q'], rows: [['say "hi"']] })).toBe('q\r\n"say ""hi"""\r\n')
  })
})

describe('sample.tsv fixture', () => {
  it('parses the pinned fixture, including a quoted cell with tabs and escaped quotes', () => {
    const text = readFileSync(new URL('../fixtures/sample.tsv', import.meta.url), 'utf8')
    const { header, rows } = parseTable(text, { delimiter: '\t' })
    expect(header).toEqual(['code', 'axis', 'description'])
    expect(rows).toHaveLength(4)
    expect(rows[2]).toEqual(['RECALL', 'skill', 'Remember "core" facts\tand terms'])
  })
})
