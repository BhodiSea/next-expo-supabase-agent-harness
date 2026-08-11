import 'server-only'

import { optionalServerEnv } from '@app/env/optional'
import { type ActionOutcome, appError, outcomeErr } from '@app/errors'
import { createLogger } from '@app/observability'
import {
  createRateLimiter,
  type RateLimitBucket,
  type RateLimitDecision,
  // SOURCE: docs/adr/20260204-rate-limiting.md (one key builder, so the two seams cannot disagree)
  rateLimitKey,
} from '@app/ratelimit'
import { bucketForAction } from './rate-limit'

// The limiter this deployment actually has, and the ONE place it is built.
//
// MODULE SCOPE IS CORRECT HERE, and it is the exception that proves the request-scoped
// rule elsewhere. A Supabase client is per-request because it CARRIES AN IDENTITY, and
// sharing one across concurrent requests renders one user's data under another's. This
// object carries no identity at all: it is a stateless HTTP client plus a budget table,
// and the identity arrives as an argument on every call. Building it per request would
// re-read the environment and re-allocate on every hit of a path whose entire purpose is
// to be cheap.
// SOURCE: docs/adr/20260204-rate-limiting.md

const log = createLogger({ base: { component: 'ratelimit' } })

// The Upstash pair arrives through @app/env/optional — the register's optional server
// section (0.9.5). OPTIONAL ≠ UN-SEEN: a deployment with no Redis is still a supported
// configuration (the in-process fallback below, loudly), but a PRESENT value is now
// validated at boot, and a half-set pair is a boot failure instead of a production
// limiter silently degraded to per-process. The old shape — a raw process.env read with
// a local ambient declare — was the exact bypass the env-through-register lint rule and
// the retired env-register-gate obligations row existed to end.

// The transport reason behind the most recent degraded decision. Written by onUnavailable
// (which fires exactly once per degraded decision, inside withFailOpen's catch) and read
// by the ONE degraded-decision log line in spendRateLimit below — module scope for the
// same reason the limiter is: it carries no identity, only the last outage's message.
let lastOutageReason = 'unknown'

const limiter = createRateLimiter({
  onMemoryFallback: () => {
    // ERROR, not warn. On a platform that runs more than one instance the in-process
    // limiter permits `limit × instances`, and on a serverless one that discards the
    // process it permits everything — so a production deploy that lost its Redis
    // variables looks identical to a healthy one on every dashboard unless this line
    // exists to be alerted on.
    log.error('rate limiter has no Redis credentials — falling back to a PER-PROCESS limiter', {
      effect: 'the configured budgets are multiplied by the instance count',
    })
  },
  onUnavailable: (error) => {
    // Capture only; the log line lives in spendRateLimit, where the DECISION is known —
    // exactly ONE structured ERROR per degraded decision, with the bucket named, instead
    // of a context-free transport line here and a second line there.
    // The message only. An error object from a fetch can carry the request URL, and
    // that URL has the Upstash token in neither the path nor the query today — but
    // "today" is the wrong thing to bet a credential on.
    lastOutageReason = error instanceof Error ? error.message : 'unknown'
  },
  upstashToken: optionalServerEnv.UPSTASH_REDIS_REST_TOKEN,
  upstashUrl: optionalServerEnv.UPSTASH_REDIS_REST_URL,
})

/**
 * The proxy's view of the peer, for callers with no verified identity.
 *
 * TRUSTWORTHY EXACTLY TO THE EXTENT THE PLATFORM OVERWRITES IT. On Vercel (and behind any
 * proxy that sets rather than appends) the first hop is the real client and a caller
 * cannot forge it. On a deployment that terminates TLS itself, `x-forwarded-for` is
 * attacker-controlled and this returns a value an abuser rotates per request — which
 * degrades anonymous limiting to nothing, and does NOT weaken anything else, because a
 * verified `userId` always outranks this rung (see rateLimitKey).
 *
 * That asymmetry is why the client key is only ever a fallback: the worst case is "no
 * limit for anonymous callers on a misconfigured proxy", never "one caller spends
 * another's budget".
 * SOURCE: https://www.rfc-editor.org/rfc/rfc7239#section-5.2 (X-Forwarded-For semantics)
 */
export function clientKeyFromHeaders(headers: { get(name: string): string | null }): string | null {
  const forwarded = headers.get('x-forwarded-for')
  if (forwarded === null) return null
  const first = forwarded.split(',')[0]?.trim()
  return first === undefined || first === '' ? null : first
}

/**
 * Spend one unit of a bucket, or report that the caller is out.
 *
 * Returns the decision rather than throwing, because the two seams need different
 * failures out of the same fact: the router throws a transport-level TOO_MANY_REQUESTS
 * (its clients fold that back onto the envelope), and a Server Action returns an
 * `AppError` on the data channel. A helper that threw would force one of them to catch
 * its own control flow.
 */
export async function spendRateLimit(
  bucket: RateLimitBucket | null,
  identity: {
    readonly clientKey?: string | null
    readonly orgId?: string | null
    readonly userId?: string | null
  },
): Promise<RateLimitDecision | null> {
  if (bucket === null) return null
  // SOURCE: docs/adr/20260204-rate-limiting.md
  const decision = await limiter.limit(rateLimitKey({ bucket: bucket.name, ...identity }), bucket)
  // THE DEGRADED FLAG IS LOAD-BEARING (0.9.0). `degraded: true` means "allowed because
  // nothing was counting" — indistinguishable from a healthy allow to both consumers
  // downstream (the tRPC route port and the Server Action seam read `allowed` only), so
  // it is read HERE, the one seam both decisions flow through: exactly ONE structured
  // ERROR per degraded decision, with the bucket named and the transport reason folded
  // in. Redaction discipline unchanged — the bucket name is reviewed data and the reason
  // is an Error message, never the raw error object.
  if (decision.degraded) {
    log.error('rate limit decision DEGRADED — request allowed because nothing was counting', {
      bucket: bucket.name,
      limit: bucket.limit,
      reason: lastOutageReason,
    })
  }
  return decision
}

/**
 * The Server Action seam: spend a unit, or hand back the outcome to return.
 *
 * TWO LINES AT THE TOP OF EVERY ACTION, deliberately the same shape as the org gate one
 * rung down (`const gate = ctx.org; if (!gate.ok) return gate`):
 *
 *     const limited = await enforceActionRateLimit('createNoteAction')
 *     if (limited !== null) return limited
 *
 * It returns an ENVELOPE rather than throwing, because a Server Action has a data channel
 * and the whole system's rule is that a failure a caller can act on travels on it. That
 * is the opposite decision from the router, which throws — and the difference is not
 * inconsistency: tRPC middleware has no data channel to return on, and this function is
 * not middleware.
 *
 * KEYED ON THE PROXY'S VIEW OF THE CALLER, not on a verified identity, because it runs
 * BEFORE the action resolves one. That placement is the point: an unauthenticated flood
 * at a Server Action id is the flood worth stopping, and stopping it after `getUser()`
 * would mean paying an auth round trip per abusive request. The honest cost is that a
 * whole office behind one NAT shares a budget. A deployment that would rather have
 * per-user budgets moves this call below the identity resolution and passes the userId —
 * and then pays that round trip. The budgets here are set for the first shape.
 */
export async function enforceActionRateLimit(
  name: string,
  identity: { readonly orgId?: string | null; readonly userId?: string | null } = {},
): Promise<ActionOutcome<never> | null> {
  // Imported lazily: `next/headers` is only callable inside a request scope, and a
  // top-level import would make this module unloadable from a unit test that never has
  // one. The dynamic form keeps the seam testable without a Next request.
  const { headers } = await import('next/headers')
  const decision = await spendRateLimit(bucketForAction(name), {
    clientKey: clientKeyFromHeaders(await headers()),
    ...identity,
  })
  if (decision === null || decision.allowed) return null
  return outcomeErr(
    // SOURCE: https://www.rfc-editor.org/rfc/rfc6585#section-4 (429 Too Many Requests)
    appError.rateLimited({
      message: 'Too many requests. Please wait a moment and try again.',
      retryAfterSeconds: decision.retryAfterSeconds,
    }),
  )
}
