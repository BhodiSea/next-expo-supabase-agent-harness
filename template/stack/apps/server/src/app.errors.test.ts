// Error-envelope meta-test. Two layers:
//   1. Spec walk — every operation in the live OpenAPI document must declare
//      its failure modes (500 everywhere; 401/409 wherever auth applies; 400
//      wherever input is validated) and every declared non-2xx response must
//      be the ApiError envelope. New routes cannot dodge the contract.
//   2. Behavior — drive each error path (validation, bad cursor, malformed
//      JSON, missing auth, unknown route, thrown error, oversized body) and
//      assert the live body parses as the envelope with the right code.
import { ApiError } from '@app/contracts'
import { describe, expect, it } from 'vitest'
import { type AppOptions, createApp } from './app.js'
import type { NotesDal } from './types.js'

const USER_ID = '11111111-1111-4111-8111-111111111111'

const emptyDal: NotesDal = {
  list: () => Promise.resolve({ items: [], nextCursor: null }),
  create: () => Promise.reject(new Error('not under test')),
  get: () => Promise.resolve(null),
  remove: () => Promise.resolve(false),
}

const options: AppOptions = {
  version: '1.2.3',
  verifyToken: () => Promise.resolve({ userId: USER_ID }),
  notesDal: emptyDal,
}

const authed = { authorization: 'Bearer test-token' }

interface SpecOperation {
  security?: unknown[]
  parameters?: unknown[]
  requestBody?: unknown
  responses: Record<string, { content?: Record<string, { schema?: SpecSchema }> }>
}
interface SpecSchema {
  properties?: Record<string, SpecSchema>
  required?: string[]
}
interface SpecDocument {
  paths: Record<string, Record<string, SpecOperation>>
}

async function loadSpec(): Promise<SpecDocument> {
  const res = await createApp(options).request('/openapi.json')
  expect(res.status).toBe(200)
  return (await res.json()) as SpecDocument
}

async function expectEnvelope(res: Response, status: number, code: string): Promise<void> {
  expect(res.status).toBe(status)
  const body = ApiError.parse(await res.json())
  expect(body.error.code).toBe(code)
  // Correlation id: present, uuid-shaped (schema-checked), echoed as a header.
  expect(body.error.requestId).toBeDefined()
  expect(res.headers.get('x-request-id')).toBe(body.error.requestId)
}

describe('OpenAPI spec declares every failure mode (walks the real document)', () => {
  it('every operation declares 500, plus 401/409 when guarded and 400 when validating', async () => {
    const doc = await loadSpec()
    const operations = Object.entries(doc.paths).flatMap(([path, methods]) =>
      Object.entries(methods).map(([method, op]) => ({ id: `${method} ${path}`, op })),
    )
    // Non-vacuous: health + notes CRUD must all be present.
    expect(operations.length).toBeGreaterThanOrEqual(5)

    for (const { id, op } of operations) {
      const declared = Object.keys(op.responses)
      expect(declared, `${id} must declare the onError backstop`).toContain('500')
      if (op.security !== undefined) {
        expect(declared, `${id} sits behind auth — declare 401`).toContain('401')
        expect(declared, `${id} sits behind the skew gate — declare 409`).toContain('409')
      }
      if ((op.parameters?.length ?? 0) > 0 || op.requestBody !== undefined) {
        expect(declared, `${id} validates input — declare 400`).toContain('400')
      }
    }
  })

  it('every declared non-2xx response is the ApiError envelope', async () => {
    const doc = await loadSpec()
    let checked = 0
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        for (const [status, response] of Object.entries(op.responses)) {
          if (status.startsWith('2')) continue
          checked += 1
          const schema = response.content?.['application/json']?.schema
          const id = `${method} ${path} ${status}`
          expect(schema, `${id} must carry a JSON body schema`).toBeDefined()
          expect(schema?.required, `${id} must wrap errors in { error }`).toContain('error')
          const error = schema?.properties?.['error']
          expect(error?.required, `${id} envelope requires a code`).toContain('code')
          expect(error?.required, `${id} envelope requires a message`).toContain('message')
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(10) // the walk really walked
  })
})

describe('every runtime error path emits the envelope', () => {
  it('validation failure (defaultHook): empty title → 400 bad_request', async () => {
    const res = await createApp(options).request('/api/notes', {
      method: 'POST',
      headers: { ...authed, 'content-type': 'application/json' },
      body: JSON.stringify({ title: '' }),
    })
    await expectEnvelope(res, 400, 'bad_request')
  })

  it('query validation (defaultHook): limit above the contract max → 400', async () => {
    const res = await createApp(options).request('/api/notes?limit=1000', { headers: authed })
    await expectEnvelope(res, 400, 'bad_request')
  })

  it('well-formed base64url that decodes to garbage → 400 bad_request', async () => {
    // base64url("hello") — passes the wire regex, is not a cursor we minted.
    const res = await createApp(options).request('/api/notes?cursor=aGVsbG8', { headers: authed })
    await expectEnvelope(res, 400, 'bad_request')
  })

  it('malformed JSON body (HTTPException from the validator) → 400 bad_request', async () => {
    const res = await createApp(options).request('/api/notes', {
      method: 'POST',
      headers: { ...authed, 'content-type': 'application/json' },
      body: '{ not json',
    })
    await expectEnvelope(res, 400, 'bad_request')
  })

  it('missing bearer token → 401 unauthorized', async () => {
    const res = await createApp(options).request('/api/notes')
    await expectEnvelope(res, 401, 'unauthorized')
  })

  it('unknown route → 404 not_found (app.notFound, not a plain-text 404)', async () => {
    const res = await createApp(options).request('/no/such/route')
    await expectEnvelope(res, 404, 'not_found')
  })

  it('RLS-invisible note → 404 not_found', async () => {
    const res = await createApp(options).request(
      '/api/notes/3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      { headers: authed },
    )
    await expectEnvelope(res, 404, 'not_found')
  })

  it('oversized body → 413 payload_too_large before the handler runs', async () => {
    const res = await createApp(options).request('/api/notes', {
      method: 'POST',
      headers: { ...authed, 'content-type': 'application/json' },
      body: `{"title":"big","body":"${'x'.repeat(1024 * 1024)}"}`,
    })
    await expectEnvelope(res, 413, 'payload_too_large')
  })

  it('thrown DAL error → 500 internal with a STATIC message (no internals leak)', async () => {
    const app = createApp({
      ...options,
      notesDal: {
        ...emptyDal,
        list: () => Promise.reject(new Error('connection string postgres://leak-canary')),
      },
    })
    const res = await app.request('/api/notes', { headers: authed })
    expect(res.status).toBe(500)
    const raw = await res.text()
    expect(raw).not.toContain('leak-canary') // the throw site's message must never reach the wire
    const body = ApiError.parse(JSON.parse(raw))
    expect(body.error.code).toBe('internal')
    expect(body.error.message).toBe('unexpected server error')
    expect(res.headers.get('x-request-id')).toBe(body.error.requestId)
  })
})
