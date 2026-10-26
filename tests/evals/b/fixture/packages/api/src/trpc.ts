import { type OrgSummary, TransportErrorCode } from '@app/contracts'
import { type ActionOutcome, appError, outcomeErr, outcomeOk } from '@app/errors'
import { initTRPC, TRPCError } from '@trpc/server'
import type { Actor, RequestContext } from './context.js'
import { isRateLimitedError, RATE_LIMITED_CODE, RateLimitedError } from './ratelimit.js'
import { isBelowMinimum, isSkewed, isVersionSkewError, VersionSkewError } from './skew.js'

// ---------------------------------------------------------------------------
// The tRPC root.
//
// NO TRANSFORMER. Every payload this router moves is JSON-safe by construction:
// timestamps are ISO strings carried verbatim, ids are strings, and there is no
// `Date`, `Map`, `Set` or `BigInt` anywhere in @app/contracts. A transformer
// would buy nothing and cost the one property that makes this router portable —
// that a plain `fetch` and a `curl` see the same bytes the typed client does.
//
// THE ENVELOPE RULE. Procedures return `ActionOutcome` from @app/errors on the
// DATA channel. A domain failure is never a thrown `TRPCError`: throwing
// flattens the discriminated `AppError` the screens switch on into an HTTP
// status, and a screen that wanted to say "someone else deleted this note" ends
// up saying "something went wrong".
//
// Exactly three things bypass the envelope, and all three are transport-level
// facts a handler could not have produced:
//
//   1. The auth middleware throws UNAUTHORIZED. There is no meaningful data
//      channel for a caller who has not proved who they are, and the client's
//      normalize layer folds it straight back into `appError.unauthorized()`.
//   2. The version-skew guard throws CONFLICT, before any handler runs.
//   3. The rate-limit guard throws TOO_MANY_REQUESTS, also before any handler
//      runs. A limit is a refusal to do the work at all — an envelope would
//      require the handler to execute and then report that it should not have,
//      which is exactly the work the limiter exists to avoid. It is a THROW for
//      a structural reason and not by analogy: middleware has two exits, and
//      neither of them is "return a value on the data channel".
//
// `.input()` parse failures also surface as a thrown BAD_REQUEST. That is
// inherent to tRPC and it is honest: an input that violates the schema is a
// CONTRACT violation, not a domain outcome, and the typed client cannot produce
// one. It is called out here so nobody reads it as a hole in the rule.
// ---------------------------------------------------------------------------

const t = initTRPC.context<RequestContext>().create({
  /**
   * The one place a transport-level failure is given a stable machine-readable
   * name. Clients switch on `data.appCode`, never on the message: messages get
   * reworded, and a guard whose identity depends on prose is one copy-edit from
   * silence.
   *
   * NOT REACHABLE BY VITEST, and left that way deliberately. `createCaller` THROWS errors
   * rather than shaping them, so this body runs only on a real HTTP round trip — which is
   * why the mutation lane reports it as NoCoverage, and why those mutants are RECORDED in
   * tools/mutation-baseline.json with that reason rather than killed.
   *
   * Extracting it to an exported pure function does make it unit-testable, and that was
   * tried: it creates an export no production code imports, which is exactly the dead API
   * `knip --strict` exists to catch. Trading an untested branch for a dead export is not a
   * net gain — it moves the hole rather than closing it. The behaviour is proven where it
   * actually happens: the integration lane's live-api-proof reads `appCode` off the wire.
   */
  errorFormatter({ error, shape }) {
    const appCode = isVersionSkewError(error.cause)
      ? TransportErrorCode.enum.version_skew
      : isRateLimitedError(error.cause)
        ? RATE_LIMITED_CODE
        : error.code === 'UNAUTHORIZED'
          ? TransportErrorCode.enum.unauthorized
          : null
    // How long to wait travels as DATA, not as a Retry-After header: this router is
    // mounted behind a framework handler that owns the response headers, and a client
    // reading the wait from one place and the refusal from another would have two
    // sources of truth for one fact. Absent unless the cause actually carried it —
    // inventing a number here would contradict the limiter that declined to give one.
    const retryAfterSeconds = isRateLimitedError(error.cause)
      ? error.cause.retryAfterSeconds
      : undefined
    return { ...shape, data: { ...shape.data, appCode, retryAfterSeconds } }
  },
})

export const router = t.router
export const createCallerFactory = t.createCallerFactory

/**
 * The skew gate, on the BASE of the ladder so every rung inherits it.
 *
 * With a single mount point there is no route table to walk and therefore no
 * route that can be added without the guard — the property the inherited server
 * had to assert with a test is structural here.
 *
 * Requests WITHOUT the header pass: curl, health tooling and server-to-server
 * callers do not have a client version, and demanding one from them would break
 * the smoke check that exists to tell you the deploy is alive.
 */
const skewGuard = t.middleware(({ ctx, next }) => {
  // Two rejections, ONE response. A different major is a contract break (isSkewed);
  // an old build within the current major that the deploy has chosen to stop serving
  // is the minimum-supported-client floor (isBelowMinimum, inert unless a floor is
  // set). Both mean "this client must update", so both raise the same CONFLICT with
  // the same machine code — the client's handling is identical, and the distinction
  // is a server-log concern, not a wire one.
  if (
    ctx.clientVersion !== null &&
    (isSkewed(ctx.serverMajor, ctx.clientVersion) ||
      isBelowMinimum(ctx.clientVersion, ctx.minSupportedClient))
  ) {
    throw new TRPCError({
      code: 'CONFLICT',
      cause: new VersionSkewError(ctx.serverVersion, ctx.clientVersion),
      message: 'client version is not supported by the server',
    })
  }
  return next()
})

/**
 * The rate-limit gate, on the BASE of the ladder beside the skew guard — so every rung
 * inherits it and there is no procedure that can be added without one.
 *
 * IT RUNS AFTER THE SKEW GUARD, DELIBERATELY. A client the server has already decided it
 * will not serve should be told to update before it is told to slow down: the skew
 * verdict is actionable ("upgrade") and terminal, while a 429 invites the same
 * unsupported client to come back and be rejected again.
 *
 * IT DOES NOT RUN BEFORE AUTHENTICATION, and that is not an oversight — it runs before
 * EVERYTHING, including the auth rung, because an unauthenticated flood is the flood a
 * limiter is most needed for. The consequence is that an anonymous caller is keyed on
 * whatever the host could establish about them (see rateLimitKey), which is weaker than
 * a verified identity and is the honest ceiling of what this layer can do.
 *
 * A NULL PORT MEANS UNLIMITED, not "denied": a worker, a test, and a CLI caller wire no
 * limiter, and a router that refused them would make the limiter a dependency of every
 * non-HTTP caller. The `rate-limits` gate is what proves the WEB host wires one — the
 * absence cannot be caught here, because from inside this file an unwired port and a
 * deliberately unlimited deployment are the same value.
 */
// SOURCE: https://www.rfc-editor.org/rfc/rfc6585#section-4 (429 Too Many Requests)
const rateLimitGuard = t.middleware(async ({ ctx, next, path }) => {
  if (ctx.rateLimit === null) return await next()
  const verdict = await ctx.rateLimit({
    // The ACTIVE org, which is resolved from the caller's real seats — never a header.
    // Keyed as a second dimension so one tenant's traffic cannot exhaust another's.
    orgId: ctx.activeOrg?.id ?? null,
    path,
    userId: ctx.actor?.userId ?? null,
  })
  if (verdict !== null && !verdict.allowed) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      cause: new RateLimitedError(verdict.retryAfterSeconds),
      message: 'rate limit exceeded',
    })
  }
  return await next()
})

/**
 * Rung 1. Open to anyone, still behind the skew and rate-limit gates.
 */
// SOURCE: docs/adr/20260204-rate-limiting.md (the guard rides the BASE of the ladder)
export const publicProcedure = t.procedure.use(skewGuard).use(rateLimitGuard)

/**
 * Rung 2. The ONE sanctioned throw. Narrows `ctx.actor` from `Actor | null` to
 * `Actor` for everything downstream, so no authed handler has to re-check it —
 * and none of them can forget to.
 */
export const authedProcedure = publicProcedure.use(({ ctx, next }) => {
  if (ctx.actor === null) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'authentication required' })
  }
  return next({ ctx: { ...ctx, actor: ctx.actor } })
})

/**
 * Rung 3. Having an active org is an AUTHORIZATION outcome, not a transport
 * fact, so it must not throw — it rides the envelope like every other domain
 * failure.
 *
 * tRPC middleware has exactly two exits: call `next()`, or throw. There is no
 * third exit that returns a value on the data channel. So the gate is resolved
 * HERE (once, in one place) and handed to the handler as an outcome it returns
 * verbatim on the failure path:
 *
 *     const gate = ctx.org
 *     if (!gate.ok) return gate
 *
 * Two lines, and they are the same two lines in every org procedure — which is
 * what makes a missing gate visible in review rather than invisible.
 *
 * WHAT THIS RUNG IS AND IS NOT. It produces a good error BEFORE the round trip:
 * a caller with no active org gets `forbidden(org_context_required)` and a
 * screen that can say something useful, rather than an opaque empty result set
 * from a query that was never going to match. It is NOT the isolation boundary.
 * The boundary is the RLS policies, which key on public.memberships at statement
 * time and are indifferent to everything this file believes. A bug here yields a
 * database denial or an empty page — never a cross-tenant read. That asymmetry
 * is deliberate and it is why this rung is allowed to be simple.
 */
export const orgProcedure = authedProcedure.use(({ ctx, next }) =>
  next({ ctx: { ...ctx, org: orgGate(ctx.activeOrg) } }),
)

/**
 * The ONE place in this package that constructs an envelope by hand. Everywhere
 * else an outcome is produced by @app/notes and returned verbatim, so if the
 * kernel's envelope shape ever moves, this function is the diff.
 *
 * `forbidden`, not `unauthorized`: the caller IS authenticated. Telling a client
 * to re-authenticate when the credentials were never the problem sends it round
 * a login loop it can never exit.
 *
 * ONE code for two situations — no seats at all, and an `x-org-id` that named
 * something the caller does not hold — because distinguishing them on the wire
 * is the existence disclosure `resolveActiveOrg` refuses to make. "You are not
 * acting in an org" is the whole of what a client is entitled to learn.
 */
function orgGate(activeOrg: OrgSummary | null): ActionOutcome<OrgSummary> {
  return activeOrg === null
    ? outcomeErr(
        appError.forbidden({
          code: 'org_context_required',
          message: 'an active organization is required',
        }),
      )
    : outcomeOk(activeOrg)
}

/**
 * The context each rung guarantees, named so routers and the web app's Server
 * Actions can state which rung a helper belongs to instead of re-deriving it
 * from an inferred type.
 */
export type AuthedContext = RequestContext & { readonly actor: Actor }
export type OrgContext = AuthedContext & { readonly org: ActionOutcome<OrgSummary> }
