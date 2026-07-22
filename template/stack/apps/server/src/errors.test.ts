// Unit test for THE error-envelope module — the one place every non-2xx body is
// built. app.errors.test.ts walks the live OpenAPI surface; this file drives the
// exported helpers directly, through a miniature app wired exactly like app.ts
// (requestId → notFound → onError), so each decision inside src/errors.ts is
// pinned on its own: the truncation bound, the HTTPException status map, the
// unmapped-status collapse, the log line, and the zod summary's exact shape.
// Every helper is called INSIDE an `it` — nothing is exercised from a hook.
import { ApiError, type ApiErrorBody } from '@app/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type ZodType, z } from 'zod'
import { apiError, notFoundHandler, onErrorHandler, requestId, validationHook } from './errors.js'
import type { AppEnv } from './types.js'

// The ApiError contract bound (message: z.string().min(1).max(1024)). Restated
// here so a silent widening of either side is a red test, not a quiet drift.
const MESSAGE_MAX = 1024

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The production wiring in miniature: no error path may bypass src/errors.ts. */
function createErrorApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.use(requestId)
  app.notFound(notFoundHandler)
  app.onError(onErrorHandler)
  return app
}

/** A route whose only job is to hand `err` to onErrorHandler. */
function appThrowing(err: Error): Hono<AppEnv> {
  const app = createErrorApp()
  app.get('/boom', () => {
    throw err
  })
  return app
}

interface LoggedError {
  readonly text: string
  readonly errorMessage: string
}

/** Capture console.error without printing it; restored by the afterEach below. */
function captureConsoleError(): LoggedError[] {
  const calls: LoggedError[] = []
  vi.spyOn(console, 'error').mockImplementation((text: unknown, err: unknown) => {
    calls.push({
      text: typeof text === 'string' ? text : '',
      errorMessage: err instanceof Error ? err.message : '',
    })
  })
  return calls
}

async function envelopeOf(res: Response): Promise<ApiErrorBody> {
  return ApiError.parse(await res.json())
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('requestId: the correlation id is minted server-side, never taken from the wire', () => {
  it('mints a fresh uuid per request and exposes it via c.var AND the x-request-id header', async () => {
    const app = createErrorApp()
    app.get('/id', (c) => c.json({ seen: c.get('requestId') }, 200))

    const first = await app.request('/id')
    const second = await app.request('/id')
    const firstSeen = ((await first.json()) as { seen: string }).seen
    const secondSeen = ((await second.json()) as { seen: string }).seen

    expect(firstSeen).toMatch(UUID)
    expect(first.headers.get('x-request-id')).toBe(firstSeen) // handler view === wire view
    expect(second.headers.get('x-request-id')).toBe(secondSeen)
    expect(secondSeen).not.toBe(firstSeen) // fresh per request, never reused
  })

  it('IGNORES a client-supplied x-request-id (an echoed id could forge log correlation)', async () => {
    const app = createErrorApp()
    app.get('/id', (c) => c.json({ seen: c.get('requestId') }, 200))
    const forged = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

    const res = await app.request('/id', { headers: { 'x-request-id': forged } })
    const seen = ((await res.json()) as { seen: string }).seen

    expect(seen).not.toBe(forged)
    expect(seen).toMatch(UUID)
    expect(res.headers.get('x-request-id')).not.toBe(forged)
    expect(res.headers.get('x-request-id')).toBe(seen)
  })
})

describe('apiError: the envelope bounds every message it reflects', () => {
  it(`truncates a message longer than ${String(MESSAGE_MAX)} to EXACTLY ${String(MESSAGE_MAX)} chars`, async () => {
    const app = createErrorApp()
    const overlong = `${'A'.repeat(MESSAGE_MAX)}TAIL-MUST-NEVER-REACH-THE-WIRE`
    app.get('/long', (c) => apiError(c, 400, 'bad_request', overlong))

    const res = await app.request('/long')
    const raw = await res.text()

    expect(res.status).toBe(400)
    expect(raw).not.toContain('TAIL-MUST-NEVER-REACH-THE-WIRE') // unbounded reflection
    const body = ApiError.parse(JSON.parse(raw))
    expect(body.error.message).toHaveLength(MESSAGE_MAX)
    expect(body.error.message).toBe('A'.repeat(MESSAGE_MAX))
  })

  it('leaves a message inside the bound byte-identical, and stamps code + requestId', async () => {
    const app = createErrorApp()
    const exact = 'B'.repeat(MESSAGE_MAX)
    app.get('/exact', (c) => apiError(c, 404, 'not_found', exact))

    const res = await app.request('/exact')
    const body = await envelopeOf(res)

    expect(res.status).toBe(404)
    expect(body.error.code).toBe('not_found')
    expect(body.error.message).toBe(exact)
    expect(body.error.requestId).toBe(res.headers.get('x-request-id'))
  })
})

describe('notFoundHandler: unknown routes get the envelope, naming method and path', () => {
  it('GET an unknown path → 404 not_found with the exact message shape', async () => {
    const res = await createErrorApp().request('/no/such/route')
    const body = await envelopeOf(res)

    expect(res.status).toBe(404)
    expect(body.error.code).toBe('not_found')
    expect(body.error.message).toBe('no route for GET /no/such/route')
    expect(body.error.requestId).toBe(res.headers.get('x-request-id'))
  })

  it('reports the REAL method and path, not a hardcoded pair', async () => {
    const res = await createErrorApp().request('/still/missing', { method: 'POST' })
    const body = await envelopeOf(res)

    expect(res.status).toBe(404)
    expect(body.error.message).toBe('no route for POST /still/missing')
  })
})

describe('onErrorHandler: mapped HTTPException statuses keep their status and code', () => {
  // Every status the closed ApiErrorCode enum declares must appear here. 409 was ABSENT
  // from HTTP_EXCEPTION_CODES — skew.ts *returns* its 409 rather than throwing, so nothing
  // exercised it, and a `throw new HTTPException(409)` silently collapsed to 500/internal.
  const mapped = [
    { status: 400, code: 'bad_request' },
    { status: 401, code: 'unauthorized' },
    { status: 404, code: 'not_found' },
    { status: 409, code: 'version_skew' },
    { status: 413, code: 'payload_too_large' },
  ] as const

  for (const { status, code } of mapped) {
    it(`HTTPException ${String(status)} → ${String(status)}/${code}, keeping its message`, async () => {
      const res = await appThrowing(
        new HTTPException(status, { message: `deliberate ${code}` }),
      ).request('/boom')
      const body = await envelopeOf(res)

      expect(res.status).toBe(status)
      expect(body.error.code).toBe(code)
      expect(body.error.message).toBe(`deliberate ${code}`)
    })

    it(`HTTPException ${String(status)} with an EMPTY message falls back to '${code}'`, async () => {
      const res = await appThrowing(new HTTPException(status)).request('/boom')
      const body = await envelopeOf(res)

      expect(res.status).toBe(status)
      expect(body.error.code).toBe(code)
      expect(body.error.message).toBe(code) // the envelope message is never empty
    })
  }

  it('does not log a deliberate HTTPException as an unhandled error', async () => {
    const logged = captureConsoleError()

    const res = await appThrowing(new HTTPException(401, { message: 'missing bearer' })).request(
      '/boom',
    )

    expect(res.status).toBe(401)
    expect(logged).toHaveLength(0)
  })
})

describe('onErrorHandler: everything else collapses to 500/internal and is logged', () => {
  for (const status of [418, 429] as const) {
    it(`an UNMAPPED HTTPException (${String(status)}) never leaks its status or message`, async () => {
      const logged = captureConsoleError()

      const res = await appThrowing(
        new HTTPException(status, { message: 'slow down, tenant-42' }),
      ).request('/boom')
      const raw = await res.text()

      expect(res.status).toBe(500) // NOT the undeclared status
      expect(raw).not.toContain('tenant-42')
      const body = ApiError.parse(JSON.parse(raw))
      expect(body.error.code).toBe('internal')
      expect(body.error.message).toBe('unexpected server error')
      // An undeclared status IS a programming surprise: it is logged verbatim for
      // the operator — the ORIGINAL exception, not a fault raised while handling it.
      expect(logged).toHaveLength(1)
      expect(logged[0]?.errorMessage).toBe('slow down, tenant-42')
    })
  }

  it('a thrown Error is answered with a STATIC message and logged with the request id', async () => {
    const logged = captureConsoleError()

    const res = await appThrowing(new Error('connection string postgres://leak-canary')).request(
      '/boom',
    )
    const raw = await res.text()

    expect(res.status).toBe(500)
    expect(raw).not.toContain('leak-canary') // internals never reach the wire
    const body = ApiError.parse(JSON.parse(raw))
    expect(body.error.code).toBe('internal')
    expect(body.error.message).toBe('unexpected server error')

    const id = res.headers.get('x-request-id') ?? ''
    expect(id).toMatch(UUID)
    expect(body.error.requestId).toBe(id)
    // ...but they DO reach the log, correlated by the id the client was handed.
    expect(logged).toHaveLength(1)
    expect(logged[0]?.text).toBe(`[request ${id}] unhandled error:`)
    expect(logged[0]?.errorMessage).toContain('leak-canary')
  })

  it('a plain Error that merely LOOKS like an HTTPException (a .status) is still 500', async () => {
    const logged = captureConsoleError()
    class StatusShapedError extends Error {
      readonly status = 404
    }

    const res = await appThrowing(new StatusShapedError('not a real HTTPException')).request(
      '/boom',
    )
    const body = await envelopeOf(res)

    expect(res.status).toBe(500) // only a real HTTPException may pick its status
    expect(body.error.code).toBe('internal')
    expect(body.error.message).toBe('unexpected server error')
    expect(logged).toHaveLength(1)
  })
})

// Custom zod messages: the assertions below pin THIS module's formatting, not
// zod's wording (which changes across zod releases).
const NestedSchema = z.object({
  nested: z.object({ deep: z.string().min(1, 'deep must not be empty') }),
})

const RootSchema = z
  .object({ left: z.string(), right: z.string() })
  .refine((value) => value.left !== value.right, { error: 'left and right must differ' })

const ThreeIssueSchema = z.object({
  alpha: z.string().min(1, 'alpha must not be empty'),
  beta: z.string().min(1, 'beta must not be empty'),
  gamma: z.string().min(1, 'gamma must not be empty'),
})

const FourIssueSchema = ThreeIssueSchema.extend({
  delta: z.string().min(1, 'delta must not be empty'),
})

const LoudSchema = z.object({ field: z.string().min(1, 'x'.repeat(2 * MESSAGE_MAX)) })

/**
 * Drive validationHook the way OpenAPIHono's defaultHook does — with a real
 * failed safeParse result — and hand back the enveloped 400 it produced.
 */
async function hookFailureFor(schema: ZodType, input: unknown): Promise<Response> {
  const app = createErrorApp()
  app.get('/validate', (c) => {
    const parsed = schema.safeParse(input)
    if (parsed.success) {
      throw new Error('fixture must FAIL validation')
    }
    return (
      validationHook({ target: 'json', success: false, error: parsed.error }, c) ?? c.body(null)
    )
  })
  return app.request('/validate')
}

describe('validationHook: every zod failure becomes one bounded, summarized 400', () => {
  it('a successful result returns undefined — the request proceeds untouched', async () => {
    const app = createErrorApp()
    app.get('/ok', (c) => {
      const outcome = validationHook({ target: 'json', success: true, data: { left: 'a' } }, c)
      return c.json({ handled: outcome !== undefined }, 200)
    })

    const res = await app.request('/ok')

    expect(res.status).toBe(200)
    expect((await res.json()) as { handled: boolean }).toStrictEqual({ handled: false })
  })

  it('one rooted issue: path segments joined with "." and prefixed onto the message', async () => {
    const res = await hookFailureFor(NestedSchema, { nested: { deep: '' } })
    const body = await envelopeOf(res)

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('bad_request')
    expect(body.error.message).toBe('validation failed — nested.deep: deep must not be empty')
  })

  it('an EMPTY path (a root refinement) carries the bare message — no ": " prefix', async () => {
    const res = await hookFailureFor(RootSchema, { left: 'same', right: 'same' })
    const body = await envelopeOf(res)

    expect(res.status).toBe(400)
    expect(body.error.message).toBe('validation failed — left and right must differ')
  })

  it('exactly three issues: all three joined with "; ", and NO "(and more)" tail', async () => {
    const res = await hookFailureFor(ThreeIssueSchema, { alpha: '', beta: '', gamma: '' })
    const body = await envelopeOf(res)

    expect(body.error.message).toBe(
      'validation failed — alpha: alpha must not be empty; ' +
        'beta: beta must not be empty; gamma: gamma must not be empty',
    )
    expect(body.error.message).not.toContain('(and more)')
  })

  it('four issues: only the first three are shown, and the tail is flagged "(and more)"', async () => {
    const res = await hookFailureFor(FourIssueSchema, {
      alpha: '',
      beta: '',
      gamma: '',
      delta: '',
    })
    const body = await envelopeOf(res)

    expect(body.error.message).toBe(
      'validation failed — alpha: alpha must not be empty; ' +
        'beta: beta must not be empty; gamma: gamma must not be empty (and more)',
    )
    expect(body.error.message).not.toContain('delta') // the 4th issue is summarized away
  })

  it('a zod message longer than the bound is truncated before it reaches the wire', async () => {
    const res = await hookFailureFor(LoudSchema, { field: '' })
    const body = await envelopeOf(res)

    expect(res.status).toBe(400)
    expect(body.error.message).toHaveLength(MESSAGE_MAX)
    expect(body.error.message.startsWith('validation failed — field: xxx')).toBe(true)
  })
})
