#!/usr/bin/env node
// Lane runner: web-e2e — the browser lane's closure + invocation. NOT a chain gate.
// It needs a real browser, so it runs in the path-filtered `web-e2e` CI job, never the
// Stop chain — the web analog of check-e2e-device.mjs for the mobile device lane. Its
// value over a bare `playwright test` is that Playwright exits 0 on an EMPTY run, so a
// consumer who deletes every spec would get a silently-green lane; this runner fails
// closed on that (and on a spec with no assertion, or no accessibility scan) BEFORE
// handing off to the browser.
//   1. apps/web ships a Playwright config and at least one *.spec.* — a browser lane
//      with no spec is vacuous.
//   2. Non-vacuity: every spec carries a real `expect(`, and at least one spec runs an
//      axe scan (@axe-core/playwright / AxeBuilder) — the a11y net must actually exist,
//      not just the smoke test.
//   3. Then `pnpm --filter web exec playwright test` — a failing browser assertion or an
//      axe violation reds the lane.
// Skip-local / fail-closed-CI: without an install (browsers absent) this SKIPS loudly
// locally and FAILS CLOSED in CI, exactly like every toolchain-dependent gate.
// SOURCE: docs/harness/gates-catalog.md (web-e2e lane)
import { existsSync, readFileSync } from 'node:fs'
import { walkFiles } from './lib/fs-walk.mjs'
import { failures, ok, runCmd, skipOrFail } from './lib/gate.mjs'

const GATE = 'web-e2e'
const APP = 'apps/web'
const E2E_DIR = `${APP}/e2e`
const errs = []

if (!existsSync(APP)) skipOrFail(GATE, `no ${APP} — this lineage's web surface is absent`)

// (1) A Playwright config must exist.
const CONFIG_CANDIDATES = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs']
if (!CONFIG_CANDIDATES.some((c) => existsSync(`${APP}/${c}`))) {
  errs.push(
    `${APP} has no playwright.config.* — a web app claiming a browser lane must configure Playwright`,
  )
}

// (1)+(2) At least one spec, each with a real assertion, and an axe scan somewhere.
const specs = existsSync(E2E_DIR)
  ? [...walkFiles(E2E_DIR)]
      .filter((rel) => /\.spec\.(ts|tsx|js|mjs)$/.test(rel))
      .map((rel) => `${E2E_DIR}/${rel}`)
  : []
if (specs.length === 0) {
  errs.push(
    `no *.spec.* under ${E2E_DIR} — a browser lane with no spec passes vacuously (playwright exits 0 on an empty run); add at least one`,
  )
}
let anyAxe = false
for (const spec of specs) {
  const text = readFileSync(spec, 'utf8')
  if (!/\bexpect\s*\(/.test(text)) {
    errs.push(`${spec} carries no \`expect(\` — a spec with no assertion cannot go red`)
  }
  if (/@axe-core\/playwright|AxeBuilder/.test(text)) anyAxe = true
}
if (specs.length > 0 && !anyAxe) {
  errs.push(
    `no spec under ${E2E_DIR} runs an axe scan (@axe-core/playwright / AxeBuilder) — the accessibility net must exist, not just the smoke test`,
  )
}

// The static closure above ran; report its reds before the install-gated browser run.
if (!existsSync('node_modules')) {
  failures(GATE, errs)
  skipOrFail(
    GATE,
    `node_modules absent — cannot run \`playwright test\` (run \`pnpm install\` then \`pnpm --filter web exec playwright install --with-deps chromium\`)`,
  )
}

failures(GATE, errs)

// (3) The browser suite itself. Streamed, not captured — Playwright's own reporter is the
// detail surface; a non-zero exit is the red.
try {
  runCmd('pnpm --filter web exec playwright test', { stdio: ['ignore', 'inherit', 'inherit'] })
} catch (e) {
  failures(GATE, [
    `\`playwright test\` failed in ${APP} — a browser assertion or an axe violation reds the lane: ${(
      e.stderr?.toString() ?? e.message
    ).slice(0, 300)}`,
  ])
}

ok(GATE, `playwright browser suite green (${specs.length} spec file(s); an axe scan is present)`)
