// LIVE API proof — the app's own modules against a REAL running server.
//
// Everything the other suites mock at the network seam runs for real here: the
// stub provider mints a real dev token (POST /auth/dev-token), useCreateNote's
// fetcher path creates a real row through the api-client one-door (bearer +
// envelope + NoteDto parse), useKeysetQuery lists it back under FORCE RLS,
// apiFetch deletes it, and streamApiSse parses a real SSE stream over real
// HTTP through the injectable-fetch seam (the same injection point jest's
// mock-network suites use — expo/fetch does not exist under node).
//
// SKIP-LOUDLY: without LIVE_PROOF=1 + EXPO_PUBLIC_API_ORIGIN this suite skips
// (it needs `pnpm db:up`, migrations, and `AUTH_MODE=stub pnpm dev:server`).
// It never fakes a pass — CI lanes that want it must provide the server.
//
//   LIVE_PROOF=1 EXPO_PUBLIC_API_ORIGIN=http://127.0.0.1:8787 \
//     pnpm --filter mobile exec jest __tests__/live-api-proof.test.ts
import { renderHook, waitFor } from '@testing-library/react-native'
import { act } from 'react'
import { createStubProvider } from '../src/auth/providers/stub'
import { installSessionProvider, sessionProvider } from '../src/auth/session'
import { useKeysetQuery } from '../src/features/matrix/useKeysetQuery'
import { useCreateNote } from '../src/features/notes/useCreateNote'
import { apiDelete, apiFetch } from '../src/lib/api-client'
import { type SseEvent, streamApiSse } from '../src/lib/sse'

// The host keychain is the ONE mocked seam (no native keystore under jest);
// the token that lands in it is a REAL server-minted JWT.
jest.mock('../src/host', () => {
  let token: string | null = null
  return {
    secureGetToken: jest.fn(() => Promise.resolve(token)),
    secureSetToken: jest.fn((next: string) => {
      token = next
      return Promise.resolve()
    }),
    secureDeleteToken: jest.fn(() => {
      token = null
      return Promise.resolve()
    }),
    secureGetRefreshToken: jest.fn(() => Promise.resolve(null)),
    secureSetRefreshToken: jest.fn(() => Promise.resolve()),
    secureDeleteRefreshToken: jest.fn(() => Promise.resolve()),
  }
})

// jest-expo installs react-native's XHR-backed fetch polyfill, which has no
// real network under jest — so the live proof supplies the TRANSPORT: a
// minimal fetch over node:http, satisfying exactly what the one door and the
// SSE consumer consume (ok/status/json + a web ReadableStream body). This is
// the same injectable-fetch seam the device fills with expo/fetch — the proof
// swaps the transport primitive, never the app modules under test.
function nodeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  // Host modules stay reachable inside the jest VM.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const http = require('node:http') as typeof import('node:http')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Readable } = require('node:stream') as typeof import('node:stream')
  const headers: Record<string, string> = {}
  new Headers(init.headers).forEach((value, key) => {
    headers[key] = value
  })
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: init.method ?? 'GET', headers }, (incoming) => {
      const status = incoming.statusCode ?? 0
      const body = Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>
      const chunks: Buffer[] = []
      let buffered: Promise<string> | null = null
      const text = (): Promise<string> => {
        buffered ??= (async () => {
          const reader = body.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            chunks.push(Buffer.from(value))
          }
          return Buffer.concat(chunks).toString('utf8')
        })()
        return buffered
      }
      resolve({
        ok: status >= 200 && status < 300,
        status,
        body,
        text,
        json: async () => JSON.parse(await text()) as unknown,
      } as unknown as Response)
    })
    request.on('error', reject)
    if (typeof init.body === 'string') request.write(init.body)
    request.end()
  })
}

const LIVE = process.env['LIVE_PROOF'] === '1' && Boolean(process.env['EXPO_PUBLIC_API_ORIGIN'])
if (!LIVE) {
  // eslint-disable-next-line no-console -- the loud half of skip-loudly
  console.log(
    '[live-api-proof] SKIPPED — set LIVE_PROOF=1 and EXPO_PUBLIC_API_ORIGIN against a running AUTH_MODE=stub server to run it',
  )
}

const describeLive = LIVE ? describe : describe.skip

const transcript: string[] = []
function say(line: string): void {
  transcript.push(line)
  // eslint-disable-next-line no-console -- the proof IS its printed transcript
  console.log(`[live] ${line}`)
}

describeLive('live API proof (real server, real Postgres, FORCE RLS)', () => {
  jest.setTimeout(30_000)

  const rnFetch = globalThis.fetch
  beforeAll(() => {
    // Install the real transport where RN's networkless jest polyfill sits —
    // every app module then talks to the live server through its own code.
    globalThis.fetch = nodeFetch as typeof globalThis.fetch
  })
  afterAll(() => {
    globalThis.fetch = rnFetch
  })

  it('signs in, creates + lists + deletes a note through the app modules, and streams SSE ticks', async () => {
    // 1 — dev sign-in through the REAL stub authority (the provider stores the
    // minted JWT behind the mocked host seam; api-client replays it per request).
    installSessionProvider(createStubProvider())
    await sessionProvider().signIn()
    say('signed in: dev token minted via POST /auth/dev-token and stored host-side')

    // 2 — optimistic create through useCreateNote's real fetcher path.
    const onFailure = jest.fn()
    const create = renderHook(() => useCreateNote(onFailure))
    const title = `live proof ${String(Date.now())}`
    let outcome = ''
    await act(async () => {
      outcome = await create.result.current.submit({ title })
    })
    expect(outcome).toBe('settled')
    expect(onFailure).not.toHaveBeenCalled()
    const created = create.result.current.state.rows[0]
    if (created === undefined) throw new Error('no reconciled row after settle')
    expect(created.pending).toBe(false)
    say(`created note ${created.id} ("${title}") — reconciled with the server row`)

    // 3 — list it back through useKeysetQuery (RLS: the page is OUR user's rows).
    const list = renderHook(() => useKeysetQuery(jest.fn()))
    await waitFor(() => {
      expect(list.result.current.state.status).toBe('ready')
    })
    const listed = list.result.current.state.rows.find((row) => row.id === created.id)
    if (listed === undefined) throw new Error('created note missing from the listed page')
    say(
      `listed it back under RLS: ${String(list.result.current.state.rows.length)} row(s) visible, ownerId ${listed.ownerId}`,
    )

    // 4 — delete through the one door; 204 has no body.
    const del = await apiFetch(`/api/notes/${created.id}`, { method: 'DELETE' })
    expect(del.status).toBe(204)
    act(() => {
      list.result.current.reload()
    })
    await waitFor(() => {
      expect(
        list.result.current.state.rows.every((row) => row.id !== created.id) &&
          list.result.current.state.status !== 'loading',
      ).toBe(true)
    })
    say(`deleted ${created.id} (204) — gone from the reloaded page`)

    // 5 — SSE: three real ticks through the hand-rolled parser, the node
    // transport injected at the same seam expo/fetch occupies on the device.
    const events: SseEvent[] = []
    await streamApiSse('/api/events/demo', (event) => events.push(event), {
      fetchImpl: nodeFetch,
    })
    expect(events.map((event) => event.event)).toEqual(['tick', 'tick', 'tick'])
    expect(events.map((event) => event.data)).toEqual(['1', '2', '3'])
    expect(events.map((event) => event.id)).toEqual(['1', '2', '3'])
    say(`SSE: parsed ${String(events.length)} ticks ${JSON.stringify(events)}`)

    say('TRANSCRIPT COMPLETE')
    expect(transcript.at(-1)).toBe('TRANSCRIPT COMPLETE')
  })

  it('account deletion (Apple 5.1.1(v)): DELETE /api/me sweeps the account through the one door', async () => {
    // Fresh session, fresh data — then the deletion the store reviewer looks for.
    installSessionProvider(createStubProvider())
    await sessionProvider().signIn()
    const create = renderHook(() => useCreateNote(jest.fn()))
    await act(async () => {
      await create.result.current.submit({ title: `to be deleted ${String(Date.now())}` })
    })
    say('account-deletion fixture: signed in and created one note')

    const del = await apiDelete('/api/me')
    expect(del.status).toBe(204)

    // The account is empty on the server: a fresh list under the SAME identity
    // comes back with zero rows (RLS scopes the page to this user).
    const list = renderHook(() => useKeysetQuery(jest.fn()))
    await waitFor(() => {
      expect(list.result.current.state.status === 'empty').toBe(true)
    })
    say('account deleted: DELETE /api/me answered 204 and the reloaded page is empty')
  })
})
