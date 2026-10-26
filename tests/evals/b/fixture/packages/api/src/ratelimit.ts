import { TransportErrorCode } from '@app/contracts'

// The rate-limit seam, router side.
//
// THIS PACKAGE TAKES NO DEPENDENCY ON A LIMITER. The port below is a function the HOST
// injects, exactly like `createClient` and `session`: packages/api must stay
// framework-agnostic and infrastructure-agnostic, and "which Redis, which budget, which
// identity counts as the caller" are all deployment facts. The router's entire job is to
// ask, and to turn a "no" into the one transport failure a client can act on.
//
// WHY THIS IS A THROW AND NOT AN ENVELOPE. The doctrine in trpc.ts is that domain
// failures ride the data channel. A rate limit is not a domain failure: it is a refusal
// to run the handler at all, decided before the handler exists, and tRPC middleware has
// exactly two exits — call next(), or throw. An envelope would require the handler to
// run and then report that it should not have, which is precisely the work the limiter
// exists to avoid.
// SOURCE: https://www.rfc-editor.org/rfc/rfc6585#section-4 (429 Too Many Requests)
// SOURCE: docs/adr/20260204-rate-limiting.md

export const RATE_LIMITED_CODE = TransportErrorCode.enum.rate_limited

/** What the host is asked. The path is tRPC's dotted procedure name. */
export interface RateLimitRequest {
  readonly orgId: string | null
  readonly path: string
  readonly userId: string | null
}

/**
 * What the host answers. `null` from the port means "this procedure is deliberately
 * unlimited" — a distinct answer from `{ allowed: true }`, which means "counted, and
 * within budget". Collapsing them would make an exemption indistinguishable from a
 * healthy hit in every log and metric downstream.
 */
export interface RateLimitVerdict {
  readonly allowed: boolean
  /** Whole seconds until the caller is inside the budget again. */
  readonly retryAfterSeconds: number
}

export type RateLimitPort = (request: RateLimitRequest) => Promise<RateLimitVerdict | null>

/**
 * The `cause` carried by the thrown TOO_MANY_REQUESTS, so the error formatter can put
 * `retryAfterSeconds` on the wire.
 *
 * A CLASS, not a bag, for the same reason `VersionSkewError` is one: `instanceof` on the
 * cause is a check that cannot be satisfied by an error that merely happens to have a
 * field of that name — and the formatter runs over every error tRPC produces, including
 * ones thrown by handlers this file has never heard of.
 */
export class RateLimitedError extends Error {
  readonly retryAfterSeconds: number

  constructor(retryAfterSeconds: number) {
    super(`rate limit exceeded; retry after ${String(retryAfterSeconds)}s`)
    this.name = 'RateLimitedError'
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export function isRateLimitedError(cause: unknown): cause is RateLimitedError {
  return cause instanceof RateLimitedError
}
