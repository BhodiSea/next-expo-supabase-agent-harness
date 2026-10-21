import { notesRouter } from './routers/notes.js'
import { systemRouter } from './routers/system.js'
import { router } from './trpc.js'

// ---------------------------------------------------------------------------
// @app/api — the framework-neutral tRPC v11 router.
//
// THE REVERSIBILITY WALL: nothing in this package may import `next/*`. Not the
// router, not the context, not a test. Web mounts this at
// app/api/trpc/[trpc]/route.ts and its Server Actions call the same package
// barrels the router calls — one implementation per operation, two callers.
// Keeping the wall intact is what makes "promote the router to a standalone
// service" a routing change rather than a rewrite.
//
// HOW MOBILE CONSUMES IT: as a devDependency, `import type` ONLY. Metro does not
// tree-shake, so a value import (or a production dependency) drags the entire
// server graph — service-role clients, Node built-ins, framework-coupled leaves
// — into the native binary. The mobile client carries an `IsAny<AppRouter>`
// compile-time assertion so the standard monorepo tRPC failure, where the router
// type silently degrades to `any` and every call site stops being checked, reds
// at typecheck instead of at runtime.
// ---------------------------------------------------------------------------

/**
 * The routers are FLAT and named after the vertical they front. A slice's whole
 * API surface is `appRouter.<slice>`, so adding a vertical is one line here and
 * removing one is one line here — no cross-slice namespace to untangle.
 */
export const appRouter = router({
  notes: notesRouter,
  system: systemRouter,
})

/**
 * The type the clients consume. Exported as a TYPE so `import type` on the
 * mobile side is sufficient and no value ever crosses into the bundle.
 */
export type AppRouter = typeof appRouter

export type {
  Actor,
  CreateContextOptions,
  DomainEvent,
  EventSink,
  HeaderReader,
  HeaderSource,
  RequestContext,
  Session,
} from './context.js'
export { createContext, resolveActiveOrg } from './context.js'
// The CSRF guard for the ambient (cookie) transport. Framework-neutral header
// logic — a host applies it, the router does not — so it lives beside the context
// those hosts build, and a standalone apps/api would reuse it unchanged.
export { CSRF_REJECTED_CODE, hasAmbientSessionCookie, isCrossSiteRequest } from './csrf.js'
// The rate-limit port. The TYPES are what a host needs to wire one; RateLimitedError and
// its guard are exported because the error formatter is not the only place a `cause` is
// inspected — a host that logs 429s reads it too, and `instanceof` across a duplicated
// class is silently false.
export type { RateLimitPort, RateLimitRequest, RateLimitVerdict } from './ratelimit.js'
export { isRateLimitedError, RATE_LIMITED_CODE, RateLimitedError } from './ratelimit.js'
export {
  isVersionSkewError,
  parseMajor,
  parseSemver,
  requireServerMajor,
  VERSION_SKEW_CODE,
  VersionSkewError,
} from './skew.js'
export type { AuthedContext, OrgContext } from './trpc.js'
export {
  authedProcedure,
  createCallerFactory,
  orgProcedure,
  publicProcedure,
  router,
} from './trpc.js'
