// The rate-limit seam.
//
// WHAT THIS BOUNDS, AND WHAT IT DOES NOT. It bounds traffic arriving at the two
// APPLICATION seams — the tRPC router and the Next Server Action / route layer. It does
// NOT bound a client that POSTs straight to `/rest/v1/notes` with the publishable key and
// its own JWT, and it does not bound sign-in or sign-up, which go to GoTrue and touch no
// application rung at all. Those are bounded by Supabase Auth's own limits, by the
// platform WAF, and — the only control that binds EVERY path — by the per-org quota
// trigger and the per-role statement timeouts in the database. This file is a courtesy
// layer over the paths the application owns; it is not the perimeter, and a README that
// sold it as one would be selling a boundary that a five-line curl walks around.
// SOURCE: docs/adr/20260204-rate-limiting.md
//
// FAIL OPEN, DELIBERATELY — BUT NOT UNBOUNDED (0.10.0). When the limiter cannot answer —
// Redis unreachable, a REST timeout, a 500 from the provider — `withFailOpen` reports the
// failure and DEGRADES TO THE IN-PROCESS LIMITER rather than letting everything through.
// A limiter that fails CLOSED converts a dependency outage into a total outage of a
// product that was working fine a second earlier, and it does so at exactly the moment the
// operator is least able to react; that reasoning is unchanged. What changed is that
// "cannot answer" no longer means "no limit at all": through 0.9.9 the outage rung was the
// one place a real limiter existed in this file and was not used. The trade is still
// stated rather than hidden — during an outage the budget is multiplied by the instance
// count, and on a serverless platform that discards the process it approaches no limit —
// and the `degraded` flag makes it visible to a metric. `counted` separates the two
// degraded states: the fallback decided, or the fallback failed too and nothing counted.
//
// NO SDK. The Upstash adapter speaks the documented REST API over plain `fetch`, so this
// package adds ZERO runtime dependencies to a scaffold: no supply-chain surface for a
// control that must keep working during an incident, and one implementation that runs
// unchanged on Node 22, the Edge runtime and in a test.
// SOURCE: https://upstash.com/docs/redis/features/restapi (the REST + pipeline API)

// The WinterCG globals this package uses, declared locally rather than by pulling the
// whole "dom" lib: a server-only package must not be able to reach for `window` or
// `document` by accident, and `types: []` in tsconfig.json is what stops it.
declare const fetch: (
  input: string,
  init?: {
    body?: string
    headers?: Record<string, string>
    method?: string
    signal?: unknown
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>
declare const AbortSignal: { timeout: (ms: number) => unknown }

/**
 * One reviewed budget: a name, how many requests, over how long.
 *
 * `name` is part of the Redis key, so renaming a bucket resets its counters. That is the
 * intended behaviour for a deliberate budget change and worth knowing before someone
 * renames one during an incident.
 */
export interface RateLimitBucket {
  readonly limit: number
  readonly name: string
  readonly windowSeconds: number
}

/**
 * What the limiter decided.
 *
 * `degraded` is NOT a detail. It is the difference between "this request was allowed
 * because the caller is within budget" and "this request was allowed because nothing was
 * counting" — two facts that look identical on the happy path and could not be more
 * different during an incident. Anything that reports on rate limiting must read it.
 */
export interface RateLimitDecision {
  readonly allowed: boolean
  readonly degraded: boolean
  readonly limit: number
  readonly remaining: number
  /** Whole seconds until the caller is inside the budget again; 0 when allowed. */
  readonly retryAfterSeconds: number
  /**
   * Whether a limiter actually COUNTED this hit (0.10.0).
   *
   * `degraded` alone stopped being enough the moment the outage path gained a real
   * limiter. It now covers two materially different states, and an operator needs to tell
   * them apart during the incident, not afterwards:
   *   degraded && counted    — the backend is down and the in-process fallback is
   *                            counting. Budgets are multiplied by the instance count.
   *   degraded && !counted   — the fallback ALSO failed. Nothing counted; this is the pure
   *                            fail-open window the package shipped with.
   * Optional, and read by nobody on the wire: the tRPC route projects a decision down to
   * `{ allowed, retryAfterSeconds }`, so adding it cannot change a response.
   */
  readonly counted?: boolean
}

/** The port. Two adapters ship; a deployment may write a third. */
export interface RateLimiter {
  limit(key: string, bucket: RateLimitBucket): Promise<RateLimitDecision>
}

/**
 * The key an identity gets, built in ONE place so the two seams cannot disagree about
 * whose budget a request spends.
 *
 * The ladder is most-specific-first, and each rung is a different claim:
 *
 *   userId    — a VERIFIED identity. The only rung an attacker cannot choose.
 *   orgId     — the acting org, itself resolved from verified seats. Used as a SECOND
 *               dimension rather than a fallback: a paid tenant's budget must not be
 *               spendable by a stranger who guessed its id.
 *   clientKey — an opaque, host-supplied identifier for an ANONYMOUS caller (a proxy's
 *               view of the peer address). Trustworthy exactly to the extent the host's
 *               proxy overwrites it — see the wiring comment in apps/web.
 *
 * When there is no identity and no clientKey the caller lands in one shared `anon`
 * bucket. That is stated plainly because it has a real consequence: on a deployment that
 * does not wire `clientKey`, one anonymous abuser can exhaust the anonymous budget for
 * every other anonymous caller. It is still better than the alternative — an unkeyed
 * fallback is not a limit at all — and the web host wires the key for this reason.
 */
// SOURCE: docs/adr/20260204-rate-limiting.md (the key ladder: a verified identity outranks a host-supplied one)
export function rateLimitKey(parts: {
  readonly bucket: string
  readonly clientKey?: string | null
  readonly orgId?: string | null
  readonly userId?: string | null
}): string {
  const identity =
    parts.userId != null && parts.userId !== ''
      ? `u:${parts.userId}`
      : parts.clientKey != null && parts.clientKey !== ''
        ? `c:${parts.clientKey}`
        : 'anon'
  const org = parts.orgId != null && parts.orgId !== '' ? `o:${parts.orgId}` : 'o:-'
  return `rl:${parts.bucket}:${identity}:${org}`
}

/**
 * A decision that lets the request through because nothing was counting.
 *
 * `remaining` counts this request as spent, exactly as a healthy first hit would. A
 * healthy decision always counts the hit it is deciding, so `remaining === limit` is a
 * value only a degraded allow could carry — a second fingerprint of degradation that
 * would let a consumer key on it instead of the flag. The `degraded` flag must stay the
 * ONLY field separating the two shapes.
 */
function degradedAllow(bucket: RateLimitBucket): RateLimitDecision {
  return {
    allowed: true,
    degraded: true,
    limit: bucket.limit,
    remaining: Math.max(0, bucket.limit - 1),
    retryAfterSeconds: 0,
  }
}

/**
 * Wrap a limiter so an unavailable backend DEGRADES TO PER-INSTANCE LIMITING and reports
 * itself — rather than letting everything through.
 *
 * Every caller uses this. The adapters below are deliberately allowed to throw — an
 * adapter that swallowed its own failures could never be tested for them, and the
 * decision to fail open belongs at one reviewable seam rather than inside each transport.
 *
 * WHAT 0.10.0 CHANGED, AND WHY IT IS NOT A REVERSAL OF THE FAIL-OPEN DOCTRINE. Through
 * 0.9.9 the catch returned `degradedAllow` unconditionally: during a Redis outage there
 * was no rate limiting at all, on any instance, for as long as the outage lasted. The
 * memory limiter already existed in this file and was already wired at the CONFIGURATION
 * rung (no credentials at boot) — so the outage rung was the one place a real limiter was
 * available and not used. It now runs there too. This is still fail-OPEN relative to the
 * backend: a caller inside the per-instance budget is allowed, and the limiter never
 * converts a dependency outage into a total outage. What changes is the ceiling during an
 * outage — `limit × instances` instead of unbounded — which is the same trade the
 * configuration rung already made, applied at the rung that needs it most.
 *
 * THE FALLBACK INSTANCE IS SHARED, AND THAT IS THE POINT. It is constructed ONCE per
 * wrapper (a default parameter is evaluated at the `withFailOpen(...)` call, not per
 * request), so its window survives a flapping backend: an outage that drops in and out ten
 * times in a minute keeps one counter rather than resetting to zero on each recovery.
 *
 * STATED LOSSES, all three real:
 *   1. `limit × instances` during an outage, and on a serverless platform that discards
 *      the process between requests, effectively no limit at all.
 *   2. `retryAfterSeconds` is computed from the FALLBACK's own sparse hit log, so during
 *      an outage the advice can be up to a full window (3600s on the provisioning bucket)
 *      and is NOT invalidated when the backend recovers. The seeded surfaces neither
 *      render nor sleep on it; a consumer that does is the one taking that risk.
 *   3. The outage's working set is RETAINED after recovery. createMemoryRateLimiter prunes
 *      only the key it is touching, inside limit() — there is no timer and no sweep — so
 *      keys seen during an outage stay in the Map until they are touched again or evicted
 *      by the maxKeys LRU. Bounded in key count, unbounded in per-key array length.
 *      Accepted rather than fixed: a reaper is a timer in a package that deliberately has
 *      no lifecycle, and the LRU already bounds what a hostile caller can cost.
 *
 * @param fallback injectable for the tests; the default is the shared in-process limiter.
 */
export function withFailOpen(
  inner: RateLimiter,
  onUnavailable: (error: unknown) => void,
  fallback: RateLimiter = createMemoryRateLimiter(),
): RateLimiter {
  return {
    async limit(key, bucket) {
      try {
        return await inner.limit(key, bucket)
      } catch (error) {
        onUnavailable(error)
        try {
          // `degraded: true` regardless of the verdict: the caller's ONE degraded-decision
          // log line keys on it, and a DENIAL issued by the fallback is still a decision
          // taken without the backend. `counted: true` is what separates it from the
          // last-resort branch below.
          const decision = await fallback.limit(key, bucket)
          return { ...decision, counted: true, degraded: true }
        } catch {
          // THE LAST RESORT — the fallback threw too. `onUnavailable` deliberately does
          // NOT fire a second time: the caller's contract is exactly one report per
          // degraded decision, and rate-limit-runtime.ts's lastOutageReason would
          // otherwise be overwritten by the in-process failure instead of naming the
          // transport failure that actually caused the outage.
          return { ...degradedAllow(bucket), counted: false }
        }
      }
    },
  }
}

/**
 * How a degraded decision should be reported, as data — the pure half of the caller's log.
 *
 * IT LIVES HERE BECAUSE THE CALLER CANNOT BE UNIT-TESTED. apps/web/lib/rate-limit-runtime.ts
 * opens with `import 'server-only'`, whose exports map resolves to a module that throws
 * outside a React Server Component, so a vitest file importing it dies on the import. That
 * poison pill is correct and stays. Extracting the JUDGEMENT — which of the two degraded
 * states this is, and therefore what the operator must be told — puts it in a module the
 * package's own suite already imports, so the branch has a red-proof instead of an
 * assertion nobody can execute.
 */
export function degradedReport(
  decision: RateLimitDecision,
): { readonly effect: string; readonly counting: boolean } | null {
  if (!decision.degraded) return null
  return decision.counted === false
    ? {
        counting: false,
        effect:
          'NOTHING is counting — the backend and the in-process fallback both failed, so this request was allowed unconditionally',
      }
    : {
        counting: true,
        effect:
          'counting PER PROCESS — the backend is unavailable and the in-process fallback is deciding, so the configured budget is multiplied by the instance count',
      }
}

/**
 * An in-process sliding-window log.
 *
 * HONEST ABOUT WHAT IT IS. This is a real limiter for ONE process and nothing more. On a
 * platform that runs N instances it permits N × limit, and on a serverless platform that
 * discards the process between requests it permits everything. It ships because tests and
 * a local dev server must not need a network service to exercise the seam — never because
 * it is a production limiter. A deployment that reaches for it in production has chosen
 * `limit × instances`, and should say so out loud.
 *
 * `maxKeys` bounds the memory a hostile caller can cost: distinct keys are attacker-
 * influenced (one per anonymous client), so an unbounded Map here would be a slow OOM
 * dressed as a security control. Eviction is oldest-touched-first and is a FAIL-OPEN —
 * an evicted caller starts from zero — which is the same trade the whole module makes.
 */
export function createMemoryRateLimiter(
  options: { readonly maxKeys?: number; readonly now?: () => number } = {},
): RateLimiter {
  const now = options.now ?? (() => Date.now())
  const maxKeys = options.maxKeys ?? 10_000
  const hits = new Map<string, number[]>()

  return {
    limit(key, bucket) {
      const at = now()
      const cutoff = at - bucket.windowSeconds * 1000
      // Re-inserting on every touch makes Map iteration order least-recently-used, which
      // is what the eviction below relies on.
      const kept = (hits.get(key) ?? []).filter((t) => t > cutoff)
      hits.delete(key)
      kept.push(at)
      hits.set(key, kept)

      if (hits.size > maxKeys) {
        const oldest = hits.keys().next()
        if (!oldest.done) hits.delete(oldest.value)
      }

      const count = kept.length
      const allowed = count <= bucket.limit
      // The oldest hit in the window is the one whose expiry frees a slot. `kept` always
      // holds at least the hit just pushed, so `oldest` is never the fallback in practice
      // — it is spelled because noUncheckedIndexedAccess is right that an index read
      // proves nothing, and a NaN retry-after would reach a client as `Retry-After: NaN`.
      const oldest = kept[0] ?? at
      const retryAfterSeconds = allowed
        ? 0
        : Math.max(1, Math.ceil((oldest + bucket.windowSeconds * 1000 - at) / 1000))
      return Promise.resolve({
        allowed,
        degraded: false,
        limit: bucket.limit,
        remaining: Math.max(0, bucket.limit - count),
        retryAfterSeconds,
      })
    },
  }
}

/** Monotonic within a millisecond, so two hits in the same tick are two sorted-set members. */
let memberSeq = 0

interface PipelineReply {
  readonly result?: unknown
}

function pipelineResults(payload: unknown): readonly PipelineReply[] {
  if (!Array.isArray(payload)) {
    throw new Error('@app/ratelimit: Upstash pipeline returned a non-array body')
  }
  return payload as readonly PipelineReply[]
}

/**
 * The Upstash sliding-window adapter, over the REST pipeline API.
 *
 * ONE round trip, five commands, in this order — the order is the algorithm:
 *
 *   1. ZREMRANGEBYSCORE  drop everything older than the window
 *   2. ZADD              record this request
 *   3. ZCARD             how many are in the window now (including this one)
 *   4. ZRANGE 0 0        the oldest survivor's score — when a slot frees up
 *   5. PEXPIRE           so an idle key cannot leak a Redis slot forever
 *
 * A DENIED REQUEST STILL COUNTS. Step 2 runs before the verdict is known, and the member
 * is deliberately not removed on denial: a caller hammering at twice the budget stays
 * denied until they actually slow down, which is the behaviour a limiter exists to
 * produce. The alternative — remove-on-deny — lets a hot loop sit exactly at the limit
 * forever, paying one rejection per window and getting every other request served.
 *
 * `AbortSignal.timeout` is not optional. A limiter that HANGS is worse than one that
 * errors: it adds its own latency to every request it was supposed to protect, and
 * fail-open never triggers because nothing ever fails. The timeout is what turns an
 * unreachable backend into a fast, visible degradation.
 */
export function createUpstashRateLimiter(options: {
  // SOURCE: https://upstash.com/docs/redis/features/restapi (a REST call needs its own deadline)
  readonly timeoutMs?: number
  readonly token: string
  readonly url: string
}): RateLimiter {
  const base = options.url.replace(/\/+$/, '')
  // 1s: a limiter that costs more than the request it protects is a latency amplifier.
  // SOURCE: docs/adr/20260204-rate-limiting.md (a limiter that HANGS is worse than one that errors)
  const timeoutMs = options.timeoutMs ?? 1000

  return {
    async limit(key, bucket) {
      const at = Date.now()
      const windowMs = bucket.windowSeconds * 1000
      memberSeq = (memberSeq + 1) % 1_000_000
      const member = `${String(at)}-${String(memberSeq)}`

      const response = await fetch(`${base}/pipeline`, {
        body: JSON.stringify([
          ['ZREMRANGEBYSCORE', key, '0', String(at - windowMs)],
          ['ZADD', key, String(at), member],
          ['ZCARD', key],
          ['ZRANGE', key, '0', '0', 'WITHSCORES'],
          ['PEXPIRE', key, String(windowMs)],
        ]),
        headers: {
          authorization: `Bearer ${options.token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
        // SOURCE: docs/adr/20260204-rate-limiting.md (the timeout is what makes fail-open fire)
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) {
        throw new Error(`@app/ratelimit: Upstash pipeline responded ${String(response.status)}`)
      }
      const results = pipelineResults(await response.json())

      const count = Number(results[2]?.result ?? 0)
      if (!Number.isFinite(count)) {
        throw new Error('@app/ratelimit: Upstash returned a non-numeric ZCARD')
      }
      const allowed = count <= bucket.limit
      const oldest = Array.isArray(results[3]?.result) ? Number(results[3].result[1]) : Number.NaN
      // A missing or unparseable oldest score must not become NaN seconds on the wire:
      // fall back to the full window, which is the safe over-estimate.
      const retryAfterSeconds = allowed
        ? 0
        : Number.isFinite(oldest)
          ? Math.max(1, Math.ceil((oldest + windowMs - at) / 1000))
          : bucket.windowSeconds

      return {
        allowed,
        degraded: false,
        limit: bucket.limit,
        remaining: Math.max(0, bucket.limit - count),
        retryAfterSeconds,
      }
    },
  }
}

/**
 * The one wiring helper a host calls: build the limiter this deployment actually has.
 *
 * Returns the Upstash adapter when both credentials are present, and the in-process one
 * otherwise — wrapped in `withFailOpen` either way, so a host can never accidentally get
 * a limiter that fails closed. `onMemoryFallback` fires when the credentials are absent
 * so a production deploy without Redis is a log line somebody can find, rather than a
 * silent downgrade to a limiter that counts one instance out of twelve.
 */
export function createRateLimiter(options: {
  readonly onMemoryFallback?: () => void
  readonly onUnavailable: (error: unknown) => void
  // SOURCE: docs/adr/20260204-rate-limiting.md (the host may tighten the REST deadline)
  readonly timeoutMs?: number
  readonly upstashToken?: string | undefined
  readonly upstashUrl?: string | undefined
}): RateLimiter {
  const { upstashToken, upstashUrl } = options
  if (upstashUrl != null && upstashUrl !== '' && upstashToken != null && upstashToken !== '') {
    return withFailOpen(
      createUpstashRateLimiter({
        // Spread rather than `timeoutMs: options.timeoutMs`: under
        // exactOptionalPropertyTypes an explicit `undefined` is NOT the same as an absent
        // key, and passing one would defeat the adapter's own default.
        // SOURCE: docs/adr/20260204-rate-limiting.md
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        token: upstashToken,
        url: upstashUrl,
      }),
      options.onUnavailable,
    )
  }
  options.onMemoryFallback?.()
  return withFailOpen(createMemoryRateLimiter(), options.onUnavailable)
}
