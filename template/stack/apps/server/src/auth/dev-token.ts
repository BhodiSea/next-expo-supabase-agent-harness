// POST /auth/dev-token — mobile-dev convenience: a simulator/device build in
// stub mode fetches a signed dev JWT over HTTP instead of a developer copying
// the CLI minter's output into the app by hand.
//
// Registered by createApp ONLY when the resolved auth mode is stub, so under
// AUTH_MODE=entra the path does not exist (404 envelope via notFound). It sits
// OUTSIDE /api/* on purpose: no auth (it MINTS credentials), no skew guard.
// Production exposure is impossible by construction — assertAuthBootSafety
// (src/auth/verify.ts, called from src/index.ts before the port binds) makes
// NODE_ENV=production with a stub verifier a boot fatal, and this route only
// exists in stub mode.
import type { OpenAPIHono } from '@hono/zod-openapi'
import { z } from 'zod'
import { apiError } from '../errors.js'
import type { AppEnv } from '../types.js'
import { createDevSigner, type DevSigner } from './dev-auth.js'

// z.guid(), not z.uuid(): the same identity shape the verifier accepts —
// postgres takes any 8-4-4-4-12 hex uuid (see UuidDto in verify.ts).
const DevTokenRequest = z.object({ sub: z.guid().optional() })

/**
 * Register the route. The signer (and therefore the .dev-auth JWKS write) is
 * created LAZILY on the first mint, not at app construction — building the app
 * (tests, OpenAPI emission) must not touch the filesystem. `jwksPath` is the
 * same path the stub verifier reads (resolveDevJwksPath), so a minted token
 * verifies end-to-end against the file this route just wrote.
 */
export function registerDevTokenRoute(app: OpenAPIHono<AppEnv>, jwksPath: string): void {
  let signer: DevSigner | undefined

  // Plain app.post, not app.openapi: dev tooling is not part of the committed
  // OpenAPI contract (same reasoning as the SSE demo route).
  app.post('/auth/dev-token', async (c) => {
    // Body is optional ({} ≡ absent): default is a fresh uuid per token.
    const raw = await c.req.text()
    let body: unknown = {}
    if (raw !== '') {
      try {
        body = JSON.parse(raw)
      } catch {
        return apiError(c, 400, 'bad_request', 'request body must be JSON')
      }
    }
    const parsed = DevTokenRequest.safeParse(body)
    if (!parsed.success) {
      return apiError(c, 400, 'bad_request', 'sub must be a uuid when provided')
    }
    signer ??= createDevSigner(jwksPath)
    const { token, userId } = await signer.mint(parsed.data.sub)
    return c.json({ token, userId }, 201)
  })
}
