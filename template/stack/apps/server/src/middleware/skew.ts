import type { MiddlewareHandler } from 'hono'
import { apiError } from '../errors.js'
import type { AppEnv } from '../types.js'

// Identity registry so the route-coverage unit test can prove every /api/*
// route sits behind this middleware by walking app.routes.
const guards = new WeakSet<object>()

function majorOf(version: string): number | null {
  const match = /^\s*v?(\d+)(?:\.|$)/.exec(version)
  const major = match?.[1]
  return major === undefined ? null : Number(major)
}

/**
 * Version-skew guard: the mobile client sends `x-client-version` (the
 * app.config.ts version); a major-version mismatch against the server's own
 * package version is rejected before any handler runs. Requests WITHOUT the
 * header pass (curl, health tooling) — the mobile client always sends it.
 */
export function createSkewMiddleware(serverVersion: string): MiddlewareHandler<AppEnv> {
  const serverMajor = majorOf(serverVersion)
  if (serverMajor === null) {
    throw new Error(`cannot parse server version for skew detection: ${serverVersion}`)
  }
  const skewGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
    const clientVersion = c.req.header('x-client-version')
    if (clientVersion !== undefined) {
      // `null !== serverMajor` is already true for an unparseable client version
      // (serverMajor is a parsed finite number by construction, guarded above), so a
      // separate `clientMajor === null` disjunct was dead code no input could reach.
      const clientMajor = majorOf(clientVersion)
      if (clientMajor !== serverMajor) {
        // SOURCE: version-skew doctrine — installed mobile fleets update slowly (store
        // review, staged rollouts, users who never update); a hard 409 with a stable
        // machine-readable code beats silent contract drift [corpus: harness/doctrine]
        return apiError(c, 409, 'version_skew', 'client major version does not match the server')
      }
    }
    await next()
    return undefined
  }
  guards.add(skewGuard)
  return skewGuard
}

/**
 * True when `handler` is a middleware minted by {@link createSkewMiddleware}.
 * @public consumed by the route-coverage unit test (skew.test.ts)
 */
export function isSkewMiddleware(handler: unknown): boolean {
  return typeof handler === 'function' && guards.has(handler)
}
