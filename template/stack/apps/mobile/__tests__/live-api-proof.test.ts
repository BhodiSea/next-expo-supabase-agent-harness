/**
 * @jest-environment node
 */
// live-api-proof — the ONE integration test that exercises the REAL
// mobile -> web-hosted-tRPC path against a LIVE Supabase + Next stack, and
// proves the auth seam end to end.
//
// WHAT THIS FILE IS FOR. The CI "integration lane" and the C01 canary both name
// this test. C01 strips the bearer attachment in
// apps/mobile/src/lib/trpc/client.ts (the `authorization: Bearer ${token}` line
// inside the httpBatchLink `headers()` callback — "the one door"). With the
// bearer gone, every authenticated procedure below must go red. So the assertions
// here are written to PASS only when a real GoTrue access token flows through the
// REAL client factory and reaches the web host's bearer-verification path.
//
// SELF-SKIP. Unless `LIVE_PROOF=1`, the suite is `describe.skip`: zero network,
// zero real work. The agent-time gate strips LIVE_PROOF, and the mocked mobile
// lanes must never hit a socket, so all live work is confined to `beforeAll`/`it`
// bodies (which do not run under skip) — nothing at module top or in the describe
// body touches the network.
//
// ENVIRONMENT. Node test environment (real global fetch) rather than the RN
// default. `expo-constants` is mocked so the client's `x-client-version` header
// parses to the SAME major the dev server reports (major 0 for 0.1.0): the
// version-skew guard rides the base of the procedure ladder and would otherwise
// reject a 'dev' version with CONFLICT before auth ever runs — and skew is not
// what this test is here to exercise. The bearer attachment itself is untouched.

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createClient } from '@supabase/supabase-js'
import { type ApiClient, createApiClient } from '../src/lib/trpc/client'

// ---------------------------------------------------------------------------
// REAL fetch for this suite.
//
// The jest-expo preset installs React Native's whatwg-fetch polyfill, wired to
// the MOCKED native Networking module — so the environment's `fetch` returns an
// empty stub (status undefined) and never touches a socket. That is correct for
// component tests and fatal for this one, which must reach the live stack. Node
// ships a real fetch but the polyfill overwrote the global, and no undici/
// node-fetch package is installed to borrow one from. So we install a minimal,
// real `fetch` over node:http(s) — enough for supabase-js (GoTrue admin/auth +
// PostgREST) and the tRPC httpBatchLink (GET queries, POST mutations). It is set
// as `globalThis.fetch` BEFORE any client is built, so the REAL createApiClient
// picks it up with no injection — the bearer-attachment code stays untouched.
// ---------------------------------------------------------------------------
// Takes `RequestInit['headers']` verbatim so the call site needs no assertion: whatever
// shape fetch accepts, this flattens.
function headerEntries(init: RequestInit['headers']): [string, string][] {
  if (init === undefined) return []
  if (Array.isArray(init)) {
    // `Array.isArray` narrows to `any[]`, so the element type has to be re-stated or the
    // inferred `[any, any][]` escapes as the return value. `readonly string[]` (not a
    // 2-tuple) is the honest element type — it accepts both the `string[][]` and the
    // readonly-tuple spellings of HeadersInit without an unsound tuple assertion.
    const out: [string, string][] = []
    for (const [k, v] of init as readonly (readonly string[])[]) {
      if (k !== undefined && v !== undefined) out.push([k, v])
    }
    return out
  }
  if (typeof (init as Headers).forEach === 'function') {
    const out: [string, string][] = []
    ;(init as Headers).forEach((v, k) => out.push([k, v]))
    return out
  }
  return Object.entries(init as Record<string, string>)
}

function nodeFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input))
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  const headers: Record<string, string> = {}
  for (const [k, v] of headerEntries(init.headers)) headers[k] = v
  // The clients under test (supabase-js and the tRPC httpBatchLink) both send JSON STRING
  // bodies. Narrowing rather than blind-stringifying keeps that assumption visible: a
  // stream or FormData would silently become "[object Object]" on the wire and the proof
  // would assert against a request nobody meant to send.
  const body = typeof init.body === 'string' ? init.body : undefined
  if (body !== undefined && headers['content-length'] === undefined) {
    headers['content-length'] = String(Buffer.byteLength(body))
  }
  return new Promise<Response>((resolve, reject) => {
    const req = send(url, { method: (init.method ?? 'GET').toUpperCase(), headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        const status = res.statusCode ?? 0
        const hdrs = new Headers()
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') hdrs.set(k, v)
          else if (Array.isArray(v)) hdrs.set(k, v.join(', '))
        }
        const make = (): Response =>
          ({
            ok: status >= 200 && status < 300,
            status,
            statusText: res.statusMessage ?? '',
            url: url.toString(),
            headers: hdrs,
            text: () => Promise.resolve(text),
            json: () => Promise.resolve(text === '' ? null : JSON.parse(text)),
            arrayBuffer: () => Promise.resolve(new TextEncoder().encode(text).buffer),
            clone: () => make(),
            body: null,
          }) as unknown as Response
        resolve(make())
      })
    })
    req.on('error', reject)
    const signal = init.signal
    if (signal != null) signal.addEventListener('abort', () => req.destroy(new Error('aborted')))
    if (body !== undefined) req.write(body)
    req.end()
  })
}

// Same-major client version so the skew guard passes. This mocks ONLY the version
// string the client stamps into `x-client-version`; the bearer-attachment code
// under test is the real thing. `extra` is empty so `webOrigin()` falls through to
// EXPO_PUBLIC_WEB_ORIGIN (the value babel-preset-expo inlines at transform time).
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '0.1.0', extra: {} } },
}))

const LIVE = process.env['LIVE_PROOF'] === '1'
// An all-skipped file is a clean jest outcome; a failing/vacuous one is not.
const suite = LIVE ? describe : describe.skip

// Every client in this proof is built the same way: no session persistence, no refresh
// timer, no URL detection — three long-lived clients in one jest process would otherwise
// race each other's token refreshes.
//
// The factory exists for its TYPE as much as its body. Annotating the holders as bare
// `SupabaseClient` applies that alias's DEFAULT type arguments, which are not the ones
// `createClient` actually returns, and the mismatch reds as an unsafe assignment.
// `ReturnType<typeof createClient>` is not the fix either — `createClient` is generic, so
// ReturnType erases its parameters instead of applying their defaults. A NON-generic
// wrapper has exactly one return type, and that is the one every holder wants.
const NO_SESSION = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
} as const

function makeSupabase(url: string, key: string) {
  return createClient(url, key, NO_SESSION)
}
type PlainSupabase = ReturnType<typeof makeSupabase>

/** Fail loudly at setup rather than emit a misleading assertion later. */
function requireEnv(...names: readonly string[]): string {
  for (const name of names) {
    // `process.env[name]` is typed `any` under the RN/jest lib set, and an `any` SENDER
    // reds no-unsafe-assignment regardless of what the receiver is annotated as — only
    // an assertion (or an `unknown` receiver plus narrowing) closes it.
    const value = process.env[name] as string | undefined
    if (value !== undefined && value !== '') return value
  }
  throw new Error(`live-api-proof requires one of [${names.join(', ')}] to be set`)
}

/**
 * Flatten whatever a tRPC transport rejection carries into one greppable string.
 * A thrown `TRPCClientError` for a rejected auth request carries the stable
 * machine code on `.data.appCode` (the router's errorFormatter sets it), the
 * tRPC code on `.data.code`, an HTTP status on `.data.httpStatus`, and the
 * middleware's message on `.message`. We assert against the union so the check
 * does not hinge on any one of them being spelled a particular way.
 */
function transportErrorText(cause: unknown): string {
  const err = cause as {
    readonly message?: unknown
    readonly data?: unknown
    readonly shape?: { readonly data?: unknown }
  }
  const data = (err.data ?? err.shape?.data ?? {}) as Record<string, unknown>
  const parts: unknown[] = [err.message, data['appCode'], data['code'], data['httpStatus']]
  return parts
    .filter((p) => p !== undefined && p !== null)
    .map(String)
    .join(' | ')
}

suite('live-api-proof (LIVE_PROOF=1): the real mobile -> web tRPC auth seam', () => {
  const API_URL = LIVE
    ? requireEnv('SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL')
    : ''
  const ANON_KEY = LIVE
    ? requireEnv(
        'SUPABASE_ANON_KEY',
        'EXPO_PUBLIC_SUPABASE_PUBLISHABLE',
        'NEXT_PUBLIC_SUPABASE_PUBLISHABLE',
      )
    : ''
  const SERVICE_ROLE_KEY = LIVE ? requireEnv('SUPABASE_SERVICE_ROLE_KEY') : ''

  const runId = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
  const email = `live-proof-${runId}@proof.test`
  const password = `Pf!${runId}Zz9`

  // A no-session client, used both to construct the admin client below and as the
  // NEGATIVE CONTROL: created but never signed in, so `getSession()` returns null
  // and the client attaches no bearer at all.
  let admin: PlainSupabase
  let authedSb: PlainSupabase
  let anonSb: PlainSupabase
  let authedApi: ApiClient
  let anonApi: ApiClient
  let userId = ''

  const realFetch = globalThis.fetch

  beforeAll(async () => {
    // Swap the RN networking stub for a real fetch BEFORE any client is built, so
    // supabase-js AND the real createApiClient (its httpBatchLink reads the global
    // fetch) both reach the live stack.
    globalThis.fetch = nodeFetch as typeof globalThis.fetch

    // (a) Fresh, pre-confirmed user via the service-role admin API.
    admin = makeSupabase(API_URL, SERVICE_ROLE_KEY)
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (created.error !== null) throw new Error(`admin.createUser failed: ${created.error.message}`)
    userId = created.data.user.id

    // (b) Sign that user in with a PLAIN supabase-js client to mint a real GoTrue
    // session, then hand THIS client to the mobile factory — so the token flows
    // through client.ts's `headers()` callback (client.ts:~102), never hand-rolled.
    authedSb = makeSupabase(API_URL, ANON_KEY)
    const signedIn = await authedSb.auth.signInWithPassword({ email, password })
    if (signedIn.error !== null)
      throw new Error(`signInWithPassword failed: ${signedIn.error.message}`)

    // (e) Negative control: a session-less client -> no bearer on the wire.
    anonSb = makeSupabase(API_URL, ANON_KEY)

    // (c) Both clients point at the web origin via EXPO_PUBLIC_WEB_ORIGIN (read
    // inside client.ts), defaulting to http://127.0.0.1:3000.
    authedApi = createApiClient(authedSb)
    anonApi = createApiClient(anonSb)
  })

  afterAll(async () => {
    // Best-effort cleanup; a leaked test user is harmless but untidy.
    if (userId !== '') await admin.auth.admin.deleteUser(userId).catch(() => undefined)
    globalThis.fetch = realFetch
  })

  // THE core seam assertion. `system.me` is an authed procedure that returns an
  // ok envelope carrying the VERIFIED caller. It is ok ONLY because the bearer
  // reached the host, was verified against GoTrue, and became `auth.uid()`. Strip
  // the bearer (C01) and this call throws UNAUTHORIZED before any handler runs.
  it('carries the bearer through the real client and system.me returns the verified identity', async () => {
    const me = await authedApi.system.me.query()
    expect(me.ok).toBe(true)
    if (me.ok) {
      expect(me.data.id).toBe(userId)
      expect(me.data.email).toBe(email)
    }
  })

  // Two things at once: that the bearer becomes `auth.uid()` under RLS, and that
  // the authed tRPC read reaches the data channel over the live transport.
  //
  // (i) DB-level RLS binding. A row inserted as the signed-in user is stamped with
  // owner_id = their auth.uid() and is visible to that same user. service_role is
  // REVOKED on public.notes, so this INSERT can ONLY be the RLS-scoped
  // authenticated client (WITH CHECK owner_id = auth.uid()). This is the identity
  // binding the whole seam rests on.
  //
  // (ii) tRPC read-path seam. WITH the bearer, notes.list authenticates, RESOLVES
  // to an OK ActionOutcome ON THE DATA CHANNEL, and the page carries the very row
  // just inserted (the `archived_at` column the list DAL selects is now part of the
  // seeded schema, so the projection succeeds); strip the bearer (C01) and the same
  // call THROWS UNAUTHORIZED before any handler runs. An ok envelope is precisely
  // NOT a transport reject: that gap is what the bearer buys.
  it('the bearer binds RLS (owner sees its own row) and an authed notes.list returns it on the data channel', async () => {
    const title = `live-proof note ${runId}`
    const inserted = await authedSb.from('notes').insert({ title }).select('id, owner_id').single()
    expect(inserted.error).toBeNull()
    const row = inserted.data
    expect(row?.owner_id).toBe(userId)

    const visible = await authedSb
      .from('notes')
      .select('id, owner_id')
      .eq('id', row?.id ?? '')
    expect(visible.error).toBeNull()
    expect((visible.data ?? []).length).toBe(1)

    const page = await authedApi.notes.list.query({})
    expect(page.ok).toBe(true)
    if (page.ok) {
      expect(page.data.items.some((note) => note.id === row?.id)).toBe(true)
    }
  })

  // notes.create is a memberProcedure. Every verified caller owns a PERSONAL
  // workspace (sessionForVerifiedUser keys it by user id — the single-tenant seat
  // the seed ships in place of a workspaces table), so the member gate PASSES and
  // the write lands. WITH the bearer the request authenticates, the gate resolves a
  // seat, and the DAL returns an ok NoteView carrying the created note; strip the
  // bearer (C01) and this exact call THROWS UNAUTHORIZED before any handler runs.
  it('notes.create with a valid bearer passes the member gate and creates the note on the data channel', async () => {
    const title = `live-proof create ${runId}`
    const outcome = await authedApi.notes.create.mutate({ title })
    // It RESOLVED (did not throw) — that is the seam. Under C01 this same call
    // throws UNAUTHORIZED and never produces a value.
    expect(outcome.ok).toBe(true)
    // The write actually landed: an ok envelope carrying the created note, a fresh
    // note is un-archived (archived_at NULL round-trips to isArchived=false), and
    // the returned title is the one sent — distinct from BOTH the transport
    // `unauthorized` of the negative control and the old seatless `forbidden`.
    if (outcome.ok) {
      expect(outcome.data.title).toBe(title)
      expect(outcome.data.isArchived).toBe(false)
      expect(outcome.data.id).not.toBe('')
    }
  })

  // NEGATIVE CONTROL. A session-less client attaches no bearer, so the host sees
  // an anonymous request and the authed procedure throws UNAUTHORIZED. This is the
  // permanent, always-on mirror of what C01 forces onto the authed client.
  it('a session-less client attaches no bearer and its create is rejected as unauthenticated', async () => {
    const cause = await anonApi.notes.create.mutate({ title: 'unauth' }).then(
      () => null,
      (error: unknown) => error,
    )
    expect(cause).not.toBeNull()
    expect(transportErrorText(cause)).toMatch(/unauthor/i)
  })
})
