import type { NextConfig } from 'next'
import { authenticatedCacheHeaders, staticSecurityHeaders } from './lib/security-headers'

// The narrowest shape of webpack's config this file touches. Next types its `webpack`
// callback parameter as `any` (it re-exports webpack's own loose config type), which
// under strictTypeChecked makes every property access an unsafe-member-access and the
// return an unsafe-return. Declaring only `resolve.extensionAlias` keeps the callback
// type-safe AND documents its entire blast radius; it stays assignable to Next's
// signature because an `any` parameter is bivariant.
interface WebpackConfigShim {
  resolve?: { extensionAlias?: Record<string, string[]> }
}

// The web app is BOTH the browser client and the API host: app/api/trpc/[trpc]/route.ts
// mounts the same @app/api router the Expo app calls over HTTP. Everything in this file
// exists to keep that dual role honest.
//
// transpilePackages is the load-bearing line. Every @app/* package ships RAW TypeScript
// through its `exports` map ("." -> ./src/index.ts) with NO build step — that is the whole
// mechanism by which a Next surface and a Metro surface share one source of truth (Metro
// resolves the same raw source natively; Next needs to be TOLD, because its default
// pipeline treats node_modules as already-compiled JS). Without this list the dev server
// and `next build` fail on the first `import { appRouter } from '@app/api'` with a bare
// "unexpected token" out of the workspace symlink, and the usual "fix" — adding a tsup/tsc
// build step per package — reintroduces the build graph this stack exists to avoid.
//
// LOCKSTEP: this array must name every @app/* package apps/web depends on. A workspace dep
// added to package.json and forgotten here compiles under `tsc -b` (TypeScript follows the
// exports map fine) and only explodes at runtime — the worst possible failure ordering.
// SOURCE: docs/harness/README.md (one source of truth, no build step between workspaces)
const WORKSPACE_PACKAGES = [
  '@app/api',
  '@app/contracts',
  '@app/design-system',
  '@app/design-tokens',
  '@app/env',
  '@app/errors',
  '@app/notes',
  '@app/observability',
  '@app/supabase',
]

const nextConfig: NextConfig = {
  transpilePackages: WORKSPACE_PACKAGES,

  // The WEB ANALOG of apps/mobile/metro.config.js's resolver shim. The @app/* packages above
  // are `moduleResolution: NodeNext` (they type-check under `tsc -b` and their emitted dist is
  // valid Node ESM), so their relative imports carry explicit `.js` extensions that map to a
  // `.ts` source on disk — `export * from './client.js'` where only `client.ts` exists. A
  // bundler must be TOLD that a `.js` specifier may resolve to a `.ts`: webpack's
  // `resolve.extensionAlias` is exactly that instruction, the same "try it as `.js`, fall back
  // to the `.ts`" the Metro shim performs. Without it every barrel re-export fails with
  // `Module not found: Can't resolve './client.js'` and the web surface never boots.
  //
  // WHY WEBPACK, NOT TURBOPACK. Turbopack (Next 16's default bundler) has no `extensionAlias`
  // equivalent, so it cannot make this mapping — which is why apps/web/package.json runs `next
  // dev`/`next build` with the `--webpack` flag (Next 16 errors on a webpack config under the
  // default Turbopack, telling you to choose explicitly). This is the same correctness-over-
  // speed trade the harness already makes in choosing `tsc -b` solution mode over a Turborepo
  // task graph: one source of truth, no per-package build step, resolved by a bundler that can
  // follow NodeNext's `.js` convention. The `.mjs`/`.cjs` rows keep the mapping honest for the
  // ESM/CJS variants some dependencies ship.
  //
  // THE ALTERNATIVE, stated so the trade is a choice and not a cage: a consumer who would rather
  // keep Turbopack can switch the @app/* packages to `moduleResolution: Bundler` and drop the
  // `.js` extensions from their relative imports — then this block, the two `--webpack` flags,
  // and the Metro shim all become unnecessary. That is a wider change (every package + its
  // tests) and it forfeits the packages' valid-Node-ESM emit, which is why the shipped default
  // keeps NodeNext and shims the two bundlers instead.
  // Next types this callback's `config` as `any`, and `any` spreads: every touch below
  // would red under strictTypeChecked's no-unsafe-* family. Naming the ONE field this
  // block actually reaches is both the fix and the honest documentation of its scope —
  // the object is returned unchanged, so runtime behaviour is identical.
  webpack: (config: WebpackConfigShim): WebpackConfigShim => {
    config.resolve ??= {}
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
      '.cjs': ['.cts', '.cjs'],
    }
    return config
  },

  // Typed routes turn `<Link href="/notes">` into a checked expression: a route that was
  // renamed or deleted reds at typecheck instead of 404ing in production. It is the same
  // doctrine as the mobile side's ROUTES manifest — the route set is a contract, not a
  // collection of strings.
  typedRoutes: true,

  // Strict mode double-invokes render/effects in development so a component that is not
  // idempotent (the classic "fetch in render" / uncleaned subscription) fails LOUDLY on the
  // developer's machine rather than intermittently under concurrent rendering in prod.
  // SOURCE: https://react.dev/reference/react/StrictMode (docs/harness/README.md — fail loud, fail early)
  reactStrictMode: true,

  // `x-powered-by` names the framework and version to every scanner on the internet for
  // zero benefit. Off by default here so the posture does not depend on a reverse proxy
  // someone remembers to configure.
  poweredByHeader: false,

  typescript: {
    // Explicit, not default: `next build` must NEVER ship a type error. The flag is stated
    // so that turning it off is a visible diff in review rather than an undocumented
    // assumption — this app is inside the same strict-TS cage as every other workspace
    // (tsconfig.base.json), and the build is the last place that cage may be opened.
    ignoreBuildErrors: false,
  },

  // The request-independent half of the security posture. It lives HERE rather than in
  // proxy.ts because these headers must reach responses the proxy never sees: its matcher
  // excludes api/trpc, .well-known and every static asset, and CVE-2025-29927 is the
  // standing reminder that a request-interception layer is one framework bug away from not
  // running at all. A header set that depends on middleware executing is a header set that
  // is sometimes absent.
  //
  // The per-request half (the nonce CSP) cannot live here — `headers()` is evaluated at
  // build time and has no request to mint a nonce for. That split is why the gate reads
  // BOTH staticSecurityHeaders() and contentSecurityPolicy() out of the same module.
  // SOURCE: apps/web/lib/security-headers.ts · tools/security-headers.json (the reviewed policy)
  // Not `async`: this function awaits nothing, and an async function with no await is a
  // promise wrapper pretending to be IO. Next's type wants a Promise, so return one.
  headers() {
    return Promise.resolve([
      { source: '/:path*', headers: [...staticSecurityHeaders()] },
      // The API surface carries tenant rows in every response. `private, no-store` plus a
      // Vary naming the acting-org selector is what stops a shared cache keying two
      // tenants' responses to the same URL.
      { source: '/api/:path*', headers: [...authenticatedCacheHeaders()] },
    ])
  },
}

export default nextConfig
