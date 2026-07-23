// The skew code comes from @app/contracts, NOT from @app/api's VERSION_SKEW_CODE
// re-export, and the difference is the bundling wall rather than taste: @app/api
// is a devDependency this app may only touch with `import type`, so a value read
// from it would drag the server graph into the native binary. Both constants are
// the same one — @app/api derives its from this enum — so reading it here is the
// SAME single spelling, taken from the side of the wire mobile is allowed to load.
// SOURCE: design/W1-STACK-SPEC.md §3 (api is a mobile devDependency, import type
// only) · packages/api/src/skew.ts (VERSION_SKEW_CODE = TransportErrorCode.enum.version_skew)
import { TransportErrorCode } from '@app/contracts'
import { type ActionOutcome, appError } from '@app/errors'
import { TRPCClientError } from '@trpc/client'

const VERSION_SKEW_CODE = TransportErrorCode.enum.version_skew

// The fold that makes ONE envelope true end to end.
//
// The router's contract (design/W1-STACK-SPEC.md §3) is that a DOMAIN failure
// travels on the DATA channel as `{ ok: false, error: AppError }` — never a
// thrown TRPCError, because throwing flattens the AppError discriminant every
// screen switches on into a string. That contract holds for everything the
// server can reason about.
//
// It cannot hold for what the server never got to answer. A dropped socket, a
// captive-portal HTML 502, a 401 from the auth middleware (the ONE place the
// router is allowed to throw), a JSON body that is not our envelope — those
// arrive on the PROMISE channel, as a rejection. If screens had to handle both
// channels, every call site would grow a try/catch, and the ones that forgot
// would crash a render instead of showing an error state. So this module is the
// single place a rejection becomes an outcome: after `callProcedure`, there is
// exactly one shape, and `!outcome.ok` is the whole failure vocabulary.
// SOURCE: design/W1-STACK-SPEC.md §3 — the envelope rule and the mobile
// normalize layer that folds transport-level UNAUTHORIZED back onto it

/**
 * tRPC's transport-level error codes, mapped to what the user actually
 * experienced. Deliberately a SMALL map with a default, not an exhaustive one:
 * tRPC owns this enum and adds to it, and an unknown code must degrade to
 * "something failed" rather than red a typecheck the router did not change.
 */
function fromTrpcCode(code: string, message: string): ActionOutcome<never> {
  switch (code) {
    // The auth middleware is the one procedure layer permitted to throw
    // (transport-level UNAUTHORIZED). Folding it back to the kernel's own
    // unauthorized variant is what lets a signed-out session read identically
    // whether it was the middleware or a domain check that noticed.
    //
    // FORBIDDEN is deliberately NOT folded in here: the kernel keeps
    // `unauthorized` ("no verified identity — sign in") apart from `forbidden`
    // ("identity verified, permission refused"), and collapsing the second onto
    // the first sends a signed-in user round a login loop they can never exit —
    // they are already signed in, so signing in again changes nothing.
    case 'UNAUTHORIZED':
      return { ok: false, error: appError.unauthorized() }
    case 'FORBIDDEN':
      return { ok: false, error: appError.forbidden({ message }) }
    // A BAD_REQUEST from the transport means zod rejected the INPUT before the
    // procedure body ran — the same class of failure as a domain validation
    // error, so it lands in the same variant. `fields` is left ABSENT rather
    // than set to a placeholder path: the wire shape does not say which field
    // failed, and a form that attached the message to the wrong input would be
    // worse than one that shows it at the top. The message stays the detail.
    case 'BAD_REQUEST':
    case 'PARSE_ERROR':
      return { ok: false, error: appError.validation({ message }) }
    case 'NOT_FOUND':
      return { ok: false, error: appError.notFound({ message }) }
    case 'TOO_MANY_REQUESTS':
      return { ok: false, error: appError.rateLimited({ message }) }
    // The ONLY thing that throws CONFLICT on this router is the version-skew
    // guard on the base of the procedure ladder (@app/api src/skew.ts): a
    // DOMAIN conflict rides the envelope like every other domain failure, so it
    // can never arrive on this channel. The stable code is the contract
    // constant both ends spell once, so the screens can say "update to
    // continue" instead of "something went wrong".
    // SOURCE: packages/api/src/skew.ts (skewGuard throws CONFLICT carrying
    // VersionSkewError) · @app/contracts TransportErrorCode
    case 'CONFLICT':
      return {
        ok: false,
        error: appError.conflict({ code: VERSION_SKEW_CODE, message }),
      }
    default:
      return { ok: false, error: appError.unknown({ message }) }
  }
}

/**
 * The tRPC error code carried on `error.data`, or null when there is no shaped
 * response. Takes `unknown` rather than a typed error: the shape of `.data` is
 * the SERVER's error formatter, which this app does not own and must not assume
 * — every access below is guarded, so a formatter change degrades to "unshaped"
 * instead of throwing inside the error handler.
 */
function shapedCode(data: unknown): string | null {
  if (typeof data !== 'object' || data === null || !('code' in data)) return null
  const code = (data as { readonly code?: unknown }).code
  return typeof code === 'string' ? code : null
}

/**
 * Await a procedure call and guarantee an ActionOutcome comes back.
 *
 * Every read and every write goes through here. The generic is the procedure's
 * OWN payload type (`ActionOutcome<T>` in, `ActionOutcome<T>` out), so the fold
 * costs nothing at the type level — call sites keep the router's inferred data
 * type and simply stop having a rejection path.
 */
export async function callProcedure<T>(call: Promise<ActionOutcome<T>>): Promise<ActionOutcome<T>> {
  try {
    return await call
  } catch (cause) {
    if (cause instanceof TRPCClientError) {
      // `.data` — the SERVER's shaped error payload — not the error object
      // itself. TRPCClientError has no `code` of its own: reading the instance
      // would find nothing on every response, shaped or not, and quietly route
      // every server rejection down the offline branch below. The distinction
      // this whole function exists to draw would be inverted.
      const code = shapedCode((cause as TRPCClientError<never>).data)
      // NO shaped response at all — the request never reached a procedure. This
      // is the offline/unreachable case, and it must NOT read as a server error:
      // "something went wrong on the server" is a lie when the phone is in a
      // tunnel, and it sends the user to support instead of to their signal bars.
      // `unavailable` is also the kernel's ONE retryable kind, which is exactly
      // the advice a tunnel deserves.
      if (code === null) return { ok: false, error: appError.unavailable({ message: cause.message }) }
      return fromTrpcCode(code, cause.message)
    }
    // Not a tRPC error at all: a bug in a link, an aborted request, a throw from
    // inside the client. Unknown by nature, so it says exactly that — and keeps
    // the underlying text as the technical detail so it stays traceable.
    return {
      ok: false,
      error: appError.unknown({ message: cause instanceof Error ? cause.message : String(cause) }),
    }
  }
}
