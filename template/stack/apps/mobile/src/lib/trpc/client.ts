// TYPE-ONLY, and the `import type` is not a style choice — it is the wall.
//
// @app/api is a DEVDEPENDENCY of this app (package.json.tmpl) consumed through
// this one specifier. Metro does not tree-shake: a value import here, or a
// promotion to a production dependency, drags the entire server graph — the
// service-role Supabase client, the elevated write paths, every leaf the router
// touches — into the native binary, where a determined reader gets all of it.
// `import type` is erased by the compiler, so what ships is the URL string below
// and nothing else.
// SOURCE: design/W1-STACK-SPEC.md §3 (the backend seam: api is a mobile
// devDependency, import type only)
import type { AppRouter } from '@app/api'
import type { Client } from '@app/supabase/client'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import Constants from 'expo-constants'

// ---------------------------------------------------------------------------
// The `any`-degradation guard.
//
// The standard monorepo tRPC failure is silent: one unresolved type in the
// router's import graph (a missing project reference, a package that has not
// been built, a circular import) collapses `AppRouter` to `any`. Every call site
// keeps compiling — `trpc.anything.youLike.mutate(whatever)` type-checks
// perfectly — and the first evidence is a 404 at runtime, on a device, after the
// build. `0 extends 1 & T` is true ONLY for `any` (the intersection collapses to
// `any`, and `0 extends any` holds), so the alias below resolves to `never` in
// exactly that case and the assignment `= true` reds at typecheck.
//
// The const is exported so no linter can prune it as dead code — the whole
// mechanism is the type annotation on a value that must survive.
// ---------------------------------------------------------------------------
type IsAny<T> = 0 extends 1 & T ? true : false
type AssertRouterTyped = IsAny<AppRouter> extends true ? never : true
/** Compile-time only: reds `tsc -b` if AppRouter ever silently degrades to `any`. */
export const APP_ROUTER_IS_TYPED: AssertRouterTyped = true

// The version string the server's skew middleware compares against. Read from
// the RESOLVED config (app.config.ts derives `version` from package.json), so
// the header cannot drift from the binary's own version — the same derivation
// the version-sync gate re-computes. 'dev' when the config is unavailable (unit
// runners with no resolved manifest): a header that lies about the version is
// worse than one that says it does not know.
const CLIENT_VERSION: string = Constants.expoConfig?.version ?? 'dev'

/**
 * The committed transport target. The KEY is `extra.apiOrigin` and the VALUE is
 * {{WEB_ORIGIN}}: mobile now talks to the web app's own origin (which is also
 * the cookie/CORS origin), because `apps/web` is what mounts the tRPC router at
 * /api/trpc. The key name is what the expo-policy gate reads to assert the
 * origin stays https-or-loopback, so it is deliberately unchanged.
 *
 * Dev override via EXPO_PUBLIC_ env; DOT access because Metro inlines the
 * literal member expression at bundle time. `||`, not `??`: a set-but-empty var
 * must fall back too (env.example ships a bare `EXPO_PUBLIC_WEB_ORIGIN=` line,
 * and '' would turn every request into a relative path).
 */
declare const process: { readonly env: { readonly EXPO_PUBLIC_WEB_ORIGIN?: string } }

function webOrigin(): string {
  const extra = Constants.expoConfig?.extra as Record<string, unknown> | undefined
  const configured = extra?.['apiOrigin']
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- here `??` IS the bug: it passes '' through as the origin. The rule is right in general and wrong here.
  return process.env.EXPO_PUBLIC_WEB_ORIGIN || (typeof configured === 'string' ? configured : '')
}

/** The tRPC endpoint apps/web mounts at `app/api/trpc/[trpc]/route.ts`. */
export function trpcEndpoint(): string {
  return `${webOrigin()}/api/trpc`
}

/**
 * Build the typed client for a Supabase session.
 *
 * The bearer token is resolved PER REQUEST inside `headers()`, never captured
 * once at construction: `startAutoRefresh` rotates the access token roughly
 * hourly, and a captured token is a client that works until the first refresh
 * and 401s forever after. Reading it from the Supabase client on every call
 * means a refreshed token is picked up with no wiring at all.
 *
 * No transformer, matching the router: every payload is JSON-safe by
 * construction, which is also what keeps the ActionOutcome envelope a plain
 * serializable union on the wire.
 */
export function createApiClient(supabase: Client) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: trpcEndpoint(),
        headers: async () => {
          const { data } = await supabase.auth.getSession()
          const token = data.session?.access_token
          // The version header rides EVERY request, authenticated or not: the
          // skew check is about the BINARY, not the user, so an unauthenticated
          // call from an out-of-date build must be answerable too.
          return token === undefined
            ? { 'x-client-version': CLIENT_VERSION }
            : { 'x-client-version': CLIENT_VERSION, authorization: `Bearer ${token}` }
        },
      }),
    ],
  })
}

/**
 * The typed client's shape — what providers and hooks pass around. Inferred from the
 * factory, never annotated: `TRPCClient<AppRouter>` carries a module-PRIVATE
 * `unique symbol` (@trpc/client's untypedClientSymbol) that no emitted .d.ts can name,
 * so any attempt to write the type explicitly across a declaration boundary reds. This
 * app never emits declarations (apps/mobile/tsconfig.json: composite off, noEmit on —
 * nothing imports an app), so the inferred type stays internal and the whole problem is
 * moot. SOURCE: design/W1-STACK-SPEC.md §3
 */
export type ApiClient = ReturnType<typeof createApiClient>
