import { readFileSync } from 'node:fs'
import {
  ApiError,
  HealthResponse,
  type NewNote,
  NewNoteInput,
  NoteDto,
  NotesListQuery,
  NotesPage,
} from '@app/contracts'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import type { Context, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { registerDevTokenRoute } from './auth/dev-token.js'
import {
  type AuthMode,
  createTokenVerifier,
  resolveAuthMode,
  resolveDevJwksPath,
  type TokenVerifier,
} from './auth/verify.js'
import { accountDal } from './dal/account.js'
import { decodeNotesCursor } from './dal/cursor.js'
import { notesDal } from './dal/notes.js'
import { apiError, notFoundHandler, onErrorHandler, requestId, validationHook } from './errors.js'
import { createSkewMiddleware } from './middleware/skew.js'
import type { AccountDal, AppEnv, NotesDal } from './types.js'

const SSE_DEMO_TICKS = 3

// 1 MiB cap on /api/* request bodies: the largest legal payload (a note with a
// 20 000-char body) is < 100 KiB even at 4-byte UTF-8, so 1 MiB is generous
// headroom while still refusing memory-amplification uploads before they buffer.
// SOURCE: Hono bodyLimit middleware https://hono.dev/docs/middleware/builtin/body-limit
const MAX_API_BODY_BYTES = 1024 * 1024

const PackageJsonDto = z.object({ version: z.string() })

// Resolves both layouts: src/ next to package.json (tsx dev) and dist/src/ (compiled).
function readPackageVersion(): string {
  for (const candidate of ['../package.json', '../../package.json']) {
    let raw: string
    try {
      raw = readFileSync(new URL(candidate, import.meta.url), 'utf8')
    } catch {
      continue
    }
    const parsed: unknown = JSON.parse(raw)
    return PackageJsonDto.parse(parsed).version
  }
  throw new Error('unable to locate the server package.json to read its version')
}

// z.guid() matches the postgres uuid type (any 8-4-4-4-12 hex, no RFC variant check).
const NoteParamsDto = z.object({ id: z.guid() })

// Stryker disable all — OpenAPI route DECLARATIONS, not behaviour. Everything between
// here and the matching `restore` is the route table handed to zod-openapi: descriptions,
// content/schema objects, security arrays. Drift here is caught byte-for-byte by the
// `contracts` gate (tools/check-contract-drift.mjs regenerates openapi.json and diffs it)
// and by the spec-walk in app.errors.test.ts; a mutation test pinning a description string
// would be test-theatre. The handlers, the middleware and every line of real LOGIC stay
// OUTSIDE this region.
const errorResponse = (description: string) => ({
  content: { 'application/json': { schema: ApiError } },
  description,
})

// Failure modes shared by every authenticated /api route: request validation
// (400, via the defaultHook), the auth guard (401), the version-skew guard
// (409), and the onError backstop (500). Every route declares what it can
// actually emit — the envelope meta-test walks the spec to keep this honest.
const guardedRouteErrors = {
  400: errorResponse('Request validation failed (envelope code bad_request)'),
  401: errorResponse('Missing or unverifiable bearer token'),
  409: errorResponse('Client major version does not match the server (code version_skew)'),
  500: errorResponse('Unexpected server error — correlate via error.requestId'),
}

const healthRoute = createRoute({
  method: 'get',
  path: '/healthz',
  responses: {
    200: {
      description:
        'Liveness probe — no auth, no version gate; the mobile connection indicator polls it',
      content: { 'application/json': { schema: HealthResponse } },
    },
    500: errorResponse('Unexpected server error — correlate via error.requestId'),
  },
})

const listNotesRoute = createRoute({
  method: 'get',
  path: '/api/notes',
  security: [{ Bearer: [] }],
  request: { query: NotesListQuery },
  responses: {
    200: {
      description:
        'One keyset page of the notes owned by the authenticated user (scoped by RLS), ' +
        'newest first; follow nextCursor until it is null',
      content: { 'application/json': { schema: NotesPage } },
    },
    ...guardedRouteErrors,
  },
})

const createNoteRoute = createRoute({
  method: 'post',
  path: '/api/notes',
  security: [{ Bearer: [] }],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: NewNoteInput } },
    },
  },
  responses: {
    201: {
      description: 'The created note',
      content: { 'application/json': { schema: NoteDto } },
    },
    ...guardedRouteErrors,
    413: errorResponse('Request body exceeds the 1 MiB /api/* limit'),
  },
})

const getNoteRoute = createRoute({
  method: 'get',
  path: '/api/notes/{id}',
  security: [{ Bearer: [] }],
  request: { params: NoteParamsDto },
  responses: {
    200: {
      description: 'The requested note',
      content: { 'application/json': { schema: NoteDto } },
    },
    ...guardedRouteErrors,
    404: errorResponse('No such note visible to this user'),
  },
})

const deleteNoteRoute = createRoute({
  method: 'delete',
  path: '/api/notes/{id}',
  security: [{ Bearer: [] }],
  request: { params: NoteParamsDto },
  responses: {
    204: { description: 'Note deleted' },
    ...guardedRouteErrors,
    404: errorResponse('No such note visible to this user'),
  },
})

// In-app account deletion. With no users table, the authenticated user's data
// IS their account on this server; the client drops its local session after.
// SOURCE: Apple App Review Guideline 5.1.1(v) — apps that support account
// creation must let users initiate account deletion within the app
// https://developer.apple.com/app-store/review/guidelines/#5.1.1
const deleteAccountRoute = createRoute({
  method: 'delete',
  path: '/api/me',
  security: [{ Bearer: [] }],
  responses: {
    204: {
      description:
        'Account deletion: every row owned by the authenticated user is deleted under ' +
        'FORCE RLS (Apple 5.1.1(v) in-app account deletion; the client clears its local ' +
        'session afterwards)',
    },
    ...guardedRouteErrors,
  },
})
// Stryker restore all

// The mobile app is NOT a CORS client. A native fetch runs outside any browser: it sends
// no Origin header, nothing preflights it, and no same-origin policy withholds the
// response — CORS neither protects nor gates the installed app. This allowlist exists for
// the BROWSER surfaces around development: the Expo web preview and browser-based dev
// tools, which DO preflight (they send `authorization` and `x-client-version`, neither of
// which is CORS-safelisted) and refuse responses their origin is not named on.
//
// Still an ALLOWLIST, never `*`: this API answers with the caller's own rows under FORCE
// RLS, and a wildcard would let any page a user visits read them with a stolen token.
// Overridable per deployment (CORS_ORIGINS, comma-separated) for whatever origin a
// deployment's own tooling is actually served from.
// SOURCE: hono cors middleware https://hono.dev/docs/middleware/builtin/cors
const DEFAULT_DEV_ORIGINS = [
  'http://localhost:8081', // Expo dev server (web preview + dev tools)
  'http://localhost:19006', // legacy expo web dev port
] as const

function resolveCorsOrigins(env: Readonly<Record<string, string | undefined>>): string[] {
  const configured = env['CORS_ORIGINS']
    ?.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '')
  return configured !== undefined && configured.length > 0 ? configured : [...DEFAULT_DEV_ORIGINS]
}

export interface AppOptions {
  /** Server version; defaults to the package.json version. */
  readonly version?: string
  /** Token verifier; defaults to the AUTH_MODE-configured verifier (env). */
  readonly verifyToken?: TokenVerifier
  /** Notes DAL; tests inject fakes here. */
  readonly notesDal?: NotesDal
  /** Account DAL (in-app account deletion); tests inject fakes here. */
  readonly accountDal?: AccountDal
  /** Milliseconds between SSE demo ticks. */
  readonly sseTickMs?: number
  /** Test hook: invoked when an SSE client aborts mid-stream. */
  readonly onSseAbort?: () => void
  /** Origins allowed to read API responses; defaults to the Expo dev-tooling origins. */
  readonly corsOrigins?: readonly string[]
  /**
   * Auth mode governing the dev-token route; defaults to the AUTH_MODE env
   * resolution (tests exercise both modes through this seam).
   */
  readonly authMode?: AuthMode
  /** Where the dev-token route materializes the stub JWKS; defaults to DEV_JWKS_PATH. */
  readonly devJwksPath?: string
}

export function createApp(options: AppOptions = {}): OpenAPIHono<AppEnv> {
  const version = options.version ?? readPackageVersion()
  const verifyToken = options.verifyToken ?? createTokenVerifier(process.env)
  const dal = options.notesDal ?? notesDal
  const account = options.accountDal ?? accountDal
  const sseTickMs = options.sseTickMs ?? 250
  const onSseAbort = options.onSseAbort
  const corsOrigins = options.corsOrigins ?? resolveCorsOrigins(process.env)
  const authMode = options.authMode ?? resolveAuthMode(process.env)

  // defaultHook: EVERY route's validation failure becomes the ApiError envelope.
  const app = new OpenAPIHono<AppEnv>({ defaultHook: validationHook })

  // Error envelope wiring — no error path may bypass src/errors.ts.
  app.use(requestId)
  app.notFound(notFoundHandler)
  app.onError(onErrorHandler)

  // CORS runs FIRST — before the skew and auth guards. A preflight (OPTIONS) carries no
  // Authorization header by definition, so an auth guard placed ahead of it answers 401
  // and the browser never sends the real request: every browser-based dev surface would
  // be locked out of the API with a green server. Hono's cors() short-circuits the
  // preflight itself; native-app requests carry no Origin and pass through untouched.
  // SOURCE: hono cors middleware https://hono.dev/docs/middleware/builtin/cors
  app.use(
    '*',
    cors({
      origin: [...corsOrigins],
      // EVERY method the route table declares. DELETE was missing while `deleteNoteRoute`
      // was live: Hono's cors() does not validate the REQUESTED method, it just advertises
      // this list — so the preflight answered 204 without DELETE, the browser refused to
      // send the real request, and deleting a note was impossible from any browser-based
      // client. The server stayed green throughout, because curl never preflights.
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      // Exactly what the client sends: the bearer token and the skew middleware's
      // version header. Neither is CORS-safelisted, so both must be named here.
      allowHeaders: ['authorization', 'content-type', 'x-client-version'],
      // Let the client read the correlation id off a failed response, so a user-visible
      // error can be quoted straight into a support ticket.
      exposeHeaders: ['x-request-id'],
      maxAge: 600,
    }),
  )

  // Stryker disable all — DECLARATION: the securityScheme component the route table's
  // `security: [{ Bearer: [] }]` refers to. It emits spec, not behaviour (the real guard is
  // requireAuth below, which IS mutation-tested); the `contracts` gate diffs it byte-for-byte.
  app.openAPIRegistry.registerComponent('securitySchemes', 'Bearer', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  })
  // Stryker restore all

  app.openapi(healthRoute, (c) => c.json({ ok: true as const, version }, 200))

  // Dev-token mint for stub mode ONLY — under AUTH_MODE=entra the route is not
  // registered and the path 404s. It sits outside /api/* (it mints the very
  // credential the guards demand); production exposure is impossible because
  // assertAuthBootSafety (src/index.ts) makes NODE_ENV=production + stub a
  // boot fatal. See src/auth/dev-token.ts.
  if (authMode === 'stub') {
    registerDevTokenRoute(app, options.devJwksPath ?? resolveDevJwksPath(process.env))
  }

  const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
    const authorization = c.req.header('authorization')
    const token =
      authorization?.startsWith('Bearer ') === true
        ? authorization.slice('Bearer '.length)
        : undefined
    if (token === undefined || token === '') {
      return apiError(c, 401, 'unauthorized', 'missing bearer token')
    }
    try {
      const { userId } = await verifyToken(token)
      c.set('userId', userId)
    } catch {
      // Verification failures collapse to a bare 401: token errors must not leak
      // why a credential was rejected.
      return apiError(c, 401, 'unauthorized', 'invalid bearer token')
    }
    await next()
    return undefined
  }

  // Every /api/* route sits behind ALL THREE guards; /healthz and /openapi.json
  // are deliberately outside. The skew unit test walks app.routes to prove
  // coverage. Order matters: reject skewed/unauthenticated requests before the
  // body limit ever buffers a byte for them.
  app.use('/api/*', createSkewMiddleware(version))
  app.use('/api/*', requireAuth)
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: MAX_API_BODY_BYTES,
      // Explicitly typed: bodyLimit's own onError context is untyped (any env).
      onError: (c: Context<AppEnv>) =>
        apiError(c, 413, 'payload_too_large', 'request body exceeds 1 MiB'),
    }),
  )

  app.openapi(listNotesRoute, async (c) => {
    const query = c.req.valid('query')
    const cursor = query.cursor === undefined ? undefined : decodeNotesCursor(query.cursor)
    if (cursor === null) {
      // Well-formed base64url that this server never minted — reject at the
      // edge, before the DAL sees it.
      return apiError(c, 400, 'bad_request', 'cursor is not a page token this server issued')
    }
    const page = await dal.list(c.get('userId'), { cursor, limit: query.limit })
    return c.json(page, 200)
  })

  app.openapi(createNoteRoute, async (c) => {
    const input: NewNote = c.req.valid('json')
    const note = await dal.create(c.get('userId'), input)
    return c.json(note, 201)
  })

  app.openapi(getNoteRoute, async (c) => {
    const { id } = c.req.valid('param')
    const note = await dal.get(c.get('userId'), id)
    return note === null ? apiError(c, 404, 'not_found', 'no such note') : c.json(note, 200)
  })

  app.openapi(deleteNoteRoute, async (c) => {
    const { id } = c.req.valid('param')
    const removed = await dal.remove(c.get('userId'), id)
    return removed ? c.body(null, 204) : apiError(c, 404, 'not_found', 'no such note')
  })

  app.openapi(deleteAccountRoute, async (c) => {
    // Idempotent by construction: deleting zero rows is still a completed
    // deletion — 204 either way, so a retry after a dropped response succeeds.
    await account.deleteAllOwnedData(c.get('userId'))
    return c.body(null, 204)
  })

  // SSE demo: streams three ticks then closes. Not part of the OpenAPI surface
  // (event streams do not fit request/response schemas), hence plain app.get.
  app.get('/api/events/demo', (c) =>
    streamSSE(c, async (stream) => {
      stream.onAbort(() => {
        // SOURCE: SSE doctrine — client aborts MUST stop the producer; an orphaned
        // generator per dropped client is a slow server leak [corpus: harness/doctrine]
        onSseAbort?.()
      })
      for (let tick = 1; tick <= SSE_DEMO_TICKS && !stream.aborted; tick += 1) {
        await stream.writeSSE({ event: 'tick', data: String(tick), id: String(tick) })
        await stream.sleep(sseTickMs)
      }
    }),
  )

  // Stryker disable all — DECLARATION: the OpenAPI document header (title/description/
  // openapi version). Same control as the route table above — the `contracts` gate
  // regen-diffs openapi.json, and app.errors.test.ts walks the served document; pinning
  // `info.title` with a mutation test would be test-theatre.
  app.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'server',
      version,
      description:
        'Notes API — the demo vertical slice. Regenerate openapi.json via `pnpm --filter server openapi:emit`.',
    },
  })
  // Stryker restore all

  return app
}
