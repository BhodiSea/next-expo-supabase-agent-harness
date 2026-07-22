import type { Note } from '@app/contracts'
import { type MessageKey, t } from '../../i18n'

// The matrix's data model: dense numeric columns derived from the NoteDto wire
// type, plus a synthetic generator for load/perf work. All hand-rolled — no
// chart or data-grid library.
//
// THIS MODULE IS NOT A COMPONENT, and it carries copy (column headers, synthetic
// row labels). So it reaches the catalog through the PLAIN `t` export from
// src/i18n — the module-level store — not the useI18n hook, which would need a
// tree it never has (the perf subject materializes rows with no provider
// anywhere). This is the case i18n/index.ts is a store and not a context in
// order to serve.

export interface MatrixColumn {
  /** Machine key, also the accessibility/testing handle. */
  readonly key: string
  /**
   * Catalog key for the human column header — NOT the header text. The consumer
   * resolves it with `t()` at RENDER time, and that is the whole point: this
   * array is a module-level const, evaluated once on import, so a resolved
   * string here would freeze whichever locale happened to be active at boot and
   * never follow a locale switch.
   */
  readonly labelKey: MessageKey
}

export interface MatrixRow {
  readonly id: string
  /** Row header text (a note title, or a synthetic label). */
  readonly label: string
  /** One number per MATRIX_COLUMNS entry, in order. */
  readonly values: readonly number[]
}

// The numeric projection of a note. Every column is derivable from a NoteDto so
// notesToMatrixRows and makeSyntheticRows stay shape-compatible.
export const MATRIX_COLUMNS: readonly MatrixColumn[] = [
  { key: 'confidence', labelKey: 'matrix.column.confidence' },
  { key: 'title', labelKey: 'matrix.column.title' },
  { key: 'body', labelKey: 'matrix.column.body' },
  { key: 'words', labelKey: 'matrix.column.words' },
  { key: 'lines', labelKey: 'matrix.column.lines' },
  { key: 'day', labelKey: 'matrix.column.day' },
]

const MS_PER_DAY = 86_400_000

function wordCount(body: string): number {
  return body.split(/\s+/).filter(Boolean).length
}

/** Project real notes onto the matrix columns — deterministic, no clock reads. */
export function notesToMatrixRows(notes: readonly Note[]): readonly MatrixRow[] {
  return notes.map((note) => ({
    id: note.id,
    label: note.title,
    values: [
      note.sourceConfidence ?? 0,
      note.title.length,
      note.body.length,
      wordCount(note.body),
      note.body.split('\n').length,
      Math.floor(Date.parse(note.createdAt) / MS_PER_DAY),
    ],
  }))
}

// SOURCE: mulberry32 — a small, fast, seeded PRNG; deterministic runs are the
// point (Math.random has no place in this feature for reproducibility, and the
// perf subject must render identical rows every time). [corpus: web/mulberry32]
// https://github.com/bryc/code/blob/master/jshash/PRNGs.md#mulberry32
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// A fixed seed makes makeSyntheticRows(n) reproducible run-to-run and
// prefix-stable across sizes — the property the perf subject and unit tests rely
// on. Golden-ratio constant, arbitrary but stable.
const SYNTHETIC_SEED = 0x9e3779b9

export function makeSyntheticRows(count: number): readonly MatrixRow[] {
  const rng = mulberry32(SYNTHETIC_SEED)
  const rows: MatrixRow[] = []
  for (let i = 0; i < count; i += 1) {
    rows.push({
      id: `synthetic-${String(i)}`,
      // Called at render time, so `t` reads the locale that is active NOW — the
      // id above stays machine-stable, only the human label is translated.
      label: t('matrix.row', { n: i + 1 }),
      values: [
        rng(),
        Math.floor(rng() * 80) + 1,
        Math.floor(rng() * 2000),
        Math.floor(rng() * 400),
        Math.floor(rng() * 40) + 1,
        20_000 + Math.floor(rng() * 400),
      ],
    })
  }
  return rows
}

// formatCell() used to live in the desktop original's copy of this module —
// DELETED there, and never ported here. Its rule ("fractions to 2dp, everything
// else an integer") survives verbatim in formatCellValue() in src/i18n; what did
// not survive is how it spelled that rule. `value.toFixed(2)` hardcodes `.` as
// the decimal mark, so the grid showed "0.75" to a German reader who writes
// "0,75" — inside a function named formatCell, which is exactly where you would
// look for that bug and not see it. Cell rendering is MatrixList →
// formatCellValue, which asks the locale.
