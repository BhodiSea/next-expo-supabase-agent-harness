import type { NoteView } from '@app/contracts'
import { type MessageKey, t } from '../../i18n'

// The matrix's data model: dense numeric columns derived from the NoteView
// render contract, plus a synthetic generator for load/perf work. All
// hand-rolled — no chart or data-grid library.
//
// NoteView, not NoteRecord, and the choice decides what CAN be a column.
// `*View` is the ONE shape both surfaces render; `*Record` is the persisted
// contract, and it carries ownership and lifecycle columns a UI has no business
// drawing. So there is no body-length column and no owner column here — the
// render contract deliberately ships an `excerpt` (bounded at 160 chars) and a
// `hasBody` flag instead of the body itself, precisely so a list row does not
// carry 20 000 characters it will never paint. A column needing the full body
// would have to change the CONTRACT, on both surfaces, which is the review this
// arrangement exists to force.
// SOURCE: packages/contracts/src/index.ts (the Record/View split and why)
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

// The numeric projection of a note. Every column is derivable from a NoteView so
// notesToMatrixRows and makeSyntheticRows stay shape-compatible.
export const MATRIX_COLUMNS: readonly MatrixColumn[] = [
  { key: 'hasBody', labelKey: 'matrix.column.hasBody' },
  { key: 'title', labelKey: 'matrix.column.title' },
  { key: 'excerpt', labelKey: 'matrix.column.excerpt' },
  { key: 'words', labelKey: 'matrix.column.words' },
  { key: 'archived', labelKey: 'matrix.column.archived' },
  { key: 'day', labelKey: 'matrix.column.day' },
]

const MS_PER_DAY = 86_400_000

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

/**
 * Booleans as 0/1 rather than as text. The grid is NUMERIC by construction —
 * every cell goes through formatCellValue, which is what keeps the decimal mark
 * the locale's — and a 'yes'/'no' cell would be an English literal smuggled past
 * the catalog in a module the i18n gate scans for exactly that.
 */
function flag(value: boolean): number {
  return value ? 1 : 0
}

/** Project real notes onto the matrix columns — deterministic, no clock reads. */
export function notesToMatrixRows(notes: readonly NoteView[]): readonly MatrixRow[] {
  return notes.map((note) => ({
    id: note.id,
    label: note.title,
    values: [
      flag(note.hasBody),
      note.title.length,
      note.excerpt.length,
      wordCount(note.excerpt),
      flag(note.isArchived),
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
      // Column-for-column with notesToMatrixRows above, and RANGED to match:
      // the two 0/1 flag columns stay 0/1, the length columns stay inside their
      // contract bounds (NOTE_TITLE_MAX 200, NOTE_EXCERPT_MAX 160). Synthetic
      // rows that ignored those ranges would make the perf subject render cells
      // no real page can produce — a benchmark of a layout nobody ships.
      values: [
        rng() > 0.3 ? 1 : 0,
        Math.floor(rng() * 80) + 1,
        Math.floor(rng() * 160),
        Math.floor(rng() * 30),
        rng() < 0.1 ? 1 : 0,
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
