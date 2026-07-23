import type { NotesPage, NoteView } from '@app/contracts'
import type { ActionOutcome, AppError } from '@app/errors'

/**
 * Every state the notes page can be in, as a closed union.
 *
 * This type is the reason the matching lives in a module instead of inside JSX. A page that
 * writes `{outcome.ok ? <List/> : <Error/>}` has silently decided that "succeeded with zero
 * rows" renders as a list — which is how empty states end up as a blank rectangle nobody
 * notices until a user reports it. Naming the four states makes the empty case impossible to
 * skip, makes `missing` (a 404, not a failure) distinguishable from `error`, and makes the
 * whole mapping a pure function a unit test can exhaust without a database.
 *
 * The render shape is `NoteView` — the ONE shape both surfaces render (there is no `Note`
 * type; the contract splits into the persisted `NoteRecord` and the rendered `NoteView`, and
 * the UI only ever sees the latter). The `ready` arm carries `nextCursor` alongside the rows
 * because the DAL returns a PAGE (`items` + `nextCursor`), not a bare array: dropping the
 * cursor here would weld this seam to a single un-paginable page and force the "load more"
 * that a real notes screen needs to re-derive the cursor it was handed and threw away.
 */
export type NotesPageModel =
  | { readonly status: 'ready'; readonly notes: readonly NoteView[]; readonly nextCursor: string | null }
  | { readonly status: 'empty' }
  | { readonly status: 'missing' }
  | { readonly status: 'error'; readonly error: AppError }

/**
 * Fold the package's ActionOutcome envelope into the page's render states.
 *
 * The envelope arrives on the DATA channel — a domain failure is a value here, never a
 * thrown error, which is precisely what lets this be a total function. `not_found` is
 * separated out because it is not a failure to display: it is a 404, and the page hands it
 * to Next's notFound() so the route family's own not-found.tsx renders and the response
 * carries a real 404 status. Reporting "something went wrong" for a note that simply does
 * not exist teaches users to distrust every error message the app shows.
 * SOURCE: docs/harness/README.md (the serializable outcome envelope crosses every seam;
 * screens switch on the discriminant)
 */
export function toNotesPageModel(outcome: ActionOutcome<NotesPage>): NotesPageModel {
  if (!outcome.ok) {
    return outcome.error.code === 'not_found'
      ? { status: 'missing' }
      : { status: 'error', error: outcome.error }
  }
  // The DAL hands back a page — `items` plus the `nextCursor` for the next seek. The empty
  // case keys off the item count, and the ready case forwards BOTH the rows and the cursor
  // rather than flattening the page down to its array (which is what stranded pagination in
  // the guessed version).
  const { items, nextCursor } = outcome.data
  return items.length === 0 ? { status: 'empty' } : { status: 'ready', notes: items, nextCursor }
}
