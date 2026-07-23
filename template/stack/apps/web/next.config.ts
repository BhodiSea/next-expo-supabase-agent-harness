import type { NextConfig } from 'next'

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
  '@app/errors',
  '@app/notes',
  '@app/supabase',
]

const nextConfig: NextConfig = {
  transpilePackages: WORKSPACE_PACKAGES,

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
}

export default nextConfig
