import type { ActionOutcome } from '@app/errors'
import { useCallback, useEffect, useRef, useState } from 'react'
import { translateError, type UserFacingError } from '../../i18n/errors'

// The UNPAGED read exemplar — one page, three canonical data states, and a
// reload. Its paged counterpart is features/matrix/useKeysetQuery; the two are
// deliberately separate hooks rather than one with a `paged` flag, because the
// paged one has to own a cursor, an append path, and a loadMore failure that
// must NOT blank the rendered data, and folding that into the simple case would
// make every consumer of the simple case read the complicated one.
//
// WHAT THIS HOOK DOES NOT DO, and why it is not an oversight: there is no cache,
// no dedupe, no background refetch and no shared query key. A cache is a second
// source of truth about the server, and the moment one exists every screen owes
// it an invalidation. This app's read surface is two lists that reload on
// demand; the honest implementation of that is a fetch and a `useState`. A
// consumer that grows a real cache need should reach for a query library
// deliberately — replacing this file — rather than inherit half of one.
//
// THE ENVELOPE IS THE WHOLE FAILURE VOCABULARY. The fetcher returns
// `ActionOutcome`, never a rejected promise: `callProcedure` (src/lib/trpc/
// normalize.ts) has already folded transport rejections onto the data channel
// upstream. So the `.catch` below is not the error path — it is the last line of
// defence against a bug in the hook's own plumbing, and it lands in the same
// place a domain failure does.
// SOURCE: packages/platform/errors/src/index.ts (the envelope rule — AppError on the data channel)

/**
 * What the hook calls. It takes the signal so an unmounted screen (or a reload
 * that overtakes a slow page) cancels the in-flight request instead of resolving
 * into a component that is gone.
 */
export type ListFetcher<T> = (signal: AbortSignal) => Promise<ActionOutcome<readonly T[]>>

/**
 * The three canonical data states src/routes.ts declares a testID for, plus the
 * ready one. `empty` is its OWN state and not `ready` with a zero-length array:
 * the manifest contract asks each route to render a distinguishable empty
 * surface, and a consumer that has to write `items.length === 0` at every call
 * site will eventually write it wrong at one of them.
 */
export type ListQueryState<T> =
  | { readonly status: 'empty' }
  | { readonly status: 'error'; readonly error: UserFacingError }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly items: readonly T[] }

export interface ListQuery<T> {
  readonly state: ListQueryState<T>
  /** Discard and re-run — the error surface's retry and the pull-to-refresh. */
  readonly reload: () => void
}

export function useListQuery<T>(fetchList: ListFetcher<T>): ListQuery<T> {
  const [state, setState] = useState<ListQueryState<T>>({ status: 'loading' })
  // Bumping this re-runs the load. The effect depends on the TOKEN and nothing
  // else — see the ref below for why the fetcher is deliberately not a dep.
  const [reloadToken, setReloadToken] = useState(0)

  // The fetcher closes over the tRPC client, which a screen resolves with
  // useApi() during render — so it is a NEW function identity every render. As
  // an effect dependency it would re-fire the query on every keystroke in the
  // composer above the list. The latest-ref pattern keeps the effect keyed on
  // intent (mount, reload) while still calling the current closure.
  const latest = useRef(fetchList)
  // Refresh the ref in a passive effect, never during render — mutating a ref
  // mid-render is impure (react-hooks/refs). This effect has no dependency
  // array, so it runs on every commit and is declared BEFORE the keyed effect
  // below, so `latest.current` is the current closure by the time that effect
  // reads it on a mount/reload.
  useEffect(() => {
    latest.current = fetchList
  })

  useEffect(() => {
    const controller = new AbortController()
    latest
      .current(controller.signal)
      .then((outcome) => {
        // An aborted request must not write state: its component is either
        // unmounted or already showing a newer load's result, and overwriting
        // that is how a reload flickers back to stale data.
        if (controller.signal.aborted) return
        if (!outcome.ok) {
          setState({ status: 'error', error: translateError(outcome.error) })
          return
        }
        setState(
          outcome.data.length === 0
            ? { status: 'empty' }
            : { status: 'ready', items: outcome.data },
        )
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setState({ status: 'error', error: translateError(cause) })
      })
    return () => {
      controller.abort()
    }
  }, [reloadToken])

  // Identity-stable (it touches only the stable useState setters), so screens
  // can hand it straight to a Button or a RefreshControl without churning them.
  const reload = useCallback((): void => {
    setState({ status: 'loading' })
    setReloadToken((token) => token + 1)
  }, [])

  return { state, reload }
}
