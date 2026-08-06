import { defineConfig } from 'vitest/config'

// The web workspace's Vitest project. As of 0.4.0 the ROOT config declares it too — by
// PATH (`'./apps/web/vitest.config.ts'` in its `projects` array), so `pnpm test`, the Stop
// hook's `unit` step and `pnpm --filter web test` all run this one project and cannot
// drift. Before 0.4.0 this file was loaded only by the filtered command and apps/web was a
// declared enforcement TIER with the browser lane as its compensating control; that tier is
// now narrowed to `app/` alone (see docs/harness/enforcement-tiers.md).
//
// It stays a separate FILE rather than an inline entry in the root config for ONE reason
// that an inline entry cannot express: esbuild's JSX mode sits at the TOP level of a config
// object, outside `test`.
//
// tsconfig.json sets `jsx: "preserve"` because Next must receive untransformed JSX. Vitest
// reads that same tsconfig, so without the override below the transformer hands raw JSX to
// Node and every .tsx suite dies with "Failed to parse source for import analysis … make
// sure to not set jsx to preserve" — a failure that reads like a broken test file rather
// than a compiler-configuration mismatch. `automatic` is the React 19 runtime (no
// `import React` ceremony); it applies to the TEST transform only and changes nothing
// about what Next ships.
//
// THE KEY IS `oxc`, NOT `esbuild` (0.4.0). Vitest 4 transforms with oxc and IGNORES an
// `esbuild` block entirely — it prints "Both esbuild and oxc options were set. oxc options
// will be used and esbuild options will be ignored" and then fails every .tsx suite. This
// file carried the esbuild spelling from 0.1.x until 0.4.0 and nobody found out, because
// `__tests__/` was empty: the config's `include` advertised `*.test.tsx` support that had
// never once been exercised. jsx-transform.test.tsx is the anti-vacuity proof that the
// override is LIVE, and it is the reason this cannot silently rot again on the next major.
//
// environment: 'node', not jsdom. The suites here render through react-dom/server
// (renderToStaticMarkup) — the same server pass the App Router itself performs — so the
// assertions are about the MARKUP the server produces, which is what a Server Component
// actually contributes. That keeps the web unit lane dependency-free (no jsdom, no
// happy-dom, no extra catalog pin) and keeps it honest: a DOM emulator would invite tests
// that assert on behaviour this app deliberately does not run on the client.
// SOURCE: docs/harness/README.md (determinism doctrine: the runner tests what ships)
export default defineConfig({
  oxc: {
    jsx: { runtime: 'automatic', importSource: 'react' },
  },
  test: {
    name: 'web-unit',
    environment: 'node',
    include: ['__tests__/**/*.test.ts', '__tests__/**/*.test.tsx'],
  },
})
