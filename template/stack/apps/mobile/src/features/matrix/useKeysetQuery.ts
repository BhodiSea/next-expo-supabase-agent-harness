import { NOTES_PAGE_LIMIT_DEFAULT, NotesPage, type NoteView } from '@app/contracts'
import type { ActionOutcome } from '@app/errors'
import { useCallback, useEffect, useRef, useState } from 'react'
import { translateError, type UserFacingError } from '../../i18n/errors'
import { callProcedure } from '../../lib/trpc/normalize'
import { type ApiClient, useApi } from '../../lib/trpc/use-api'

// Keyset pagination over the router's { items, nextCursor } contract — the paged
// counterpart to features/notes/useListQuery. Pages append; the initial load owns
// the route's loading/empty/error surface, while a failed loadMore stays on the
// rendered data and surfaces a toast + inline retry instead of blanking it.
//
// NEVER OFFSET. The cursor is an opaque base64url token the server mints from the
// last row's (created_at, id) — an offset scan re-reads and re-discards every
// skipped row, so page 500 costs 500 pages of work, while a keyset seek is O(page)
// at any depth. The client's whole job is to hand back the token it was given.
// SOURCE: https://use-the-index-luke.com/no-offset · @app/contracts NotesListQuery

// The page size is the contract's own default, not a local 50. Two literals
// would drift the first time the server's default moved, and the symptom would
// be a client asking for a page size nobody chose.
const PAGE_LIMIT = NOTES_PAGE_LIMIT_DEFAULT

type KeysetStatus = 'empty' | 'error' | 'loading' | 'ready'

interface KeysetState {
  readonly status: KeysetStatus
  readonly rows: readonly NoteView[]
  /** Cursor for the next page, or null when the list is exhausted. */
  readonly cursor: string | null
  // Initial-load failure (status === 'error'). `.message` is TRANSLATED copy chosen by the
  // envelope's kind/code; `.detail` is the raw text, untranslatable by nature. Rendering
  // them as the same thing was the pre-0.1.6 behaviour of the desktop original, and the raw
  // one was the headline.
  readonly error: UserFacingError | null
  readonly loadingMore: boolean
  /** A loadMore just failed — the data is intact, offer an inline retry. */
  readonly loadMoreFailed: boolean
}

const INITIAL: KeysetState = {
  status: 'loading',
  rows: [],
  cursor: null,
  error: null,
  loadingMore: false,
  loadMoreFailed: false,
}

/**
 * One page, as an envelope. It never rejects: `callProcedure` has already folded
 * every transport rejection onto the data channel, so both call sites below have
 * exactly one branch to write and neither can forget the other one.
 *
 * `cursor` is SPREAD conditionally rather than passed as `cursor: cursor ?? undefined`.
 * Under `exactOptionalPropertyTypes` the contract's `cursor?: string` and
 * `{ cursor: string | undefined }` are different types, and only the first models
 * "no cursor" — which is also what keeps an explicit `undefined` out of the JSON
 * body, where it would serialize away and mean something subtly different.
 */
async function fetchPage(
  api: ApiClient,
  cursor: string | null,
  signal: AbortSignal,
): Promise<ActionOutcome<NotesPage>> {
  const outcome = await callProcedure(
    api.notes.list.query({ limit: PAGE_LIMIT, ...(cursor === null ? {} : { cursor }) }, { signal }),
  )
  if (!outcome.ok) return outcome
  // Parsed, not trusted — the same reasoning NotesPanel states: a compile-time
  // type describes the router this bundle was built against, not the bytes a
  // deployed server sent.
  return { ok: true, data: NotesPage.parse(outcome.data) }
}

export interface KeysetQuery {
  readonly state: KeysetState
  /** Fetch and append the next page. No-ops unless ready with a cursor free. */
  readonly loadMore: () => void
  /** Discard everything and re-run the initial load — the error retry. */
  readonly reload: () => void
}

export function useKeysetQuery(onLoadMoreError: (message: string) => void): KeysetQuery {
  const api = useApi()
  const [state, setState] = useState<KeysetState>(INITIAL)
  // Bumping this re-runs the initial-load effect (mount + reload) without a
  // callback in the dependency array — keeps the effect stable under the compiler.
  const [reloadToken, setReloadToken] = useState(0)
  const moreController = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchPage(api, null, controller.signal)
      .then((outcome) => {
        // An aborted load must not write state: the component is unmounted or a
        // newer load already answered, and overwriting that flickers back to
        // stale data.
        if (controller.signal.aborted) return
        if (!outcome.ok) {
          setState({
            status: 'error',
            rows: [],
            cursor: null,
            error: translateError(outcome.error),
            loadingMore: false,
            loadMoreFailed: false,
          })
          return
        }
        setState({
          status: outcome.data.items.length === 0 ? 'empty' : 'ready',
          rows: outcome.data.items,
          cursor: outcome.data.nextCursor,
          error: null,
          loadingMore: false,
          loadMoreFailed: false,
        })
      })
      .catch((cause: unknown) => {
        // Reachable only through the contract parse — the envelope has no throw
        // path. It still owns the route's error surface: a page the client
        // cannot describe is a page it must not render.
        if (controller.signal.aborted) return
        setState({
          status: 'error',
          rows: [],
          cursor: null,
          error: translateError(cause),
          loadingMore: false,
          loadMoreFailed: false,
        })
      })
    return () => {
      controller.abort()
      moreController.current?.abort()
    }
  }, [api, reloadToken])

  // Identity-stable (only touches stable useState setters): screens hand this
  // to long-lived closures without effect churn on every render.
  const reload = useCallback((): void => {
    setState(INITIAL)
    setReloadToken((token) => token + 1)
  }, [])

  const loadMore = (): void => {
    if (state.status !== 'ready' || state.cursor === null || state.loadingMore) return
    const cursor = state.cursor
    setState((current) => ({ ...current, loadingMore: true, loadMoreFailed: false }))
    const controller = new AbortController()
    moreController.current = controller
    const fail = (cause: unknown): void => {
      if (controller.signal.aborted) return
      // The rendered data SURVIVES a failed page: blanking a list the user is
      // reading because its next page failed is a worse answer than the list
      // they already have, plus an inline retry.
      setState((current) => ({ ...current, loadingMore: false, loadMoreFailed: true }))
      onLoadMoreError(translateError(cause).message)
    }
    fetchPage(api, cursor, controller.signal)
      .then((outcome) => {
        if (controller.signal.aborted) return
        if (!outcome.ok) {
          fail(outcome.error)
          return
        }
        setState((current) => ({
          ...current,
          rows: [...current.rows, ...outcome.data.items],
          cursor: outcome.data.nextCursor,
          loadingMore: false,
        }))
      })
      .catch(fail)
  }

  return { state, loadMore, reload }
}
