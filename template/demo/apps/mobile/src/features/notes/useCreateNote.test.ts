// useCreateNote suite — jest-expo + RNTL renderHook (the desktop original
// tested this hook with renderHook under its DOM runner; the hook is pure React
// but its import closure reaches expo-constants through the tRPC client, so on
// this host it lives in the jest lane — see the runner split note in
// jest.config.js). The seam is the TYPED CLIENT: the shipped hook, the shipped
// contract parse and the shipped envelope fold all still run.
//
// Every reducer transition is driven through the PUBLIC api (submit), never a
// test-only export: start (optimistic insert at the head), settle (reconcile
// by temp id), fail (rollback removes ONLY the temp row), reject (inline field
// error, nothing inserted). Mutation settlement is test-controlled, so the
// pending window is asserted deterministically — no timers, no races.
import type { NoteView } from '@app/contracts'
import { type ActionOutcome, appError } from '@app/errors'
import { act, renderHook } from '@testing-library/react-native'
import { en } from '../../i18n/catalog'
import { installMockServer, mockApiClient, uninstallMockServer } from '../../testing/mock-server'
import { mockSupabaseClient } from '../../testing/mock-supabase'
import { type SubmitOutcome, useCreateNote } from './useCreateNote'

jest.mock('../../lib/supabase/provider', () => ({
  useSupabase: () => mockSupabaseClient(),
}))
jest.mock('../../lib/trpc/use-api', () => ({ useApi: () => mockApiClient() }))

// Full NoteView payloads — the hook re-parses every success against
// @app/contracts, so a stub that drifts from the render contract fails HERE
// rather than passing a test the app could never reproduce.
const SERVER_NOTE: NoteView = {
  createdAt: '2026-01-01T00:00:01.000Z',
  excerpt: '',
  hasBody: false,
  id: '00000000-0000-4000-8000-000000000099',
  isArchived: false,
  title: 'Hello',
  updatedAt: '2026-01-01T00:00:01.000Z',
}
const SECOND_NOTE: NoteView = {
  ...SERVER_NOTE,
  createdAt: '2026-01-01T00:00:02.000Z',
  id: '00000000-0000-4000-8000-000000000100',
  title: 'Second',
}

/** A mutation whose settlement the test controls — the held-write window. */
function heldMutation() {
  let release!: (result: ActionOutcome<NoteView>) => void
  const gate = new Promise<ActionOutcome<NoteView>>((resolve) => {
    release = resolve
  })
  const calls = jest.fn()
  const handler = (): Promise<ActionOutcome<NoteView>> => {
    calls()
    return gate
  }
  return { handler, release, calls }
}

afterEach(() => {
  uninstallMockServer()
})

describe('useCreateNote', () => {
  it('optimistically inserts a pending row while the write is held, then reconciles', async () => {
    const held = heldMutation()
    installMockServer({ notesCreate: held.handler })
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

    held.release({ ok: true, data: SERVER_NOTE })
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
    const held = heldMutation()
    let writes = 0
    installMockServer({
      notesCreate: () => {
        writes += 1
        return writes === 1 ? { ok: true, data: SERVER_NOTE } : held.handler()
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

    held.release({ ok: true, data: SECOND_NOTE })
    await act(async () => {
      await expect(outcome).resolves.toBe('settled')
    })
    expect(result.current.state.rows).toEqual([
      { id: SECOND_NOTE.id, title: 'Second', pending: false, createdAt: SECOND_NOTE.createdAt },
      { id: SERVER_NOTE.id, title: 'Hello', pending: false, createdAt: SERVER_NOTE.createdAt },
    ])
  })

  it('rolls ONLY the temp row back on a failure envelope, with TRANSLATED copy', async () => {
    let writes = 0
    installMockServer({
      notesCreate: () => {
        writes += 1
        return writes === 1
          ? { ok: true, data: SERVER_NOTE }
          : { ok: false, error: appError.unknown({ message: 'note storage exploded' }) }
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
    // The toast says what the envelope's kind means, in the user's language, plus the stable
    // code as the support handle. The server's own English message ("note storage exploded")
    // is a diagnostic for the logs and must NOT be the sentence a user is asked to read.
    const toasted: string = onFailure.mock.calls[0]?.[0] ?? ''
    expect(toasted).toContain(en['error.api.internal'])
    expect(toasted).not.toContain('note storage exploded')
  })

  it('rolls back on a transport rejection the fold turned into an envelope', async () => {
    installMockServer({
      // `callProcedure` folds a REJECTION back onto the data channel, so the
      // hook has ONE branch rather than two. This case proves the fold, not a
      // second error path in the hook.
      notesCreate: () => Promise.reject(new Error('offline')),
    })
    const onFailure = jest.fn<undefined, [string]>()
    const { result } = renderHook(() => useCreateNote(onFailure))

    await act(async () => {
      await expect(result.current.submit({ title: 'Unlucky' })).resolves.toBe('failed')
    })

    expect(result.current.state.rows).toEqual([])
    // A non-tRPC rejection is `unknown` by nature; the copy says exactly that.
    expect(onFailure.mock.calls[0]?.[0] ?? '').toContain(en['error.api.internal'])
  })

  it('rejects an invalid title at the contract boundary — no mutation, no row', async () => {
    const writes = jest.fn(() => ({ ok: true as const, data: SERVER_NOTE }))
    installMockServer({ notesCreate: writes })
    const onFailure = jest.fn()
    const { result } = renderHook(() => useCreateNote(onFailure))

    await act(async () => {
      await expect(result.current.submit({ title: '' })).resolves.toBe('rejected')
    })

    expect(result.current.state.fieldError).not.toBeNull()
    expect(result.current.state.rows).toEqual([])
    expect(writes).not.toHaveBeenCalled()
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('a corrected retry clears the field error as the optimistic insert starts', async () => {
    const held = heldMutation()
    installMockServer({ notesCreate: held.handler })
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
    const held = heldMutation()
    installMockServer({ notesCreate: held.handler })
    const { result } = renderHook(() => useCreateNote(jest.fn()))

    let first: Promise<SubmitOutcome> | undefined
    act(() => {
      first = result.current.submit({ title: 'One' })
    })
    await act(async () => {
      await expect(result.current.submit({ title: 'Two' })).resolves.toBe('rejected')
    })
    expect(held.calls).toHaveBeenCalledTimes(1)

    held.release({ ok: true, data: { ...SERVER_NOTE, title: 'One' } })
    await act(async () => {
      await expect(first).resolves.toBe('settled')
    })
  })
})
