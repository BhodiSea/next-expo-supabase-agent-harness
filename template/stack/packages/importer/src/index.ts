// @app/importer — deterministic, zero-dependency table (CSV/TSV) parsing.
//
// The grammar is RFC-4180-ish, applied uniformly to both delimiters:
//   - records are separated by CRLF, LF, or lone CR
//   - a field that BEGINS with `"` is quoted: it may contain delimiters,
//     record separators, and quotes (escaped by doubling: `""`)
//   - parsing is TOTAL — malformed input (stray or unterminated quotes)
//     degrades to literal text instead of throwing
//
// Invariants (property-tested in parse.test.ts):
//   1. parseTable(serializeTable(t)) deep-equals t for every well-formed table
//   2. parseTable never throws, for any string input
//   3. every parsed row has exactly header.length cells

export type Delimiter = ',' | '\t'

export interface TableOptions {
  /** Cell separator. Defaults to ',' (CSV); pass '\t' for TSV. */
  readonly delimiter?: Delimiter
}

export interface Table {
  readonly header: readonly string[]
  readonly rows: readonly (readonly string[])[]
}

/**
 * Parse delimiter-separated text into a header record plus data rows.
 * Total function: any string input yields a Table. Data rows are normalized
 * to header width — short rows are padded with empty cells, surplus cells
 * are dropped — so consumers can index cells by header position safely.
 */
export function parseTable(text: string, options: TableOptions = {}): Table {
  const delimiter = options.delimiter ?? ','
  const records = splitRecords(text, delimiter)
  const header = records[0] ?? ['']
  return {
    header,
    rows: records.slice(1).map((cells) => fitToWidth(cells, header.length)),
  }
}

/**
 * Inverse of parseTable. Every record — including the last — ends with CRLF:
 * a document that ends exactly at a record boundary parses back without the
 * "trailing newline vs trailing empty record" ambiguity, which is what makes
 * parseTable ∘ serializeTable the identity on well-formed tables.
 */
export function serializeTable(table: Table, options: TableOptions = {}): string {
  const delimiter = options.delimiter ?? ','
  const records = [table.header, ...table.rows]
  return records
    .map((cells) => `${cells.map((cell) => encodeCell(cell, delimiter)).join(delimiter)}\r\n`)
    .join('')
}

// SOURCE: https://www.rfc-editor.org/rfc/rfc4180#section-2 (rules 5-7: fields
// containing separators, quotes, or line breaks are quoted; embedded quotes
// are escaped by doubling)
function encodeCell(cell: string, delimiter: Delimiter): string {
  if (
    cell.includes('"') ||
    cell.includes(delimiter) ||
    cell.includes('\n') ||
    cell.includes('\r')
  ) {
    return `"${cell.replaceAll('"', '""')}"`
  }
  return cell
}

function splitRecords(text: string, delimiter: Delimiter): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let cell = ''
  let atCellStart = true
  let i = 0
  while (i < text.length) {
    const ch = text.charAt(i)
    if (ch === '"' && atCellStart) {
      const quoted = readQuoted(text, i + 1)
      cell += quoted.value
      i = quoted.next
      atCellStart = false
      continue
    }
    if (ch === delimiter) {
      record.push(cell)
      cell = ''
      atCellStart = true
      i += 1
      continue
    }
    if (ch === '\n' || ch === '\r') {
      record.push(cell)
      records.push(record)
      record = []
      cell = ''
      atCellStart = true
      i += ch === '\r' && text.charAt(i + 1) === '\n' ? 2 : 1
      continue
    }
    cell += ch
    atCellStart = false
    i += 1
  }
  // Emit the pending record unless the text ended exactly at a record
  // boundary (RFC 4180: a single trailing terminator closes the last record,
  // it does not open an empty one). Empty input still yields one empty record.
  if (cell !== '' || record.length > 0 || records.length === 0) {
    record.push(cell)
    records.push(record)
  }
  return records
}

// Consume a quoted section starting AFTER the opening quote. Doubled quotes
// decode to one literal quote; an unterminated section runs to end of input
// (lenient — parsing must be total).
function readQuoted(text: string, start: number): { value: string; next: number } {
  let value = ''
  let i = start
  while (i < text.length) {
    const ch = text.charAt(i)
    if (ch !== '"') {
      value += ch
      i += 1
      continue
    }
    if (text.charAt(i + 1) === '"') {
      value += '"'
      i += 2
      continue
    }
    return { value, next: i + 1 }
  }
  return { value, next: i }
}

function fitToWidth(cells: readonly string[], width: number): string[] {
  const fitted = cells.slice(0, width)
  while (fitted.length < width) fitted.push('')
  return fitted
}
