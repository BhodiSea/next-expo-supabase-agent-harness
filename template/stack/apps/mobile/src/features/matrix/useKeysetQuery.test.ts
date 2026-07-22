// useKeysetQuery suite — jest-expo + RNTL renderHook (same runner-split
// reasoning as useCreateNote.test.ts: the hook is pure React, but its import
// closure reaches expo-constants through the api-client). The network runs
// through the mock server, so origin/bearer/envelope code is the shipped code.
//
// Mock-server keys are METHOD + full path INCLUDING the query string — the
// hook's own page requests ('?limit=50', '?limit=50&cursor=…') are what the
// keys pin, which doubles as an assertion that the cursor actually rides the
// second request.
import { act, renderHook, waitFor } from '@testing-library/react-native'
import { setAccessTokenProvider } from '../../lib/api-client'
import { installMockServer, uninstallMockServer } from '../../testing/mock-server'
import { useKeysetQuery } from './useKeysetQuery'

const FIRST_PAGE_KEY = 'GET /api/notes?limit=50'
const SECOND_PAGE_KEY = 'GET /api/notes?limit=50&cursor=c2'

function note(id: string) {
  return {
    // NoteDto validates id/ownerId as UUIDs — build valid ones from the label.
    id: `00000000-0000-4000-8000-${id.padStart(12, '0')}`,
    ownerId: '00000000-0000-4000-8000-0000000000aa',
    title: `note ${id}`,
    body: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    embedding: null,
    sourceConfidence: null,
    sourceModel: null,
  }
}

function page(ids: readonly string[], nextCursor: string | null) {
  return { status: 200, body: { items: ids.map(note), nextCursor } }
}

const ENVELOPE_500 = { status: 500, body: { error: {} } }

const noop = (): void => undefined

beforeAll(() => {
  setAccessTokenProvider(() => Promise.resolve('test-token'))
})

afterEach(() => {
  uninstallMockServer()
})

describe('useKeysetQuery', () => {
  it('loads the first page into the ready state with rows and a cursor', async () => {
    installMockServer({ [FIRST_PAGE_KEY]: () => page(['1', '2'], 'c2') })
    const { result } = renderHook(() => useKeysetQuery(noop))
    await waitFor(() => {
      expect(result.current.state.status).toBe('ready')
    })
    expect(result.current.state.rows.length).toBe(2)
    expect(result.current.state.cursor).toBe('c2')
  })

  it('an empty first page is the empty state', async () => {
    installMockServer({ [FIRST_PAGE_KEY]: () => page([], null) })
    const { result } = renderHook(() => useKeysetQuery(noop))
    await waitFor(() => {
      expect(result.current.state.status).toBe('empty')
    })
  })

  it('an initial-load failure owns the route error state', async () => {
    installMockServer({ [FIRST_PAGE_KEY]: () => ENVELOPE_500 })
    const { result } = renderHook(() => useKeysetQuery(noop))
    await waitFor(() => {
      expect(result.current.state.status).toBe('error')
    })
    // The failure arrives as a UserFacingError: `.message` is TRANSLATED copy chosen by the
    // envelope's `code` (here the body has no valid envelope, so the client falls back to
    // the status), and `.detail` keeps the raw text a support engineer needs.
    expect(result.current.state.error?.message).toContain('500')
    expect(result.current.state.error?.detail).toContain('500')
  })

  it('loadMore appends the next page and forwards the cursor', async () => {
    const secondPage = jest.fn(() => page(['2'], null))
    installMockServer({
      [FIRST_PAGE_KEY]: () => page(['1'], 'c2'),
      [SECOND_PAGE_KEY]: secondPage,
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
    // The cursor rode the request — the mock key would not have matched otherwise.
    expect(secondPage).toHaveBeenCalledTimes(1)
  })

  it('a loadMore failure raises the callback + inline retry flag, data intact', async () => {
    const onError = jest.fn()
    installMockServer({
      [FIRST_PAGE_KEY]: () => page(['1'], 'c2'),
      [SECOND_PAGE_KEY]: () => ENVELOPE_500,
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
    expect(result.current.state.status).toBe('ready')
    expect(result.current.state.rows.length).toBe(1)
  })

  it('reload aborts a slow initial load so a stale response cannot overwrite newer state', async () => {
    let resolveFirst: (result: { status: number; body: unknown }) => void = () => undefined
    const first = new Promise<{ status: number; body: unknown }>((resolve) => {
      resolveFirst = resolve
    })
    let calls = 0
    installMockServer({
      [FIRST_PAGE_KEY]: () => {
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
