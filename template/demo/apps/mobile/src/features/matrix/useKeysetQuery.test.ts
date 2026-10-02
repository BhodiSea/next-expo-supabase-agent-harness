// useKeysetQuery suite — jest-expo + RNTL renderHook (same runner-split
// reasoning as useCreateNote.test.ts: the hook is pure React, but its import
// closure reaches expo-constants through the tRPC client).
//
// The seam is the TYPED CLIENT, so the cursor assertions read `input.cursor`
// directly rather than pattern-matching a URL and hoping the query string was
// assembled the way the test guessed. What the double replaces is the HTTP link;
// what still runs is the hook, the contract parse, and `callProcedure`.
import type { NotesPage, NoteView } from '@app/contracts'
import { type ActionOutcome, appError } from '@app/errors'
import { act, renderHook, waitFor } from '@testing-library/react-native'
import { installMockServer, mockApiClient, uninstallMockServer } from '../../testing/mock-server'
import { mockSupabaseClient } from '../../testing/mock-supabase'
import { useKeysetQuery } from './useKeysetQuery'

jest.mock('../../lib/supabase/provider', () => ({
  useSupabase: () => mockSupabaseClient(),
}))
jest.mock('../../lib/trpc/use-api', () => ({ useApi: () => mockApiClient() }))

const SECOND_CURSOR = 'c2'

// The SHIPPED contract shape, not a locally re-declared twin — a hand-written
// double drifts silently the day the contract gains a field, and every test keeps
// passing while the screen renders undefined.
type Page = ActionOutcome<NotesPage>

// NoteView is re-parsed by the hook against @app/contracts, so a fixture that
// drifts from the render contract fails HERE rather than passing a test the app
// could never reproduce. The uuids are built from the label so a failure names
// the row it came from.
function note(id: string): NoteView {
  return {
    createdAt: '2026-01-01T00:00:00.000Z',
    excerpt: '',
    hasBody: false,
    id: `00000000-0000-4000-8000-${id.padStart(12, '0')}`,
    isArchived: false,
    title: `note ${id}`,
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function page(ids: readonly string[], nextCursor: string | null): Page {
  return { ok: true, data: { items: ids.map(note), nextCursor } }
}

// A domain failure on the DATA channel — the envelope rule. Nothing throws.
const FAILURE: ActionOutcome<never> = {
  ok: false,
  error: appError.unknown({ message: 'page exploded' }),
}

const noop = (): void => undefined

afterEach(() => {
  uninstallMockServer()
})

describe('useKeysetQuery', () => {
  it('loads the first page into the ready state with rows and a cursor', async () => {
    installMockServer({ notesList: () => page(['1', '2'], SECOND_CURSOR) })
    const { result } = renderHook(() => useKeysetQuery(noop))
    await waitFor(() => {
      expect(result.current.state.status).toBe('ready')
    })
    expect(result.current.state.rows.length).toBe(2)
    expect(result.current.state.cursor).toBe(SECOND_CURSOR)
  })

  it('an empty first page is the empty state', async () => {
    installMockServer({ notesList: () => page([], null) })
    const { result } = renderHook(() => useKeysetQuery(noop))
    await waitFor(() => {
      expect(result.current.state.status).toBe('empty')
    })
  })

  it('an initial-load failure owns the route error state, translated', async () => {
    installMockServer({ notesList: () => FAILURE })
    const { result } = renderHook(() => useKeysetQuery(noop))
    await waitFor(() => {
      expect(result.current.state.status).toBe('error')
    })
    // The failure arrives as a UserFacingError: `.message` is TRANSLATED copy chosen by the
    // envelope's kind, `.detail` keeps the raw text a support engineer needs, and `.code` is
    // the stable handle that turns "it failed" into something greppable in a server log.
    expect(result.current.state.error?.detail).toBe('page exploded')
    expect(result.current.state.error?.code).toBe('unknown')
    expect(result.current.state.error?.message).not.toBe('page exploded')
  })

  it('loadMore appends the next page and forwards the cursor VERBATIM', async () => {
    const seen: (string | undefined)[] = []
    installMockServer({
      notesList: (input) => {
        seen.push(input.cursor)
        return input.cursor === undefined ? page(['1'], SECOND_CURSOR) : page(['2'], null)
      },
    })
    const { result } = renderHook(() => useKeysetQuery(noop))
    await waitFor(() => {
      expect(result.current.state.status).toBe('ready')
    })
    act(() => {
      result.current.loadMore()
    })
    await waitFor(() => {
      expect(result.current.state.rows.length).toBe(2)
    })
    expect(result.current.state.cursor).toBeNull()
    // The page token is OPAQUE: the only correct client handling is to send back
    // exactly what arrived, so this equality IS the contract. A client that
    // parsed or rebuilt it would break the day the keyset encoding changed.
    expect(seen).toEqual([undefined, SECOND_CURSOR])
  })

  it('a loadMore failure raises the callback + inline retry flag, data intact', async () => {
    const onError = jest.fn()
    installMockServer({
      notesList: (input) => (input.cursor === undefined ? page(['1'], SECOND_CURSOR) : FAILURE),
    })
    const { result } = renderHook(() => useKeysetQuery(onError))
    await waitFor(() => {
      expect(result.current.state.status).toBe('ready')
    })
    act(() => {
      result.current.loadMore()
    })
    await waitFor(() => {
      expect(result.current.state.loadMoreFailed).toBe(true)
    })
    expect(onError).toHaveBeenCalledTimes(1)
    // The rendered data SURVIVES: blanking a list the user is reading because
    // its NEXT page failed is a worse answer than the list plus a retry.
    expect(result.current.state.status).toBe('ready')
    expect(result.current.state.rows.length).toBe(1)
  })

  it('reload aborts a slow initial load so a stale response cannot overwrite newer state', async () => {
    let resolveFirst: (result: Page) => void = () => undefined
    const first = new Promise<Page>((resolve) => {
      resolveFirst = resolve
    })
    let calls = 0
    installMockServer({
      notesList: () => {
        calls += 1
        return calls === 1 ? first : page([], null)
      },
    })
    const { result } = renderHook(() => useKeysetQuery(noop))
    expect(result.current.state.status).toBe('loading')
    act(() => {
      result.current.reload()
    })
    await waitFor(() => {
      expect(result.current.state.status).toBe('empty')
    })
    act(() => {
      resolveFirst(page(['1'], 'x'))
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.state.status).toBe('empty')
  })
})
