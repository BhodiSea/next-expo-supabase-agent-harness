import { defineConfig } from 'vitest/config'

// The web workspace's Vitest project. The root config lists this directory in its
// `projects` array; `pnpm --filter web test` loads it directly. It exists for ONE reason
// that cannot be expressed in the root config: esbuild's JSX mode.
//
// tsconfig.json sets `jsx: "preserve"` because Next must receive untransformed JSX. Vitest
// reads that same tsconfig, so without the override below esbuild hands raw JSX to Node
// and every .tsx suite dies with a syntax error at import time — a failure that reads like
// a broken test file rather than a compiler-configuration mismatch. `automatic` is the
// React 19 runtime (no `import React` ceremony); it applies to the TEST transform only and
// changes nothing about what Next ships.
//
// environment: 'node', not jsdom. The suites here render through react-dom/server
// (renderToStaticMarkup) — the same server pass the App Router itself performs — so the
// assertions are about the MARKUP the server produces, which is what a Server Component
// actually contributes. That keeps the web unit lane dependency-free (no jsdom, no
// happy-dom, no extra catalog pin) and keeps it honest: a DOM emulator would invite tests
// that assert on behaviour this app deliberately does not run on the client.
// SOURCE: docs/harness/README.md (determinism doctrine: the runner tests what ships)
export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  test: {
    name: 'web-unit',
    environment: 'node',
    include: ['__tests__/**/*.test.ts', '__tests__/**/*.test.tsx'],
  },
})
