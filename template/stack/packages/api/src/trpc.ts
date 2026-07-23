import { TransportErrorCode } from '@app/contracts'
import { type ActionOutcome, appError, outcomeErr, outcomeOk } from '@app/errors'
import { initTRPC, TRPCError } from '@trpc/server'
import type { Actor, Membership, RequestContext } from './context.js'
import { isSkewed, isVersionSkewError, VersionSkewError } from './skew.js'

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
// Exactly two things bypass the envelope, and both are transport-level facts a
// handler could not have produced:
//
//   1. The auth middleware throws UNAUTHORIZED. There is no meaningful data
//      channel for a caller who has not proved who they are, and the client's
//      normalize layer folds it straight back into `appError.unauthorized()`.
//   2. The version-skew guard throws CONFLICT, before any handler runs.
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
   */
  errorFormatter({ error, shape }) {
    const appCode = isVersionSkewError(error.cause)
      ? TransportErrorCode.enum.version_skew
      : error.code === 'UNAUTHORIZED'
        ? TransportErrorCode.enum.unauthorized
        : null
    return { ...shape, data: { ...shape.data, appCode } }
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
  if (ctx.clientVersion !== null && isSkewed(ctx.serverMajor, ctx.clientVersion)) {
    throw new TRPCError({
      code: 'CONFLICT',
      cause: new VersionSkewError(ctx.serverVersion, ctx.clientVersion),
      message: 'client major version does not match the server',
    })
  }
  return next()
})

/**
 * Rung 1. Open to anyone, still behind the skew gate.
 */
export const publicProcedure = t.procedure.use(skewGuard)

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
 * Rung 3. Membership is an AUTHORIZATION outcome, not a transport fact, so it
 * must not throw — it rides the envelope like every other domain failure.
 *
 * tRPC middleware has exactly two exits: call `next()`, or throw. There is no
 * third exit that returns a value on the data channel. So the gate is resolved
 * HERE (once, in one place) and handed to the handler as an outcome it returns
 * verbatim on the failure path:
 *
 *     const gate = ctx.member
 *     if (!gate.ok) return gate
 *
 * Two lines, and they are the same two lines in every member procedure — which
 * is what makes a missing gate visible in review rather than invisible.
 */
export const memberProcedure = authedProcedure.use(({ ctx, next }) =>
  next({ ctx: { ...ctx, member: memberGate(ctx.membership) } }),
)

/**
 * The ONE place in this package that constructs an envelope by hand. Everywhere
 * else an outcome is produced by @app/notes and returned verbatim, so if the
 * kernel's envelope shape ever moves, this function is the diff.
 *
 * `forbidden`, not `unauthorized`: the caller IS authenticated. Telling a client
 * to re-authenticate when the credentials were never the problem sends it round
 * a login loop it can never exit.
 */
function memberGate(membership: Membership | null): ActionOutcome<Membership> {
  return membership === null
    ? outcomeErr(
        appError.forbidden({
          code: 'membership_required',
          message: 'an active workspace membership is required',
        }),
      )
    : outcomeOk(membership)
}

/**
 * The context each rung guarantees, named so routers and the web app's Server
 * Actions can state which rung a helper belongs to instead of re-deriving it
 * from an inferred type.
 */
export type AuthedContext = RequestContext & { readonly actor: Actor }
export type MemberContext = AuthedContext & { readonly member: ActionOutcome<Membership> }
