#!/usr/bin/env node
// Lane runner: web-e2e — the browser lane's closure + invocation. NOT a chain gate.
// It needs a real browser, so it runs in the path-filtered `web-e2e` CI job, never the
// Stop chain — the web analog of check-e2e-device.mjs for the mobile device lane. Its
// value over a bare `playwright test` is that Playwright exits 0 on an EMPTY run, so a
// consumer who deletes every spec would get a silently-green lane; this runner fails
// closed on that (and on a spec with no assertion, no accessibility scan, or an
// accessibility scan narrowed below the reviewed tag ladder) BEFORE handing off to the
// browser.
//   1. apps/web ships a Playwright config and at least one *.spec.* — a browser lane
//      with no spec is vacuous.
//   2. Non-vacuity: every spec carries a real `expect(`, and at least one spec runs an
//      axe scan (@axe-core/playwright / AxeBuilder) — the a11y net must actually exist,
//      not just the smoke test.
//   2b. Every EXPLICITLY TAGGED axe scan carries the full reviewed ladder (0.10.0,
//      ramped to 0.11.0). `withTags` narrows axe, so a short list is a decision not to
//      run the rules outside it — and it is a decision nothing read until this axis
//      existed. Untagged scans are exempt on purpose: they run a BROADER set.
//   3. Then `pnpm --filter web exec playwright test` — a failing browser assertion or an
//      axe violation reds the lane.
// Skip-local / fail-closed-CI: without an install (browsers absent) this SKIPS loudly
// locally and FAILS CLOSED in CI, exactly like every toolchain-dependent gate.
// SOURCE: docs/harness/gates-catalog.md (web-e2e lane)
import { existsSync, readFileSync } from 'node:fs'
import { walkFiles } from './lib/fs-walk.mjs'
import { commandFailureOutput, failures, ok, rampNote, runCmd, skipOrFail } from './lib/gate.mjs'
import { blankComments } from './lib/source-text.mjs'

const GATE = 'web-e2e'
const APP = 'apps/web'
const E2E_DIR = `${APP}/e2e`
const errs = []
// Findings the 0.6.0 ramp holds as NOTEs on an install that predates the axis.
const notes = []

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
// (2c) AT LEAST ONE SPEC MUST SIGN SOMEBODY IN AND THEN RELOAD.
//
// The axis the harness lacked for two releases, and the one that would have caught the
// seeded app shipping a SIGN-IN LOOP. Every spec in the shipped suite was anonymous — the
// only sign-in in the whole directory submitted a deliberately WRONG password — so no test
// in the repository had ever completed a successful sign-in, and the lane ran green on
// every PR touching apps/web while the app could not sign anybody in at all. The browser
// client was constructed with no `storage`, supabase-js persisted the session to
// localStorage, and every server reader took it from the cookie jar.
//
// Two positive markers and one negative, each encoding one half of that defect:
//   * A REAL IDENTITY (`auth.admin.createUser` / `auth.signUp` / `admin.generateLink`), so
//     the flow being exercised is the credential path and not a stub.
//   * A FULL RELOAD (`.reload()`), because a client-side navigation renders from state the
//     tab already holds. Only a fresh document request makes the server re-read the cookie.
//   * NOT `addCookies(` in that same spec — a planted session proves the SERVER reads a
//     cookie and says nothing about what the BROWSER writes, which is the half that broke.
//
// THE HONEST LIMIT: this is a proxy. A static reader cannot tell that the assertion AFTER
// the reload is about a protected route, so a spec could satisfy all three markers and still
// prove little. What it does close is the failure that actually happened — a suite drifting
// back to anonymous-only while `docs/harness/enforcement-tiers.md` names this lane as the
// compensating control on nine rows.
const IDENTITY = /auth\.admin\.createUser|auth\.signUp|admin\.generateLink/
const RELOAD = /\.reload\s*\(/
const PLANTED = /\.addCookies\s*\(/

// The tag ladder every EXPLICITLY TAGGED axe scan must carry (0.10.0). Measured against
// axe-core 4.13.0's own rule table rather than recalled, because three of the obvious
// spellings are wrong in ways that read as working:
//   wcag22a  — selects ZERO rules, and axe's unknown-tag warning is suppressed by its
//              own whitelist regex, so it would pass review, run green and check nothing.
//   wcag21a  — its ONLY rule (label-content-name-mismatch) carries `experimental`, and
//              axe's default tagExclude is ["experimental","deprecated"], so the tag can
//              run on no DOM at all under the shipped configuration.
//   wcag22aa — adds exactly ONE rule, target-size. That single rule IS the whole of axe's
//              automated WCAG 2.2 AA surface: 2.4.11, 3.2.6, 3.3.7 and 3.3.8 have no
//              automated rule of any kind, which is why no document here claims the level.
// So the honest ladder is four tags selecting three more rules than the 2.0 pair did:
// autocomplete-valid, avoid-inline-spacing (both wcag21aa) and target-size.
const REQUIRED_AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']
const TAGGED_SCAN = /withTags\s*\(/

let anyAxe = false
let anySecurityHeaders = false
let anyAuthenticated = false
/** specs that pass an explicit tag list, and which required tags each one omits */
const tagGaps = []
for (const spec of specs) {
  // COMMENTS BLANKED FIRST, for every axis below. A marker named only in prose must not
  // satisfy a requirement, and a construct that has been commented out must not create a
  // phantom one — this file's own authenticated spec DESCRIBES `context.addCookies()` in
  // the paragraph explaining why it refuses to use it, and was disqualified by its own
  // explanation until this line existed. Blanking can only make the reader stricter.
  const text = blankComments(readFileSync(spec, 'utf8'))
  if (!/\bexpect\s*\(/.test(text)) {
    errs.push(`${spec} carries no \`expect(\` — a spec with no assertion cannot go red`)
  }
  if (IDENTITY.test(text) && RELOAD.test(text) && !PLANTED.test(text)) anyAuthenticated = true
  if (/@axe-core\/playwright|AxeBuilder/.test(text)) {
    anyAxe = true
    // JUDGED ONLY WHEN THE SPEC PASSES AN EXPLICIT TAG LIST, and that exemption is the
    // whole correctness of this check rather than a softening of it. `withTags` NARROWS
    // axe to the named tags; a bare `new AxeBuilder({ page }).analyze()` runs every
    // enabled, non-experimental rule — a BROADER scan than this ladder. Demanding tags
    // there would red the stricter spec and its only accepted remediation would be to
    // shrink the scan, which is the opposite of what this exists for.
    if (TAGGED_SCAN.test(text)) {
      const missing = REQUIRED_AXE_TAGS.filter(
        (t) => !text.includes(`'${t}'`) && !text.includes(`"${t}"`),
      )
      if (missing.length > 0) tagGaps.push({ spec, missing })
    }
  }
  // The live half of the security-headers gate. Both markers required: reading
  // response.headers() proves the headers arrive, and collecting
  // securitypolicyviolation proves the CSP does not blank the app it protects. A
  // spec that asserts only the first ships a policy nobody has watched run.
  if (/response\??\.headers\(\)/.test(text) && /securitypolicyviolation/.test(text)) {
    anySecurityHeaders = true
  }
}
if (specs.length > 0 && !anyAxe) {
  errs.push(
    `no spec under ${E2E_DIR} runs an axe scan (@axe-core/playwright / AxeBuilder) — the accessibility net must exist, not just the smoke test`,
  )
}
if (tagGaps.length > 0) {
  // RAMPED to 0.11.0, and for the channel reason rather than a soft one. This RUNNER is
  // harness-OWNED, so `update` arms the demand on every install at once; the specs it
  // judges are SEEDED, so `update` cannot rewrite them and an upgrading consumer would
  // meet a hard-red lane on files they never touched. Same shape as the 0.6.0 axis above,
  // and the same remedy: the correction travels as a seededSourceFixes instruction while
  // the NOTE names it. A fresh scaffold is seeded with the widened specs and is held to
  // the rule immediately, because rampNote is inert when baseVersion >= minVersion.
  const ramped = rampNote(
    GATE,
    '0.10.0',
    `the axe tag ladder (a tagged scan omitting ${REQUIRED_AXE_TAGS.join('/')}) — the seeded specs carry the widened set, but update cannot rewrite an existing install's`,
    { until: '0.11.0' },
  )
  const bucket = ramped ? notes : errs
  for (const { spec, missing } of tagGaps) {
    bucket.push(
      `${spec} runs a TAGGED axe scan that omits ${missing.map((t) => `'${t}'`).join(', ')} — a tag list is a NARROWING, so every rule outside it is one this suite has decided not to run. ` +
        `Add the missing tag(s) to the withTags([...]) call. What they buy, stated exactly so nobody reads more into it than is there: ` +
        `'wcag21aa' arms autocomplete-valid and avoid-inline-spacing, 'wcag22aa' arms target-size, and target-size is the ONLY automated WCAG 2.2 AA rule axe has. ` +
        `On the routes this template seeds none of the three can currently produce a finding — no element carries an autocomplete attribute, React cannot emit '!important' from a style object, and every control clears 24px via the 44px touch token — so this ARMS the rules for the routes you add, and does not newly check the ones shipped here.`,
    )
  }
}
if (specs.length > 0 && !anyAuthenticated) {
  // RAMPED to 0.7.0, and the reason is a consequence of getting the seeding right rather
  // than softness about the rule. The seeded `authenticated.spec.ts` is registered
  // seedOnInitOnly, because its assertions name THIS scaffold's routes and test ids — a
  // consumer who has renamed a route would be handed a spec that reds about their own app.
  // So an install that upgrades into 0.6.0 gets the AXIS without the SPEC, and the honest
  // answer to "you must write one, against your own routes" is a release to write it in.
  // A fresh scaffold is seeded with the spec at init and is held to the rule immediately.
  const ramped = rampNote(
    GATE,
    '0.6.0',
    "the authenticated-render axis (no spec completes a real sign-in) — the seeded spec is withheld from existing installs because its assertions name this template's routes",
    { until: '0.7.0' },
  )
  const bucket = ramped ? notes : errs
  bucket.push(
    `no spec under ${E2E_DIR} mints a real identity AND reloads the page without planting a cookie — so nothing in this lane has ever completed a successful sign-in. That is the exact shape the seeded web app shipped in for two releases: the browser persisted the session to localStorage while every server reader took it from the cookie jar, sign-in "succeeded", and the protected layout redirected straight back to /sign-in. An anonymous suite cannot see it, and docs/harness/enforcement-tiers.md names this lane as the compensating control on nine rows that assume it can. Add a spec that signs in THROUGH THE FORM (never context.addCookies — a planted session proves only that the server reads a cookie) and then calls page.reload(), so the server has to re-read what the browser wrote.`,
  )
}
if (specs.length > 0 && !anySecurityHeaders) {
  errs.push(
    `no spec under ${E2E_DIR} reads response.headers() AND collects securitypolicyviolation — tools/check-security-headers.mjs proves the CONFIG is right, and a correct config behind a header-stripping CDN or a broken nonce propagation looks identical to it. The live assertion is the only thing that can tell them apart.`,
  )
}

// Ramped findings print BEFORE either exit path, so a NOTE is never lost to a skip. A ramp
// whose text only appears on the run that also fails is a ramp nobody reads.
for (const n of notes) console.log(`${GATE}: NOTE — ${n}`)

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
    `\`playwright test\` failed in ${APP} — a browser assertion or an axe violation reds the lane: ${commandFailureOutput(
      e,
    ).slice(0, 300)}`,
  ])
}

ok(GATE, `playwright browser suite green (${specs.length} spec file(s); an axe scan is present)`)
