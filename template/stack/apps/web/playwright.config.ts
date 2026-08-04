import { defineConfig, devices } from '@playwright/test'

// The web-e2e browser lane's Playwright config. Deliberately minimal: one Chromium project
// against a Next dev server this file boots. The lane runner (tools/check-web-e2e.mjs, CI
// only) starts the Supabase local stack first, so the landing route's getVerifiedUser()
// resolves (anonymous) rather than erroring, and the NEXT_PUBLIC_* build vars come from the
// job env — they are public by construction (see .env.example block (b)).
//
// This file is owned by the browser toolchain, not the app's tsc/eslint: it is listed in
// eslint.config.mjs `ignores` and is NOT in apps/web/tsconfig `include`. Playwright transpiles
// it (and the specs) with its own esbuild. tools/check-web-e2e.mjs is what holds the lane to a
// non-vacuous, axe-bearing suite before Playwright ever runs.
const isCI = Boolean(process.env.CI)
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: true,
  // CI must never pass because a spec was left focused (.only); the runner already guards
  // an EMPTY suite, forbidOnly guards a narrowed one.
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // A PRODUCTION build, not `next dev`, and the security-headers spec is why.
    //
    // `next dev` serves a different application: HMR injects `eval`, the dev overlay
    // injects its own scripts, and nonce propagation behaves differently because pages
    // are compiled per request. A CSP suite pointed at it asserts properties of a build
    // nobody ships — it reported `script-src blocked eval` for Next's own hot reloader
    // and "Next did not stamp the nonce" for a dev-time render, neither of which says
    // anything about production. Both disappear against `next start`, and a real
    // regression in either would still red.
    //
    // The cost is one `next build` per lane (~10s on this app). That is the price of the
    // suite testing the artifact that gets deployed.
    command: 'pnpm run build && pnpm run start',
    url: BASE_URL,
    reuseExistingServer: !isCI,
    timeout: 180_000,
  },
})
