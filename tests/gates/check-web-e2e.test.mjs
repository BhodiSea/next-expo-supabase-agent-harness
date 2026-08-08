// Can-fail proofs for the web-e2e LANE runner (template/base/tools/check-web-e2e.mjs).
// The runner has a STATIC half (a Playwright config + at least one non-vacuous, axe-bearing
// spec must exist) that runs without an install, and an INSTALL-gated half (it invokes
// `pnpm --filter web exec playwright test`) driven here by a fake `pnpm` on PATH (sh + .cmd
// twins, so the selftest matrix can run this on windows-latest). This is the canary proof
// wired in tests/canary/injections.json#lanes.web-e2e — it must stay green and non-vacuous.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(new URL('../../template/base/tools/check-web-e2e.mjs', import.meta.url))

// Carries ALL THREE closure markers the runner requires of a spec SET: an axe scan, the
// live security-header assertion (0.2.0), and the authenticated-render axis (0.6.0). The
// gate is closed over the set, not per file, so one fixture spec satisfying all three keeps
// the other cases focused on the single rule each is actually testing.
const VALID_SPEC = [
  "import { test, expect } from '@playwright/test'",
  "import AxeBuilder from '@axe-core/playwright'",
  "test('home renders + is accessible', async ({ page }) => {",
  "  const response = await page.goto('/')",
  "  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible()",
  '  const results = await new AxeBuilder({ page }).analyze()',
  '  expect(results.violations).toEqual([])',
  "  expect(response?.headers()['x-content-type-options']).toBe('nosniff')",
  '})',
  "test('csp does not block the page', async ({ page }) => {",
  '  await page.addInitScript(() => {',
  "    document.addEventListener('securitypolicyviolation', () => {})",
  '  })',
  "  await page.goto('/')",
  '  expect(true).toBe(true)',
  '})',
  "test('a session survives a reload', async ({ page }) => {",
  '  await svc.auth.admin.createUser({ email, password, email_confirm: true })',
  "  await page.goto('/sign-in')",
  '  await page.reload()',
  '  expect(true).toBe(true)',
  '})',
  '',
].join('\n')

/** Satisfies axe + security-headers, but nobody ever signs in — the shipped suite's shape. */
const ANONYMOUS_ONLY_SPEC = VALID_SPEC.split("test('a session survives a reload'")[0]

/** A spec that satisfies the axe closure but NOT the security-headers one. */
const AXE_ONLY_SPEC = [
  "import { test, expect } from '@playwright/test'",
  "import AxeBuilder from '@axe-core/playwright'",
  "test('home is accessible', async ({ page }) => {",
  "  await page.goto('/')",
  '  const results = await new AxeBuilder({ page }).analyze()',
  '  expect(results.violations).toEqual([])',
  '})',
  '',
].join('\n')

// Every knob optional; an undefined field means "do not write that file", exactly how a
// scaffold looks before the corresponding piece exists.
/** @param {{ config?: boolean, specs?: Array<{ name: string, content: string }> }} [knobs] */
function fixture({ config = true, specs = [{ name: 'home.spec.ts', content: VALID_SPEC }] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-webe2e-'))
  mkdirSync(join(dir, 'apps/web'), { recursive: true })
  if (config) {
    writeFileSync(
      join(dir, 'apps/web/playwright.config.ts'),
      "import { defineConfig } from '@playwright/test'\nexport default defineConfig({})\n",
    )
  }
  if (specs.length > 0) {
    mkdirSync(join(dir, 'apps/web/e2e'), { recursive: true })
    for (const s of specs) writeFileSync(join(dir, 'apps/web/e2e', s.name), s.content)
  }
  return dir
}

// Arm the install-gated half: node_modules + a fake `pnpm` on PATH that answers the
// `pnpm --filter web exec playwright test` invocation with a controllable exit code.
/** @param {string} dir @param {{ playwrightExit?: number }} [knobs] */
function armInstall(dir, { playwrightExit = 0 } = {}) {
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  const bin = join(dir, 'fakebin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, 'pnpm'),
    [
      '#!/bin/sh',
      'case "$*" in',
      `  *"playwright test"*) exit ${playwrightExit} ;;`,
      'esac',
      'exit 0',
      '',
    ].join('\n'),
  )
  chmodSync(join(bin, 'pnpm'), 0o755)
  writeFileSync(
    join(bin, 'pnpm.cmd'),
    [
      '@echo off',
      'echo %* | findstr /C:"playwright test" >nul',
      `if not errorlevel 1 exit /b ${playwrightExit}`,
      'exit /b 0',
      '',
    ].join('\r\n'),
  )
  return bin
}

const PATH_KEY = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'

/** @param {string} dir @param {{ ci?: boolean, bin?: string }} [opts] */
function runGate(dir, { ci = true, bin } = {}) {
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  delete env.GITHUB_BASE_REF
  if (ci) env.CI = 'true'
  if (bin !== undefined) env[PATH_KEY] = `${bin}${delimiter}${process.env[PATH_KEY] ?? ''}`
  const res = spawnSync('node', [GATE], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

// ── the static half (no node_modules: reds still report, greens skip loudly) ─────

test('RED: no playwright.config reds — a browser lane must configure Playwright', () => {
  const r = runGate(fixture({ config: false }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('has no playwright.config'), r.out)
})

test('RED: no spec reds — an empty browser suite passes vacuously', () => {
  const r = runGate(fixture({ specs: [] }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('no *.spec.'), r.out)
})

test('RED: a spec with no `expect(` reds — an assertion-free spec cannot go red', () => {
  const r = runGate(
    fixture({
      specs: [
        {
          name: 'smoke.spec.ts',
          content: "import { test } from '@playwright/test'\ntest('noop', async () => {})\n",
        },
      ],
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('carries no'), r.out)
})

test('RED: specs present but none runs an axe scan — the a11y net is missing', () => {
  const r = runGate(
    fixture({
      specs: [
        {
          name: 'smoke.spec.ts',
          content:
            "import { test, expect } from '@playwright/test'\ntest('t', async ({ page }) => { await page.goto('/'); await expect(page).toHaveTitle(/./) })\n",
        },
      ],
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('axe scan'), r.out)
})

test('RED (0.2.0): an axe-bearing spec set with no live security-header assertion', () => {
  // tools/check-security-headers.mjs proves the CONFIG is right. A correct config
  // behind a header-stripping CDN, or a nonce that never reaches Next's inline
  // bootstrap, is invisible to it — so the lane must carry the live half or the
  // static gate stands alone believing it has covered the property.
  const r = runGate(fixture({ specs: [{ name: 'a11y.spec.ts', content: AXE_ONLY_SPEC }] }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('securitypolicyviolation'), r.out)
})

test('RED (0.2.0): reading headers WITHOUT collecting violations is not the live half', () => {
  // Both markers required. A spec that asserts headers arrive but never watches the
  // browser enforce the policy cannot tell a working CSP from one that blanks the app.
  const headersOnly = AXE_ONLY_SPEC.replace(
    "  await page.goto('/')",
    "  const response = await page.goto('/')\n  expect(response?.headers()['x-frame-options']).toBe('DENY')",
  )
  const r = runGate(fixture({ specs: [{ name: 'a11y.spec.ts', content: headersOnly }] }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('securitypolicyviolation'), r.out)
})

test('RED (0.6.0): an entirely ANONYMOUS suite — the shape this lane actually shipped in', () => {
  // The defect this axis exists for. Every spec in the seeded suite was anonymous (the one
  // sign-in it performed submitted a WRONG password on purpose), so no test in the whole
  // repository had ever completed a successful sign-in — while the browser client persisted
  // the session to localStorage and every server reader took it from the cookie jar. The
  // lane ran on every PR touching apps/web and was green throughout.
  const r = runGate(
    fixture({ specs: [{ name: 'anonymous.spec.ts', content: ANONYMOUS_ONLY_SPEC }] }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('completed a successful sign-in'), r.out)
  assert.ok(r.out.includes('page.reload()'), r.out)
})

test('RED (0.6.0): signing in without a RELOAD does not close it', () => {
  // replace() + refresh() are client-side; React still holds the signed-in render, so every
  // assertion can pass on a session that lives only in the tab. Only a fresh document
  // request makes the server re-read the cookie — which is the exact step that was broken.
  const noReload = VALID_SPEC.replace('  await page.reload()\n', '')
  const r = runGate(fixture({ specs: [{ name: 'auth.spec.ts', content: noReload }] }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('completed a successful sign-in'), r.out)
})

test('RED (0.6.0): a PLANTED session does not count, however thoroughly it reloads', () => {
  // context.addCookies() with a hand-built session proves the SERVER reads a cookie and says
  // nothing about what the BROWSER writes — and the browser's writer is the half that broke.
  // A spec that plants one is testing the reader twice.
  const planted = VALID_SPEC.replace(
    "  await page.goto('/sign-in')",
    '  await page.context().addCookies([{ name: "sb-x", value: "y", url: "http://localhost" }])',
  )
  const r = runGate(fixture({ specs: [{ name: 'auth.spec.ts', content: planted }] }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('never context.addCookies'), r.out)
})

test('RED (0.6.0): a marker named only in PROSE satisfies nothing', () => {
  // Every axis reads code, not comments. A spec that merely mentions AxeBuilder in a header
  // paragraph has no accessibility net, and the shipped authenticated spec DESCRIBES
  // context.addCookies() in the paragraph explaining why it refuses to use it — so the
  // negative marker has to be read the same way, or the file is disqualified by its own
  // explanation.
  const prose = ANONYMOUS_ONLY_SPEC.replace(
    "import AxeBuilder from '@axe-core/playwright'",
    '// this suite should probably use AxeBuilder from @axe-core/playwright one day',
  ).replace('  const results = await new AxeBuilder({ page }).analyze()', '  const results = []')
  const r = runGate(fixture({ specs: [{ name: 'prose.spec.ts', content: prose }] }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('axe scan'), r.out)

  // And the mirror: a commented-out addCookies does NOT disqualify an otherwise-valid spec.
  const commented = VALID_SPEC.replace(
    "  await page.goto('/sign-in')",
    "  // never: await page.context().addCookies([...])\n  await page.goto('/sign-in')",
  )
  // Run local: with the static half green and no install, the runner SKIPS loudly rather
  // than reaching for a browser — which is the shape that proves no static rule objected.
  const ok = runGate(fixture({ specs: [{ name: 'auth.spec.ts', content: commented }] }), {
    ci: false,
  })
  assert.equal(ok.code, 0, ok.out)
  assert.ok(ok.out.includes('SKIPPED'), ok.out)
})

test('skip asymmetry: a static-green tree without node_modules → loud local SKIP, CI fail-closed', () => {
  const local = runGate(fixture(), { ci: false })
  assert.equal(local.code, 0, local.out)
  assert.ok(local.out.includes('SKIPPED'), local.out)
  assert.ok(local.out.includes('node_modules absent'), local.out)
  const ci = runGate(fixture(), { ci: true })
  assert.equal(ci.code, 1, ci.out)
  assert.ok(ci.out.includes('node_modules absent'), ci.out)
})

test('static red beats the skip: no config + no node_modules reds even locally', () => {
  const r = runGate(fixture({ config: false }), { ci: false })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('has no playwright.config'), r.out)
})

// ── the install-gated half (fake pnpm serves the playwright invocation) ───────────

test('GREEN: a valid config + axe-bearing spec + passing playwright run is green', () => {
  const dir = fixture()
  const bin = armInstall(dir, { playwrightExit: 0 })
  const r = runGate(dir, { bin })
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('playwright browser suite green'), r.out)
})

test('RED: a failing `playwright test` reds naming the command — never a silent half-lane', () => {
  const dir = fixture()
  const bin = armInstall(dir, { playwrightExit: 1 })
  const r = runGate(dir, { bin })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('`playwright test` failed'), r.out)
})
