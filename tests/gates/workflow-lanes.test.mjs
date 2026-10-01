// THE HALF OF A VENDOR LANE THAT IS OURS (0.3.0), over base AND modules (1.0.4, #55).
//
// The canary registry's CI-lane closure was written against `quality-gate.yml` by name,
// which made the other seven shipped workflows invisible to it: codeql, gitleaks, osv-scan,
// actions-lint, adr-guard, migration-safety and mutation are every one of them a lane a
// reviewer reads as enforcement, and not one had to carry a red-proof. A supply-chain scan
// that cannot go red is decoration exactly the way a gate that cannot go red is — and it
// is the kind nobody re-reads, because its name sounds like it is working. Through 1.0.3
// this file still read template/base/ only, so the ten module workflows a consumer enables
// were outside it; the five generic tests below now hold for every shipped workflow, base
// and modules, and only the wiring and paths-filter tests, which name base files, stay base.
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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { baseWorkflows, moduleWorkflows } from '../../scripts/lib/shipped-workflows.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const DIR = join(ROOT, 'template', 'base', 'github', 'workflows')
// Every shipped workflow, labelled with its repo-relative '/'-joined path so a finding names
// its module: template/base/github/workflows/<file> and
// template/modules/<module>/github/workflows/<file>.
const BASE = baseWorkflows(ROOT)
const MODULES = moduleWorkflows(join(ROOT, 'template', 'modules'))
const SHIPPED = [...BASE, ...MODULES]

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

test('every shipped workflow, base and modules, exposes a parseable jobs: block', () => {
  // One floor per tree, so losing either one — a moved directory, a broken walk — is a red,
  // never a vacuous pass over the other tree alone.
  assert.ok(BASE.length >= 9, `expected the base workflow fleet, got ${String(BASE.length)}`)
  assert.ok(MODULES.length >= 10, `expected the module workflow fleet, got ${String(MODULES.length)}`)
  for (const { label, text } of SHIPPED) {
    assert.ok(jobsOf(text).length > 0, `${label} exposes no jobs`)
  }
})

test('no shipped lane is neutered by continue-on-error', () => {
  // The quietest way to turn a blocking lane into a suggestion: the job still runs, still
  // reports, and its failure stops mattering.
  for (const { label, text } of SHIPPED) {
    for (const job of jobsOf(text)) {
      assert.ok(
        !/continue-on-error:\s*true/.test(job.body),
        `${label} job '${job.id}' sets continue-on-error: true — the lane runs, reports, and its failure stops mattering. If the lane is genuinely advisory, say so in the registry note; do not leave it looking blocking.`,
      )
    }
  }
})

test('no shipped lane is disabled by a constant-false condition', () => {
  // `if: false` (and its `${{ false }}` spelling) leaves the job in the checks list as
  // "skipped", which `if: always()` fan-ins and human reviewers both read as benign.
  for (const { label, text } of SHIPPED) {
    for (const job of jobsOf(text)) {
      assert.ok(
        !/^\s{4}if:\s*(?:false|\$\{\{\s*false\s*\}\})\s*$/m.test(job.body),
        `${label} job '${job.id}' is disabled by a constant-false condition — it stays in the checks list as a skip, which reads as benign.`,
      )
    }
  }
})

test('every shipped lane actually does something (steps, or a reusable-workflow call)', () => {
  // An emptied job is the third silent-neuter shape: green, instantly, forever.
  for (const { label, text } of SHIPPED) {
    for (const job of jobsOf(text)) {
      const hasWork = /^\s{4}steps:\s*$/m.test(job.body) || /^\s{4}uses:\s*\S/m.test(job.body)
      assert.ok(
        hasWork,
        `${label} job '${job.id}' has neither steps: nor a reusable-workflow uses: — it is green by construction`,
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

test('a surface deferral skips ONLY mobile-e2e and perf-lane, and only on a pull request (1.1.0, #56)', () => {
  // tools/surfaces.json lets a web-first project defer its mobile surface. Its reach is the
  // guard: the clause sits in the pull_request arm of the two device lanes and nowhere
  // else, so scheduled and dispatched runs keep both lanes, and `native`, the static and
  // unit lanes and every other job ignore the register. The clause tests `!= 'true'`, so a
  // missing output (a failed step, an older workflow) runs the lanes.
  const text = readFileSync(join(DIR, 'quality-gate.yml'), 'utf8')
  const jobs = jobsOf(text)
  const ifOf = (/** @type {string} */ body) => /^ {4}if: >-\n((?: {6}.*\n)+)/m.exec(body)?.[1] ?? ''
  const ARM =
    "       (github.event_name == 'pull_request' && needs.changes.outputs.mobile == 'true' &&\n" +
    "        needs.changes.outputs.mobile-deferred != 'true'))\n"
  for (const id of ['mobile-e2e', 'perf-lane']) {
    const job = jobs.find((j) => j.id === id)
    assert.ok(job, `quality-gate.yml no longer defines '${id}'`)
    const cond = ifOf(job.body)
    assert.ok(
      cond.endsWith(ARM),
      `${id}'s if: must end with the pull_request arm that reads the deferral:\n${cond}`,
    )
    // The schedule/dispatch arm is untouched, and the deferral is read exactly once.
    assert.match(cond, /\(github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch' \|\|\n/)
    assert.equal(cond.split('mobile-deferred').length - 1, 1, `${id}: ${cond}`)
    assert.ok(
      cond.indexOf('mobile-deferred') > cond.indexOf("github.event_name == 'pull_request'"),
      `${id}: the deferral must sit inside the pull_request arm:\n${cond}`,
    )
    // Nothing else in the job reads it: a step-level skip would be the same hole, smaller.
    assert.equal(job.body.split('mobile-deferred').length - 1, 1, `${id} reads mobile-deferred outside its if:`)
  }

  // No other job in any shipped workflow gates on it. The `changes` job PUBLISHES it, and
  // gate-summary receives it only through toJSON(needs), for display.
  for (const { label, text: wf } of SHIPPED) {
    for (const job of jobsOf(wf)) {
      if (label.endsWith('/quality-gate.yml') && ['mobile-e2e', 'perf-lane', 'changes'].includes(job.id)) continue
      assert.doesNotMatch(
        job.body,
        /mobile-deferr/,
        `${label} job '${job.id}' reads the surface deferral — only mobile-e2e and perf-lane may, and only on a pull request`,
      )
    }
  }
})

test('the `changes` job publishes the deferral from the CLI, and never interpolates the reason into a script (#56)', () => {
  const text = readFileSync(join(DIR, 'quality-gate.yml'), 'utf8')
  const job = jobsOf(text).find((j) => j.id === 'changes')
  assert.ok(job, "quality-gate.yml no longer defines 'changes'")
  assert.match(job.body, /^ {6}mobile-deferred: \$\{\{ steps\.surfaces\.outputs\.mobile-deferred \}\}$/m)
  assert.match(job.body, /^ {6}mobile-deferral: \$\{\{ steps\.surfaces\.outputs\.mobile-deferral \}\}$/m)
  assert.match(job.body, /^ {8}id: surfaces\n {8}run: node tools\/ci\/surface-deferral\.mjs --mode=pr >> "\$GITHUB_OUTPUT"$/m)
  // The CLI reads the tree, so the job checks it out, after the paths filter it already ran.
  const filterAt = job.body.indexOf('dorny/paths-filter@')
  const checkoutAt = job.body.indexOf('actions/checkout@')
  assert.ok(filterAt !== -1 && checkoutAt > filterAt, 'checkout must follow the paths-filter step')
  assert.match(job.body.slice(checkoutAt), /persist-credentials: false/)
  // The reason is the pull request's own text. It reaches a script only through an env
  // var, never through ${{ }} inside a run: line, in this or any shipped workflow.
  for (const { label, text: wf } of SHIPPED) {
    for (const line of wf.split('\n')) {
      if (!/\$\{\{[^}]*mobile-deferral/.test(line)) continue
      assert.match(
        line,
        /^ {6}mobile-deferral: \$\{\{ steps\.surfaces\.outputs\.mobile-deferral \}\}$/,
        `${label}: the deferral's reason is interpolated outside the job's outputs: ${line.trim()}`,
      )
    }
  }
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
  for (const { label, text } of SHIPPED) {
    for (const job of jobsOf(text)) {
      if (!BUILDS.test(job.body)) continue
      assert.doesNotMatch(
        job.body,
        /^\s*NODE_ENV:\s*development\s*$/m,
        `${label} job \`${job.id}\` runs a production build AND pins NODE_ENV: development — \`next build\` fails outright under it, so the lane can never reach its first assertion. Leave NODE_ENV unset and let the toolchain decide.`,
      )
    }
  }
})
