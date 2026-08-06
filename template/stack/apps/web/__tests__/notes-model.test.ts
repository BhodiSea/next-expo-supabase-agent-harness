import type { NoteView } from '@app/contracts'
import { appError, outcomeErr, outcomeOk } from '@app/errors'
import { describe, expect, it } from 'vitest'
import { toNotesPageModel } from '../lib/app-data/notes-model'

// The fold from the envelope to the page's render states. It is a total function over a
// closed union, which is the whole reason it lives in a module instead of inside JSX —
// so this suite's job is to exhaust the union and prove the two collapses that a page
// written as `{outcome.ok ? <List/> : <Error/>}` would silently make:
//   1. "succeeded with zero rows" must NOT render as a list (the blank-rectangle bug)
//   2. "not found" must NOT render as an error (a 404 is not a failure to display)
// SOURCE: apps/web/lib/app-data/notes-model.ts (the four states, named)

const NOTE: NoteView = {
  createdAt: '2026-01-01T00:00:00.123456+00:00',
  excerpt: 'the first line',
  hasBody: true,
  id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  isArchived: false,
  title: 'A note',
  updatedAt: '2026-01-02T00:00:00.000000+00:00',
}

describe('toNotesPageModel', () => {
  it('folds a populated page to ready, carrying the rows AND the cursor', () => {
    // Forwarding `nextCursor` is the assertion that matters. Flattening the page down to
    // its array is what strands pagination: the "load more" control then has to re-derive
    // a cursor this seam was handed and threw away.
    const model = toNotesPageModel(outcomeOk({ items: [NOTE], nextCursor: 'opaque-cursor' }))
    expect(model).toEqual({ status: 'ready', notes: [NOTE], nextCursor: 'opaque-cursor' })
  })

  it('folds a page with a null cursor to ready — the last page is still ready', () => {
    const model = toNotesPageModel(outcomeOk({ items: [NOTE], nextCursor: null }))
    expect(model.status).toBe('ready')
    expect(model).toMatchObject({ nextCursor: null })
  })

  it('folds zero rows to empty, NOT to ready-with-an-empty-list', () => {
    // The blank-rectangle bug, asserted directly: a `ready` arm carrying [] renders the
    // list chrome around nothing and no empty state is ever reached.
    const model = toNotesPageModel(outcomeOk({ items: [], nextCursor: null }))
    expect(model).toEqual({ status: 'empty' })
  })

  it('folds not_found to missing, NOT to error', () => {
    // `missing` is handed to Next's notFound() so the route family's not-found.tsx renders
    // and the response carries a real 404. Reporting "something went wrong" for a note that
    // simply is not there teaches users to distrust every error the app shows.
    const model = toNotesPageModel(outcomeErr(appError.notFound({ resource: 'note' })))
    expect(model).toEqual({ status: 'missing' })
  })

  it.each([
    ['forbidden', appError.forbidden()],
    ['rlsDenied', appError.rlsDenied({ relation: 'notes' })],
    ['unavailable', appError.unavailable()],
    ['unknown', appError.unknown()],
    ['quotaExceeded', appError.quotaExceeded({ metric: 'notes', limit: 100 })],
  ])('folds a %s failure to error, preserving the error for the surface to render', (_k, err) => {
    const model = toNotesPageModel(outcomeErr(err))
    expect(model).toEqual({ status: 'error', error: err })
  })

  it('is total — every outcome yields one of the four named states', () => {
    // A guard against a future arm being added to the union with no branch here: an
    // unhandled shape would fall through to `undefined` and crash at the call site rather
    // than at the seam that is supposed to make the states exhaustive.
    const states = new Set(
      [
        toNotesPageModel(outcomeOk({ items: [NOTE], nextCursor: null })),
        toNotesPageModel(outcomeOk({ items: [], nextCursor: null })),
        toNotesPageModel(outcomeErr(appError.notFound())),
        toNotesPageModel(outcomeErr(appError.unknown())),
      ].map((m) => m.status),
    )
    expect(states).toEqual(new Set(['ready', 'empty', 'missing', 'error']))
  })
})
