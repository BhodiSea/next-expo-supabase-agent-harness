import { type Note, NotesPage } from '@app/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { translateError, type UserFacingError } from '../../i18n/errors'
import { apiFetch } from '../../lib/api-client'

// Keyset pagination over the server's { items, nextCursor } contract — the paged
// counterpart to features/notes/useListQuery. Pages append; the initial load owns
// the route's loading/empty/error surface, while a failed loadMore stays on the
// rendered data and surfaces a toast + inline retry instead of blanking it.

const PAGE_LIMIT = 50

type KeysetStatus = 'loading' | 'empty' | 'error' | 'ready'

interface KeysetState {
  readonly status: KeysetStatus
  readonly rows: readonly Note[]
  /** Cursor for the next page, or null when the list is exhausted. */
  readonly cursor: string | null
  // Initial-load failure (status === 'error'). `.message` is TRANSLATED copy chosen by the
  // envelope's stable `code`; `.detail` is the raw text, untranslatable by nature. Rendering
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

async function fetchPage(
  cursor: string | null,
  signal: AbortSignal,
): Promise<{
  readonly items: readonly Note[]
  readonly nextCursor: string | null
}> {
  const query = new URLSearchParams({ limit: String(PAGE_LIMIT) })
  if (cursor !== null) query.set('cursor', cursor)
  const response = await apiFetch(`/api/notes?${query.toString()}`, { signal })
  return NotesPage.parse(await response.json())
}

export interface KeysetQuery {
  readonly state: KeysetState
  /** Fetch and append the next page. No-ops unless ready with a cursor free. */
  readonly loadMore: () => void
  /** Discard everything and re-run the initial load — the error retry. */
  readonly reload: () => void
}

export function useKeysetQuery(onLoadMoreError: (message: string) => void): KeysetQuery {
  const [state, setState] = useState<KeysetState>(INITIAL)
  // Bumping this re-runs the initial-load effect (mount + reload) without a
  // callback in the dependency array — keeps the effect stable under the compiler.
  const [reloadToken, setReloadToken] = useState(0)
  const moreController = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchPage(null, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return
        setState({
          status: page.items.length === 0 ? 'empty' : 'ready',
          rows: page.items,
          cursor: page.nextCursor,
          error: null,
          loadingMore: false,
          loadMoreFailed: false,
        })
      })
      .catch((cause: unknown) => {
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
  }, [reloadToken])

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
    fetchPage(cursor, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return
        setState((current) => ({
          ...current,
          rows: [...current.rows, ...page.items],
          cursor: page.nextCursor,
          loadingMore: false,
        }))
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setState((current) => ({ ...current, loadingMore: false, loadMoreFailed: true }))
        onLoadMoreError(translateError(cause).message)
      })
  }

  return { state, loadMore, reload }
}
