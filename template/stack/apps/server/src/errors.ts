// The ONE place error responses are built. app.ts wires these into
// app.onError / app.notFound / the OpenAPIHono defaultHook so every non-2xx
// JSON body — validation, auth, 404, skew, body-limit, uncaught — is the same
// @app/contracts ApiError envelope. Handlers never hand-roll error JSON.
// SOURCE: envelope shape per Microsoft REST API Guidelines [corpus: microsoft/api-guidelines]
// https://github.com/microsoft/api-guidelines/blob/vNext/azure/Guidelines.md
import type { ApiErrorBody, ApiErrorCode } from '@app/contracts'
import type { Hook } from '@hono/zod-openapi'
import type { Context, MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ZodError } from 'zod'
import type { AppEnv } from './types.js'

/** Statuses this server deliberately emits; each maps to one stable envelope code. */
type ErrorStatus = 400 | 401 | 404 | 409 | 413 | 500

// Matches the ApiError contract bound — reflected input (paths, zod messages)
// is truncated, never streamed back unbounded.
const MESSAGE_MAX = 1024

/**
 * Request-correlation middleware: mints a fresh id per request (server-side
 * only — an id echoed from the wire could forge log correlation), exposes it
 * to handlers via c.var and to clients via the x-request-id response header.
 */
export const requestId: MiddlewareHandler<AppEnv> = async (c, next) => {
  const id = crypto.randomUUID()
  c.set('requestId', id)
  c.header('x-request-id', id)
  await next()
}

function errorBody(c: Context<AppEnv>, code: ApiErrorCode, message: string): ApiErrorBody {
  return { error: { code, message: message.slice(0, MESSAGE_MAX), requestId: c.get('requestId') } }
}

/**
 * Build the enveloped error response every error path funnels through. Generic
 * over the status so zod-openapi route handlers keep their typed-response
 * checking (the return matches the route's declared ApiError responses).
 */
export function apiError<S extends ErrorStatus>(
  c: Context<AppEnv>,
  status: S,
  code: ApiErrorCode,
  message: string,
) {
  return c.json(errorBody(c, code, message), status)
}

/** app.notFound: unknown routes get the envelope too, not Hono's plain-text 404. */
export function notFoundHandler(c: Context<AppEnv>): Response {
  return apiError(c, 404, 'not_found', `no route for ${c.req.method} ${c.req.path}`)
}

// Statuses that reach onError via HTTPException (e.g. Hono's own validator
// throws 400 on malformed JSON). Anything outside this map is a programming
// surprise in THIS app and is collapsed to 500/internal rather than inventing
// an undeclared code — the enum in @app/schema is the closed contract.
const HTTP_EXCEPTION_CODES: Partial<Record<number, { code: ApiErrorCode; status: ErrorStatus }>> = {
  400: { code: 'bad_request', status: 400 },
  401: { code: 'unauthorized', status: 401 },
  404: { code: 'not_found', status: 404 },
  // 409 is in ErrorStatus and the closed ApiErrorCode enum, and skew.ts RETURNS it
  // rather than throwing — so this entry was missing and a `throw new HTTPException(409)`
  // collapsed to 500/internal. The map must cover every status the enum declares.
  409: { code: 'version_skew', status: 409 },
  413: { code: 'payload_too_large', status: 413 },
}

/**
 * app.onError: HTTPExceptions carry deliberate, client-safe messages and keep
 * their status; everything else is an internal fault — log it with the request
 * id and return a static message (internals must never leak to the wire).
 */
export function onErrorHandler(err: Error, c: Context<AppEnv>): Response {
  if (err instanceof HTTPException) {
    const mapped = HTTP_EXCEPTION_CODES[err.status]
    if (mapped !== undefined) {
      return apiError(c, mapped.status, mapped.code, err.message === '' ? mapped.code : err.message)
    }
  }
  console.error(`[request ${c.get('requestId')}] unhandled error:`, err)
  return apiError(c, 500, 'internal', 'unexpected server error')
}

function summarizeZodError(error: ZodError): string {
  const shown = error.issues.slice(0, 3)
  const parts = shown.map((issue) => {
    const path = issue.path.map(String).join('.')
    return path === '' ? issue.message : `${path}: ${issue.message}`
  })
  const more = error.issues.length > shown.length ? ' (and more)' : ''
  return `validation failed — ${parts.join('; ')}${more}`
}

/**
 * OpenAPIHono defaultHook: every zod-openapi validation failure on every route
 * becomes a 400 envelope. Without this, each route would fall back to
 * zod-openapi's raw `{ success: false, error }` body and the contract would
 * fork per route.
 */
export const validationHook: Hook<unknown, AppEnv, string, Response | undefined> = (result, c) =>
  result.success ? undefined : apiError(c, 400, 'bad_request', summarizeZodError(result.error))
