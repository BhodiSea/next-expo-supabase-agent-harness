import { NOTE_EXCERPT_MAX, type NoteRecord, type NoteView } from '@app/contracts'

// ---------------------------------------------------------------------------
// Pure note domain. NO IO, no clock, no client, no zod parsing of untrusted
// input — every function here is a total function of its arguments, which is
// what makes this the one layer that is exhaustively unit-testable without a
// database, a router, or a render tree.
//
// It is also the layer both surfaces share: web renders a NoteView, mobile
// renders a NoteView, and `toNoteView` below is the ONLY place a NoteRecord
// becomes one. A second mapping is how the phone ends up showing a stale field
// name six weeks after the web app renamed it.
// ---------------------------------------------------------------------------

/**
 * The single-space, single-line form of a user-typed title.
 *
 * Collapsing interior whitespace is not cosmetic: titles are rendered in
 * fixed-height list rows, and a pasted newline turns one row into two on web
 * while being silently swallowed by `<Text numberOfLines={1}>` on native — the
 * same record, two different layouts. Normalising at the domain edge means the
 * two surfaces cannot disagree.
 *
 * \s covers the ASCII set plus the Unicode space separators (including NBSP and
 * the ideographic space), which is exactly the class that renders as "a gap".
 * SOURCE: ECMA-262 WhiteSpace + LineTerminator production for \s
 * https://tc39.es/ecma262/#sec-patterns
 */
export function normalizeTitle(raw: string): string {
  return raw.replace(/\s+/gu, ' ').trim()
}

/**
 * True when a title survives normalisation as something a human can read. A
 * title of three spaces parses fine against the wire bound (`min(1)` counts
 * characters, not glyphs) and then renders as an empty row — so emptiness is
 * decided AFTER normalisation, here, and nowhere else.
 */
export function isRenderableTitle(raw: string): boolean {
  return normalizeTitle(raw).length > 0
}

/**
 * The list-row summary. Bounded by NOTE_EXCERPT_MAX *including* the ellipsis,
 * because the value is parsed back against `NoteView` — an excerpt that
 * overflows its own contract would turn a successful read into a 500.
 *
 * Truncation prefers the last word boundary inside the budget so the excerpt
 * ends on a word rather than mid-syllable, but only when that boundary is not
 * absurdly early (a single 400-character "word" must still be cut, not reduced
 * to the empty string).
 */
export function buildExcerpt(body: string, max: number = NOTE_EXCERPT_MAX): string {
  const flat = body.replace(/\s+/gu, ' ').trim()
  if (flat.length <= max) return flat
  // One character of the budget belongs to the ellipsis itself.
  const budget = max - 1
  const clipped = flat.slice(0, budget)
  const lastSpace = clipped.lastIndexOf(' ')
  // Half the budget is the floor: below it, word-boundary truncation throws
  // away more text than it saves, so fall back to the hard cut.
  const cut = lastSpace > budget / 2 ? clipped.slice(0, lastSpace) : clipped
  return `${cut.trimEnd()}…`
}

/**
 * Lifecycle is a nullable column, not a boolean: the timestamp records WHEN,
 * which a boolean cannot, and "archived" is derived from it here so no caller
 * ever writes `record.archivedAt !== null` a second, subtly different way
 * (`!= null`, `Boolean(...)`, `!!` — all differ on the empty string).
 */
export function isArchived(record: Pick<NoteRecord, 'archivedAt'>): boolean {
  return record.archivedAt !== null
}

/**
 * Record -> View. THE mapping. Both surfaces render the result of this function
 * and nothing else, which is the whole reason `*View` exists as a separate
 * contract from `*Record`.
 */
export function toNoteView(record: NoteRecord): NoteView {
  return {
    createdAt: record.createdAt,
    excerpt: buildExcerpt(record.body),
    hasBody: record.body.trim().length > 0,
    id: record.id,
    isArchived: isArchived(record),
    title: normalizeTitle(record.title),
    updatedAt: record.updatedAt,
  }
}

/**
 * Newest first, ties broken by id descending — the SAME total order the keyset
 * index and the DAL's ORDER BY use. It has to be the same: an optimistic
 * insertion sorted by a different rule puts the new row in one position, the
 * next page fetch puts it in another, and the list visibly jumps.
 *
 * String comparison is correct here precisely because the timestamps are
 * carried verbatim in ISO-8601 UTC text, whose lexicographic order IS its
 * chronological order. That property is why the wire format is pinned.
 * SOURCE: ISO 8601 fixed-width UTC representations sort lexicographically
 * https://www.rfc-editor.org/rfc/rfc3339#section-5.1
 */
export function compareNotesByRecency(
  a: Pick<NoteRecord, 'createdAt' | 'id'>,
  b: Pick<NoteRecord, 'createdAt' | 'id'>,
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1
  if (a.id === b.id) return 0
  return a.id < b.id ? 1 : -1
}

/**
 * Apply a patch to a record without mutating it — the optimistic-update
 * primitive both surfaces use while a mutation is in flight.
 *
 * `updatedAt` is NOT advanced here: this layer has no clock, and inventing one
 * would produce a client timestamp that disagrees with the server's on
 * reconciliation. The caller passes the server's own value once it lands.
 */
export interface NotePatch {
  readonly body?: string | undefined
  readonly isArchived?: boolean | undefined
  readonly title?: string | undefined
}

export function applyNoteUpdate(
  record: NoteRecord,
  patch: NotePatch,
  archivedAt: string,
): NoteRecord {
  const nextArchivedAt =
    patch.isArchived === undefined
      ? record.archivedAt
      : patch.isArchived
        ? (record.archivedAt ?? archivedAt)
        : null
  return {
    archivedAt: nextArchivedAt,
    body: patch.body ?? record.body,
    createdAt: record.createdAt,
    id: record.id,
    ownerId: record.ownerId,
    title: patch.title === undefined ? record.title : normalizeTitle(patch.title),
    updatedAt: record.updatedAt,
  }
}
