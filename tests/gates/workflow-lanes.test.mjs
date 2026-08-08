// THE HALF OF A VENDOR LANE THAT IS OURS (0.3.0).
//
// The canary registry's CI-lane closure was written against `quality-gate.yml` by name,
// which made the other seven shipped workflows invisible to it: codeql, gitleaks, osv-scan,
// actions-lint, adr-guard, migration-safety and mutation are every one of them a lane a
// reviewer reads as enforcement, and not one had to carry a red-proof. A supply-chain scan
// that cannot go red is decoration exactly the way a gate that cannot go red is — and it
// is the kind nobody re-reads, because its name sounds like it is working.
//
// What a fixture can and cannot prove here has to be stated plainly. It CANNOT prove that
// CodeQL finds an injection or that gitleaks finds a key: that is the vendor's detection,
// running on their runner against their ruleset, and asserting it here would be theatre.
// What it CAN prove is the half this repo owns and the half that has actually failed in the
// wild — the WIRING. A lane neutered by `continue-on-error: true`, disabled by `if: false`,
// or emptied of steps still appears in the checks list, still shows a green tick, and still
// reads to a reviewer as a scan that ran. Those three shapes are the ways a lane silently
// stops being enforcement, and they are all decidable from the file.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const DIR = fileURLToPath(new URL('../../template/base/github/workflows/', import.meta.url))
const FILES = readdirSync(DIR)
  .filter((f) => /\.ya?ml$/.test(f))
  .sort()

/**
 * The jobs of one workflow, sliced by the two-space job headings. YAML-shaped rather than
 * YAML-parsed on purpose: no parser dependency, and the same job-id regex the canary
 * checker itself uses, so the two can never disagree about what a job is.
 * @param {string} text
 * @returns {Array<{ id: string, body: string }>}
 */
function jobsOf(text) {
  const at = text.indexOf('\njobs:')
  if (at === -1) return []
  const region = text.slice(at)
  const heads = [...region.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)]
  return heads.map((m, i) => ({
    id: m[1],
    body: region.slice(m.index, heads[i + 1]?.index ?? region.length),
  }))
}

test('every shipped workflow exposes a parseable jobs: block', () => {
  assert.ok(FILES.length >= 8, `expected the shipped workflow fleet, got ${String(FILES.length)}`)
  for (const f of FILES) {
    assert.ok(jobsOf(readFileSync(join(DIR, f), 'utf8')).length > 0, `${f} exposes no jobs`)
  }
})

test('no shipped lane is neutered by continue-on-error', () => {
  // The quietest way to turn a blocking lane into a suggestion: the job still runs, still
  // reports, and its failure stops mattering.
  for (const f of FILES) {
    for (const job of jobsOf(readFileSync(join(DIR, f), 'utf8'))) {
      assert.ok(
        !/continue-on-error:\s*true/.test(job.body),
        `${f} job '${job.id}' sets continue-on-error: true — the lane runs, reports, and its failure stops mattering. If the lane is genuinely advisory, say so in the registry note; do not leave it looking blocking.`,
      )
    }
  }
})

test('no shipped lane is disabled by a constant-false condition', () => {
  // `if: false` (and its `${{ false }}` spelling) leaves the job in the checks list as
  // "skipped", which `if: always()` fan-ins and human reviewers both read as benign.
  for (const f of FILES) {
    for (const job of jobsOf(readFileSync(join(DIR, f), 'utf8'))) {
      assert.ok(
        !/^\s{4}if:\s*(?:false|\$\{\{\s*false\s*\}\})\s*$/m.test(job.body),
        `${f} job '${job.id}' is disabled by a constant-false condition — it stays in the checks list as a skip, which reads as benign.`,
      )
    }
  }
})

test('every shipped lane actually does something (steps, or a reusable-workflow call)', () => {
  // An emptied job is the third silent-neuter shape: green, instantly, forever.
  for (const f of FILES) {
    for (const job of jobsOf(readFileSync(join(DIR, f), 'utf8'))) {
      const hasWork = /^\s{4}steps:\s*$/m.test(job.body) || /^\s{4}uses:\s*\S/m.test(job.body)
      assert.ok(
        hasWork,
        `${f} job '${job.id}' has neither steps: nor a reusable-workflow uses: — it is green by construction`,
      )
    }
  }
})

test('the pinned scanners are still WIRED into the lanes named for them', () => {
  // Each vendor lane's whole value is the action it runs. Removing the action while
  // keeping the job leaves a check with the scanner's NAME and none of its behaviour —
  // and the check name is all a branch-protection rule ever sees.
  /** @type {Array<[string, string, RegExp]>} */
  const WIRING = [
    ['codeql.yml', 'analyze', /github\/codeql-action\/analyze@/],
    ['gitleaks.yml', 'gitleaks', /gitleaks/i],
    ['osv-scan.yml', 'scan-pr', /osv-scanner/i],
    ['osv-scan.yml', 'scan-full', /osv-scanner/i],
    ['actions-lint.yml', 'actionlint', /actionlint/i],
    ['actions-lint.yml', 'zizmor', /zizmor/i],
    ['migration-safety.yml', 'squawk', /squawk/i],
    ['mutation.yml', 'stryker-full', /stryker|mutation/i],
  ]
  for (const [file, id, needle] of WIRING) {
    const job = jobsOf(readFileSync(join(DIR, file), 'utf8')).find((j) => j.id === id)
    assert.ok(job, `${file} no longer defines the '${id}' job`)
    assert.match(
      job.body,
      needle,
      `${file} job '${id}' no longer invokes the scanner it is named for — the check name survives, the behaviour does not, and a branch-protection rule only ever sees the name`,
    )
  }
})

test('the device-lane paths filter covers the packages the installed app is MADE OF', () => {
  // Not a run of `dorny/paths-filter` — that is vendor code on GitHub's runner, and the
  // header above states why asserting it here would be theatre. What IS decidable from the
  // file is whether the filter enumerates the packages apps/mobile imports. It did not: a
  // change to packages/contracts (imported 27 times by apps/mobile) matched nothing in the
  // `mobile` filter, so both device lanes skipped until the nightly.
  const text = readFileSync(join(DIR, 'quality-gate.yml'), 'utf8')
  const filter = /^ {12}mobile:\n((?: {14}.*\n|\s*#.*\n)*)/m.exec(text)
  assert.ok(filter, "quality-gate.yml no longer defines a 'mobile' paths filter")
  const body = filter[1]

  // Every workspace package apps/mobile declares or imports.
  for (const pkg of [
    'packages/contracts/**',
    'packages/design-tokens/**',
    'packages/platform/errors/**',
    'packages/platform/supabase/**',
    'packages/api/**',
    'packages/verticals/**',
  ]) {
    assert.match(
      body,
      new RegExp(`'${pkg.replace(/[*/]/g, (c) => `\\${c}`)}'`),
      `the mobile paths filter omits ${pkg}, which ships inside the installed app — a change to it would skip both device lanes`,
    )
  }

  // And the one it must NOT contain: dependency-cruiser rule `mobile-not-into-web-only`
  // makes importing the web design system an error, so arming a 120-minute lane on it
  // would be arming it for a package the app may not use.
  assert.doesNotMatch(
    body,
    /'packages\/design-system\/\*\*'/,
    'the mobile paths filter names packages/design-system/**, which apps/mobile is forbidden to import (depcruise `mobile-not-into-web-only`)',
  )
})

test('no lane that builds a PRODUCTION artifact pins NODE_ENV to development (0.6.0)', () => {
  // A LANE THAT CANNOT PASS IS NOT A LANE, and this one could not. The web-e2e job carried
  // `NODE_ENV: development` from the era when Playwright's webServer booted `next dev`. The
  // config later moved to `pnpm run build && pnpm run start` — the CSP suite is why, since
  // `next dev` injects eval and its own overlay scripts and asserts properties of a build
  // nobody ships. Nothing reconciled the two, because this job is path-filtered and nightly
  // and this repository's own CI is selftest.yml, so the shipped job never executed here.
  //
  // `next build` under NODE_ENV=development prerenders the error boundaries against React's
  // development resolution and dies with `Cannot read properties of null (reading
  // 'useContext')` before a single spec runs. Verified by running it: same tree, same env,
  // only that variable differing — exit 1 with it, exit 0 without.
  //
  // Scoped to jobs that BUILD, deliberately. NODE_ENV=development is correct for the Metro
  // and Expo lanes (integration-lane, mobile-e2e), which bundle a development client on
  // purpose — a blanket ban would red two jobs that are right.
  const BUILDS = /\bnext build\b|pnpm run build|playwright test/
  for (const f of FILES) {
    for (const job of jobsOf(readFileSync(join(DIR, f), 'utf8'))) {
      if (!BUILDS.test(job.body)) continue
      assert.doesNotMatch(
        job.body,
        /^\s*NODE_ENV:\s*development\s*$/m,
        `${f} job \`${job.id}\` runs a production build AND pins NODE_ENV: development — \`next build\` fails outright under it, so the lane can never reach its first assertion. Leave NODE_ENV unset and let the toolchain decide.`,
      )
    }
  }
})
