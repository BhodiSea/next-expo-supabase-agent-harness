// Can-fail proofs for the web-e2e LANE runner (template/base/tools/check-web-e2e.mjs).
// The runner has a STATIC half (a Playwright config + at least one non-vacuous, axe-bearing
// spec must exist) that runs without an install, and an INSTALL-gated half (it invokes
// `pnpm --filter web exec playwright test`) driven here by a fake `pnpm` on PATH (sh + .cmd
// twins, so the selftest matrix can run this on windows-latest). This is the canary proof
// wired in tests/canary/injections.json#lanes.web-e2e — it must stay green and non-vacuous.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(new URL('../../template/base/tools/check-web-e2e.mjs', import.meta.url))

const VALID_SPEC = [
  "import { test, expect } from '@playwright/test'",
  "import AxeBuilder from '@axe-core/playwright'",
  "test('home renders + is accessible', async ({ page }) => {",
  "  await page.goto('/')",
  "  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible()",
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
