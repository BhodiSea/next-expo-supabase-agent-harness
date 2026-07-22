// useCreateNote suite — jest-expo + RNTL renderHook (the desktop original
// tested this hook with renderHook under its DOM runner; the hook is pure React
// but its import closure reaches expo-constants through the api-client, so on
// this host it lives in the jest lane — see the runner split note in
// jest.config.js). The NETWORK seam is the mock server: the shipped api-client
// code (origin, bearer, envelope decoding) still runs.
//
// Every reducer transition is driven through the PUBLIC api (submit), never a
// test-only export: start (optimistic insert at the head), settle (reconcile
// by temp id), fail (rollback removes ONLY the temp row), reject (inline field
// error, nothing inserted). Fetch settlement is test-controlled, so the
// pending window is asserted deterministically — no timers, no races.
import { act, renderHook } from '@testing-library/react-native'
import { en } from '../../i18n/catalog'
import { setAccessTokenProvider } from '../../lib/api-client'
import {
  installMockServer,
  type MockRouteHandler,
  uninstallMockServer,
} from '../../testing/mock-server'
import { type SubmitOutcome, useCreateNote } from './useCreateNote'

// Full NoteDto bodies — the hook Zod-parses every 201, so stubs must honor the
// @app/contracts contract exactly.
const SERVER_NOTE = {
  id: '00000000-0000-4000-8000-000000000099',
  ownerId: '00000000-0000-4000-8000-0000000000aa',
  title: 'Hello',
  body: '',
  createdAt: '2026-01-01T00:00:01.000Z',
  embedding: null,
  sourceConfidence: null,
  sourceModel: null,
}
const SECOND_NOTE = {
  ...SERVER_NOTE,
  id: '00000000-0000-4000-8000-000000000100',
  title: 'Second',
  createdAt: '2026-01-01T00:00:02.000Z',
}

interface MockResult {
  readonly status: number
  readonly body: unknown
}

/** A route whose settlement the test controls — the held-POST window. */
function heldRoute() {
  let release!: (result: MockResult) => void
  const gate = new Promise<MockResult>((resolve) => {
    release = resolve
  })
  const calls = jest.fn()
  const handler: MockRouteHandler = () => {
    calls()
    return gate
  }
  return { handler, release, calls }
}

beforeAll(() => {
  // The hook posts through the one door; give the door a session.
  setAccessTokenProvider(() => Promise.resolve('test-token'))
})

afterEach(() => {
  uninstallMockServer()
})

describe('useCreateNote', () => {
  it('optimistically inserts a pending row while the POST is held, then reconciles on 201', async () => {
    const held = heldRoute()
    installMockServer({ 'POST /api/notes': held.handler })
    const onFailure = jest.fn()
    const { result } = renderHook(() => useCreateNote(onFailure))

    let outcome: Promise<SubmitOutcome> | undefined
    act(() => {
      outcome = result.current.submit({ title: 'Hello' })
    })

    // BEFORE fulfillment: the temp row is in the state, marked pending.
    expect(result.current.state.status).toBe('pending')
    expect(result.current.state.rows).toHaveLength(1)
    expect(result.current.state.rows[0]?.pending).toBe(true)
    expect(result.current.state.rows[0]?.title).toBe('Hello')
    const tempId = result.current.state.rows[0]?.id

    held.release({ status: 201, body: SERVER_NOTE })
    await act(async () => {
      await expect(outcome).resolves.toBe('settled')
    })

    // Reconciled: the SERVER row replaced the temp row (matched by temp id).
    expect(result.current.state.status).toBe('idle')
    expect(result.current.state.rows).toEqual([
      { id: SERVER_NOTE.id, title: 'Hello', pending: false, createdAt: SERVER_NOTE.createdAt },
    ])
    expect(result.current.state.rows[0]?.id).not.toBe(tempId)
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('a second create inserts at the head and reconciles only its own temp row', async () => {
    const held = heldRoute()
    let posts = 0
    installMockServer({
      'POST /api/notes': () => {
        posts += 1
        return posts === 1
          ? { status: 201, body: SERVER_NOTE }
          : held.handler({ url: '', body: null })
      },
    })
    const { result } = renderHook(() => useCreateNote(jest.fn()))

    await act(async () => {
      await expect(result.current.submit({ title: 'Hello' })).resolves.toBe('settled')
    })

    let outcome: Promise<SubmitOutcome> | undefined
    act(() => {
      outcome = result.current.submit({ title: 'Second' })
    })
    // Newest first: the pending temp row sits AHEAD of the reconciled row.
    expect(result.current.state.rows.map((row) => row.pending)).toEqual([true, false])
    expect(result.current.state.rows[1]).toEqual({
      createdAt: SERVER_NOTE.createdAt,
      id: SERVER_NOTE.id,
      title: 'Hello',
      pending: false,
    })

    held.release({ status: 201, body: SECOND_NOTE })
    await act(async () => {
      await expect(outcome).resolves.toBe('settled')
    })
    expect(result.current.state.rows).toEqual([
      { id: SECOND_NOTE.id, title: 'Second', pending: false, createdAt: SECOND_NOTE.createdAt },
      { id: SERVER_NOTE.id, title: 'Hello', pending: false, createdAt: SERVER_NOTE.createdAt },
    ])
  })

  it('rolls ONLY the temp row back on a 500 and surfaces TRANSLATED copy, not the raw message', async () => {
    let posts = 0
    installMockServer({
      'POST /api/notes': () => {
        posts += 1
        return posts === 1
          ? { status: 201, body: SERVER_NOTE }
          : { status: 500, body: { error: { code: 'internal', message: 'note storage exploded' } } }
      },
    })
    // Typed mock: the toast inspection below reads mock.calls, and an untyped
    // jest.fn() would make that an any-chain the type-aware lint rejects.
    const onFailure = jest.fn<undefined, [string]>()
    const { result } = renderHook(() => useCreateNote(onFailure))

    await act(async () => {
      await expect(result.current.submit({ title: 'Hello' })).resolves.toBe('settled')
    })
    await act(async () => {
      await expect(result.current.submit({ title: 'Doomed' })).resolves.toBe('failed')
    })

    // Rollback removed the temp row and ONLY the temp row — never a phantom.
    expect(result.current.state.status).toBe('error')
    expect(result.current.state.rows).toEqual([
      { id: SERVER_NOTE.id, title: 'Hello', pending: false, createdAt: SERVER_NOTE.createdAt },
    ])
    // The toast says what the envelope's `code` means, in the user's language. The server's own
    // English message ("note storage exploded") is a diagnostic for the logs and must NOT be the
    // sentence a user is asked to read.
    const toasted: string = onFailure.mock.calls[0]?.[0] ?? ''
    expect(toasted).toContain(en['error.api.internal'])
    expect(toasted).not.toContain('note storage exploded')
  })

  it('rolls back on a network failure with translated copy (no envelope exists to quote)', async () => {
    installMockServer({
      'POST /api/notes': () => {
        throw new Error('offline')
      },
    })
    const onFailure = jest.fn()
    const { result } = renderHook(() => useCreateNote(onFailure))

    await act(async () => {
      await expect(result.current.submit({ title: 'Unlucky' })).resolves.toBe('failed')
    })

    expect(result.current.state.rows).toEqual([])
    // No envelope, so no code: the client says the one true thing it knows.
    expect(onFailure).toHaveBeenCalledWith(en['error.api.offline'])
  })

  it('rejects an invalid title at the contract boundary — no fetch, no row', async () => {
    const posts = jest.fn()
    installMockServer({
      'POST /api/notes': () => {
        posts()
        return { status: 201, body: SERVER_NOTE }
      },
    })
    const onFailure = jest.fn()
    const { result } = renderHook(() => useCreateNote(onFailure))

    await act(async () => {
      await expect(result.current.submit({ title: '' })).resolves.toBe('rejected')
    })

    expect(result.current.state.fieldError).not.toBeNull()
    expect(result.current.state.rows).toEqual([])
    expect(posts).not.toHaveBeenCalled()
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('a corrected retry clears the field error as the optimistic insert starts', async () => {
    const held = heldRoute()
    installMockServer({ 'POST /api/notes': held.handler })
    const { result } = renderHook(() => useCreateNote(jest.fn()))

    await act(async () => {
      await result.current.submit({ title: '' })
    })
    expect(result.current.state.fieldError).not.toBeNull()

    act(() => {
      void result.current.submit({ title: 'Fixed' })
    })
    expect(result.current.state.fieldError).toBeNull()
    expect(result.current.state.status).toBe('pending')
  })

  it('is single-flight: a second submit while one is pending is rejected', async () => {
    const held = heldRoute()
    installMockServer({ 'POST /api/notes': held.handler })
    const { result } = renderHook(() => useCreateNote(jest.fn()))

    let first: Promise<SubmitOutcome> | undefined
    act(() => {
      first = result.current.submit({ title: 'One' })
    })
    await act(async () => {
      await expect(result.current.submit({ title: 'Two' })).resolves.toBe('rejected')
    })
    expect(held.calls).toHaveBeenCalledTimes(1)

    held.release({ status: 201, body: { ...SERVER_NOTE, title: 'One' } })
    await act(async () => {
      await expect(first).resolves.toBe('settled')
    })
  })
})
