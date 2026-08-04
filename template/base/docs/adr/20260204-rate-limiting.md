# ADR: rate limiting at the application seams

**Status:** accepted · **Date:** 2026-02-04 · **Supersedes:** nothing

## Context

`appError.rateLimited()` existed in the kernel from the first commit and had no producer:
every client could receive a rate-limit outcome, and nothing in the system could emit one.
The mobile normalize layer already folded `TOO_MANY_REQUESTS` back onto the envelope for a
server that never sent it.

Two application surfaces accept unauthenticated HTTP: the tRPC router at `/api/trpc`, and
the Next Server Action layer, whose endpoints are generated ids that anyone can POST to.
Neither had a limiter.

## Decision

### 1. Limit at both seams, in the layer that owns each

The router gets a **middleware on the base of the procedure ladder**, so every rung
inherits it and there is no procedure that can be added without one. It **throws**
`TOO_MANY_REQUESTS`, joining `UNAUTHORIZED` and the skew guard's `CONFLICT` as the third
sanctioned bypass of the envelope rule. That is structural, not stylistic: tRPC middleware
has exactly two exits — call `next()`, or throw — and an envelope would require the handler
to run and then report that it should not have, which is the work the limiter exists to
avoid.

Server Actions get **two lines at the top of each action**, deliberately the same shape as
the org gate one rung down, and they **return an envelope** rather than throwing, because a
Server Action has a data channel and the system's rule is that a failure a caller can act
on travels on it.

### 2. Fail OPEN when the limiter cannot answer

Redis unreachable, a REST timeout, a provider 500 → the request is **allowed** and the
decision carries `degraded: true`.

A limiter that fails closed converts a dependency outage into a total outage of a product
that was working a second earlier, at the moment an operator is least able to react — for a
control that is a courtesy layer rather than the authorization boundary. The cost is real
and stated: **during a limiter outage there is no rate limiting.** The `degraded` flag, and
the `error`-level log behind it, are what make that a metric instead of a silence.

The adapters are deliberately allowed to throw. Fail-open lives at one reviewable seam
(`withFailOpen`), because an adapter that swallowed its own failures could never be tested
for them.

### 3. Upstash over its REST API, with no SDK

`@upstash/redis` was considered and not taken. The adapter is ~40 lines of `fetch` against
the documented pipeline endpoint, which means the scaffold adds **zero runtime
dependencies** for a control that must keep working during an incident, and one
implementation that runs unchanged on Node 22, the Edge runtime, and in a test.

The algorithm is a sliding-window log over a sorted set — five commands in one pipeline,
where the order *is* the algorithm. A denied request still counts: removing the member on
denial lets a hot loop sit exactly at the limit forever, paying one rejection per window
and getting every other request served.

`AbortSignal.timeout` is not optional. A limiter that **hangs** is worse than one that
errors: it adds its own latency to every request it was meant to protect, and fail-open
never triggers because nothing ever fails.

### 4. Credentials are optional, and their absence is loud

`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` are read in the web app's runtime
module rather than in `@app/env`'s fail-fast server schema, because a deployment with no
Redis is a **supported configuration** — it falls back to the in-process limiter. Putting
an optional pair into a schema whose stated rule is "every entry here is a value whose
disclosure is an incident" would make that rule untrue.

The fallback logs at **error**, not warn: on a platform running N instances the in-process
limiter permits `limit × N`, and on a serverless one that discards the process it permits
everything — so a production deploy that lost its Redis variables looks identical to a
healthy one on every dashboard unless that line exists to be alerted on.

### 5. The budget is reviewed data, closed against a generated inventory

`tools/rate-limit-budget.json` is what a human approved; `apps/web/lib/rate-limit.ts` is
what runs. `tools/check-rate-limits.mjs` evaluates the module and diffs it **by value**, so
a number changed in code without a reviewed diff reds, and so does the reverse.

The load-bearing rule is the **closure**: every mutation in
`tools/generated/action-inventory.json` — walked out of the composed router, never
hand-written — must map to a bucket or carry a reasoned exemption, in both directions. The
vacuity this prevents is not "the numbers are wrong"; it is a limiter that is wired,
tested, and reaches nothing because the newest write path was never added to the policy.

An **unknown** name resolves to the write bucket, never to null: a procedure added without
touching the policy is limited (wrongly, in the harmless direction) for the seconds between
writing the router and running the chain.

## Honest losses

- **This is not the perimeter.** It does not bind a client that POSTs straight to
  `/rest/v1/notes` with the publishable key and its own JWT, and it does not bind sign-in
  or sign-up, which go to GoTrue and touch no application rung. Those are bounded by
  Supabase Auth's own limits and the platform WAF. The controls that bind **every** path
  are the per-org quota trigger and the per-role statement timeouts.
- **The Server Action seam keys on the proxy's view of the caller**, because it runs before
  the action resolves an identity — which is the placement that actually stops an
  unauthenticated flood. The cost is that an office behind one NAT shares a budget. A
  deployment that prefers per-user budgets moves the call below the identity resolution and
  pays an auth round trip per abusive request.
- **`x-forwarded-for` is trustworthy exactly to the extent the platform overwrites it.**
  Behind Vercel it is; on a deployment that terminates TLS itself it is attacker-controlled
  and anonymous limiting degrades to nothing. It never weakens anything else, because a
  verified `userId` always outranks it in the key.
- **The in-process fallback is not a production limiter.** It is honest about being one
  process, and it ships so tests and local development need no network service.

## Sources

- <https://upstash.com/docs/redis/features/restapi> — the REST + pipeline API
- <https://www.rfc-editor.org/rfc/rfc6585#section-4> — 429 Too Many Requests
- <https://www.rfc-editor.org/rfc/rfc7239#section-5.2> — X-Forwarded-For semantics
- `packages/api/src/trpc.ts` — the envelope rule and its three sanctioned bypasses
- `tools/db-limits.json` — the controls that bind every path, not only the application ones
