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
    // HARNESS-AUTHORED (1.1.0, #73): the job is named for the gate script it runs.
    ['actions-lint.yml', 'workflow-hardening', /check-workflow-hardening\.mjs/],
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

test('a lane that runs `next build` from a fresh checkout builds the workspace declarations first (1.1.0)', () => {
  // THE SAME DEFECT CLASS AS THE NODE_ENV TEST ABOVE, found the same way: by running the
  // build, not by reading the job (#77). apps/web's tsconfig REFERENCES the composite
  // workspace packages, and Next's own type check (the "Running TypeScript" phase of `next
  // build`) reads each reference's EMITTED declarations — which `tsc -b` writes and a fresh
  // checkout does not have. So `pnpm --filter web build` straight after `pnpm install` fails
  // with TS6305 ("Output file '…/dist/index.d.ts' has not been built from source file") on
  // every import of an @app/* package, and the lane never reaches its purity scan or its
  // first browser assertion. Measured on a zero-edit scaffold: red without, green with.
  //
  // The chain's web-compile step needs no such step: it runs after `types`, whose `tsc -b`
  // writes them. A CI job that builds on its own has no `types` before it.
  //
  // BASE workflows only, and the one module job this leaves out is named rather than
  // excused: ci-web-deploy's attest-web builds with `pnpm --filter web run build` and has
  // the same TS6305 gap, and it also publishes only the NEXT_PUBLIC_* half of the env the
  // build parses (quality-gate.yml's web-build step records the server half failing
  // `Collecting page data`). Fixing one without the other would not make that lane pass, so
  // both are left to that module's own change rather than half-fixed here.
  const BUILDS_WEB = /pnpm --filter web (?:run )?build\b|node tools\/check-web-e2e\.mjs/
  const DECLARATIONS = /^\s*run: pnpm exec tsc -b (?:apps\/web|\.)/m
  const lanes = []
  for (const { label, text } of BASE) {
    for (const job of jobsOf(text)) {
      const build = BUILDS_WEB.exec(job.body)
      if (build === null) continue
      lanes.push(job.id)
      const tsc = DECLARATIONS.exec(job.body)
      assert.ok(
        tsc !== null && tsc.index < build.index,
        `${label} job \`${job.id}\` builds the web app from a fresh checkout without running \`pnpm exec tsc -b apps/web\` first — Next's type check then fails with TS6305 on every @app/* import, so the lane can never pass.`,
      )
    }
  }
  assert.deepEqual(lanes.sort(), ['web-build', 'web-e2e'], 'the two shipped lanes that build the web app')
})

// ── POST-MERGE LANE REUSE (1.1.0, #57) ──────────────────────────────────────────────────────
//
// Six lanes of the merge gate run on `pull_request` AND on the `push` its merge produces, and
// an up-to-date squash merge re-ran them on the tree the pull request run had just proved. On
// a push they now first ask tools/ci/lane-reuse.mjs whether that exact tree already passed
// that exact lane in the merged pull request's run, and skip their steps on a hit. The judge
// is proven in tests/gates/lane-reuse.test.mjs; what makes it SAFE is the wiring, and every
// rule of the wiring is decidable from the file:
//   - the lookup is the first step after checkout, on push only, and asks about the job's own
//     `name:` (the jobs API is matched by name, so a wrong --job reads another lane's proof);
//   - every later step carries the reuse condition as a conjunct, so no step runs half a lane
//     on a hit — except the hit report and the record step;
//   - the record step is LAST and runs only on pull requests, so it prints its marker only
//     when every step before it passed;
//   - no job-level `if:` (live-controls reads only a job-level `if:`, and one here would
//     turn these lanes conditional and change what docs-sync concludes for every install);
//   - the job's permissions are exactly contents/actions/pull-requests read (a job-level
//     block sets every scope it does not name to none);
//   - the job exposes reused-from for gate-summary, and no other job calls the script.
// Each rule is shown red on a synthetic negative, following workflow-hardening.test.mjs.

const REUSE_LANES = ['static', 'unit', 'mutation', 'runtime-rls', 'e2e-fast', 'integration-lane']
const REUSE_SCRIPT = 'tools/ci/lane-reuse.mjs'
const REUSE_CLAUSE = "steps.reuse.outputs.hit != 'true'"
const HIT_IF = "steps.reuse.outputs.hit == 'true'"
const REUSE_PERMISSIONS = { actions: 'read', contents: 'read', 'pull-requests': 'read' }

/**
 * The value of one key at a given indent inside a block, unquoted of nothing: the raw text
 * after `key: `. A folded (`>-`) value is returned as its marker; none of the reuse steps
 * uses one, and a rule comparing such a value against an expected string reds.
 * @param {string} block @param {number} indent @param {string} key
 */
function keyAt(block, indent, key) {
  const m = new RegExp(`^ {${String(indent)}}${key}:[ \\t]*(.*)$`, 'm').exec(block)
  return m ? m[1].trim() : null
}

/** The `key: value` children of a 4-space job key (`permissions:`, `outputs:`). */
function childrenOf(body, key) {
  const m = new RegExp(`^ {4}${key}:[ \\t]*\\n((?: {6}\\S.*\\n?)+)`, 'm').exec(body)
  if (!m) return null
  return Object.fromEntries(
    // A trailing ` # why` comment is documentation (zizmor asks for one per permission).
    [...m[1].matchAll(/^ {6}([\w-]+):[ \t]*(.*)$/gm)].map((e) => [e[1], e[2].replace(/\s+#.*$/, '').trim()]),
  )
}

/**
 * The steps of one job, each as its own text plus the keys the rules read. A step starts at a
 * `      - ` line; its keys sit at eight spaces (or on the dash line itself).
 * @param {string} body
 */
function stepsOf(body) {
  const at = body.search(/^ {4}steps:\s*$/m)
  if (at === -1) return []
  const region = body.slice(at)
  const heads = [...region.matchAll(/^ {6}- /gm)]
  return heads.map((m, i) => {
    const text = region.slice(m.index, heads[i + 1]?.index ?? region.length)
    const block = text.replace(/^ {6}- /, '        ')
    const env = /^ {8}env:[ \t]*\n((?: {10}\S.*\n?)+)/m.exec(block)
    return {
      text,
      name: keyAt(block, 8, 'name'),
      uses: keyAt(block, 8, 'uses'),
      id: keyAt(block, 8, 'id'),
      if: keyAt(block, 8, 'if'),
      run: keyAt(block, 8, 'run'),
      env: Object.fromEntries(
        [...(env?.[1] ?? '').matchAll(/^ {10}([A-Z_]+):[ \t]*(.*)$/gm)].map((e) => [e[1], e[2].trim()]),
      ),
    }
  })
}

/** Is the reuse condition a top-level conjunct of this `if:`? `||` anywhere fails it. */
function carriesReuseClause(cond) {
  if (cond === null || cond.includes('||')) return false
  return cond.split('&&').some((part) => part.trim() === REUSE_CLAUSE)
}

/** The lookup and record step shapes for one job. @param {string} label @param {string} name */
function lookupProblems(label, name, lookup) {
  const problems = []
  if (lookup?.id !== 'reuse') problems.push(`${label}: the first step after checkout is not the reuse lookup (id: reuse)`)
  if (lookup?.if !== "github.event_name == 'push'") problems.push(`${label}: the lookup must run on push only`)
  if (lookup?.run !== `node ${REUSE_SCRIPT} --job "${name}"`) problems.push(`${label}: the lookup's --job must equal the job's name: (${name})`)
  if (lookup?.env.GH_TOKEN !== '${{ github.token }}') problems.push(`${label}: the lookup must take GH_TOKEN from github.token in env:`)
  return problems
}

/** @param {string} label @param {string} name */
function recordProblems(label, name, record, tag) {
  const problems = []
  if (record?.if !== "github.event_name == 'pull_request'") problems.push(`${label}: the last step must be the record, on pull_request only`)
  if (record?.run !== `node ${REUSE_SCRIPT} --record --job "${name}"`) problems.push(`${label}: the record step's --job must equal the job's name: (${name})`)
  if (record?.env.PR_HEAD_SHA !== '${{ github.event.pull_request.head.sha }}') problems.push(`${label}: the record must take PR_HEAD_SHA from the event in env:`)
  if (record?.text.includes(tag)) problems.push(`${label}: the record step's text carries the marker itself — the script builds it, so the log's echo of the command is never a second marker`)
  return problems
}

/** The job-level rules. @param {string} label @param {string} body */
function jobLevelProblems(label, body) {
  const problems = []
  if (/^ {4}if:/m.test(body)) problems.push(`${label}: a job-level if: — live-controls would read this lane as conditional`)
  const perms = childrenOf(body, 'permissions')
  if (JSON.stringify(Object.entries(perms ?? {}).sort()) !== JSON.stringify(Object.entries(REUSE_PERMISSIONS).sort())) {
    problems.push(`${label}: permissions must be exactly contents, actions and pull-requests read, got ${JSON.stringify(perms)}`)
  }
  if (childrenOf(body, 'outputs')?.['reused-from'] !== '${{ steps.reuse.outputs.from }}') {
    problems.push(`${label}: the job must expose outputs.reused-from from the lookup`)
  }
  return problems
}

/** Every later step: the conjunct, one hit report, and the script called nowhere else. */
function laterStepProblems(label, later) {
  const problems = []
  const reports = later.filter((s) => s.if === HIT_IF)
  if (reports.length !== 1) problems.push(`${label}: expected exactly one hit report (if: ${HIT_IF}), found ${String(reports.length)}`)
  for (const s of reports) {
    if (s.env.REUSED_FROM !== '${{ steps.reuse.outputs.from }}' || !s.text.includes('GITHUB_STEP_SUMMARY')) {
      problems.push(`${label}: the hit report must name the run (REUSED_FROM from the lookup) in the log and in $GITHUB_STEP_SUMMARY`)
    }
  }
  for (const s of later.slice(0, -1)) {
    if (s.if === HIT_IF) continue
    if (!carriesReuseClause(s.if)) problems.push(`${label}: step '${s.name ?? s.uses}' lacks the condition ${REUSE_CLAUSE} (joined with &&)`)
    if (s.text.includes(REUSE_SCRIPT)) problems.push(`${label}: step '${s.name ?? s.uses}' calls ${REUSE_SCRIPT} outside the lookup and the record`)
  }
  return problems
}

/**
 * Everything wrong with the reuse wiring of one workflow, as sentences. Pure, so the synthetic
 * negatives below can show each rule going red.
 * @param {string} text @param {string[]} [lanes] @param {string} [tag] the marker tag
 * @returns {string[]}
 */
function reuseProblems(text, lanes = REUSE_LANES, tag = '[lane-reuse] RECORD') {
  const problems = []
  const jobs = jobsOf(text)
  for (const id of lanes) {
    const found = jobs.find((j) => j.id === id)
    if (!found) {
      problems.push(`${id}: no such job`)
      continue
    }
    const label = `quality-gate.yml#${id}`
    const name = keyAt(found.body, 4, 'name') ?? ''
    const steps = stepsOf(found.body)
    const checkout = steps.findIndex((s) => s.uses?.startsWith('actions/checkout@'))
    const later = steps.slice(checkout + 2)
    problems.push(
      ...jobLevelProblems(label, found.body),
      ...lookupProblems(label, name, checkout === -1 ? undefined : steps[checkout + 1]),
      ...laterStepProblems(label, later),
      ...recordProblems(label, name, later.at(-1), tag),
    )
  }
  for (const j of jobs) {
    if (!lanes.includes(j.id) && j.body.includes(REUSE_SCRIPT)) problems.push(`quality-gate.yml#${j.id}: calls ${REUSE_SCRIPT} but is not a reuse lane`)
  }
  return problems
}

test('the merge gate wires post-merge reuse into exactly the six unconditional lanes (#57)', async () => {
  const { MARKER_TAG } = await import('../../template/base/tools/lib/lane-reuse.mjs')
  const text = readFileSync(join(DIR, 'quality-gate.yml'), 'utf8')
  assert.deepEqual(reuseProblems(text, REUSE_LANES, MARKER_TAG), [])
  // No other shipped workflow, base or module, calls the script.
  for (const { label, text: other } of SHIPPED) {
    if (label.endsWith('/base/github/workflows/quality-gate.yml')) continue
    assert.ok(!other.includes(REUSE_SCRIPT), `${label} calls ${REUSE_SCRIPT}: only the merge gate's six lanes may`)
  }
})

test('liveControls() reports none of the six reuse lanes as conditional', async () => {
  const { liveControls } = await import('../../template/base/tools/lib/live-controls.mjs')
  const { conditional } = liveControls({ steps: [], workflowDir: DIR })
  for (const lane of REUSE_LANES) {
    assert.equal(conditional.has(lane), false, `${lane} reads as conditional — docs-sync's tier verdict would change for every install`)
  }
})

test('each reuse-wiring rule can go red: the synthetic negatives', () => {
  const lane = ({ jobIf = '', perms = ['contents', 'actions', 'pull-requests'], outputs = true, steps }) =>
    [
      'name: x',
      '',
      'jobs:',
      '  static:',
      '    name: static (validate floor)',
      '    runs-on: ubuntu-latest',
      '    timeout-minutes: 10',
      ...(jobIf ? [`    if: ${jobIf}`] : []),
      '    permissions:',
      ...perms.map((p) => `      ${p}: read`),
      ...(outputs ? ['    outputs:', '      reused-from: ${{ steps.reuse.outputs.from }}'] : []),
      '    steps:',
      ...steps,
      '  other:',
      '    runs-on: ubuntu-latest',
      '    timeout-minutes: 10',
      '    steps:',
      '      - run: echo other',
      '',
    ].join('\n')
  const S = {
    harden: ['      - name: Harden runner', '        uses: step-security/harden-runner@0000000000000000000000000000000000000000 # v2'],
    checkout: ['      - uses: actions/checkout@0000000000000000000000000000000000000000 # v7', '        with:', '          persist-credentials: false'],
    lookup: [
      '      - name: Reuse?',
      '        id: reuse',
      "        if: github.event_name == 'push'",
      '        env:',
      '          GH_TOKEN: ${{ github.token }}',
      '        run: node tools/ci/lane-reuse.mjs --job "static (validate floor)"',
    ],
    report: [
      '      - name: Reused',
      `        if: ${HIT_IF}`,
      '        env:',
      '          REUSED_FROM: ${{ steps.reuse.outputs.from }}',
      '        run: echo "$REUSED_FROM" >> "$GITHUB_STEP_SUMMARY"',
    ],
    work: ['      - name: Work', `        if: ${REUSE_CLAUSE}`, '        run: echo work'],
    joined: ['      - name: Joined', `        if: failure() && ${REUSE_CLAUSE}`, '        run: echo log'],
    record: [
      '      - name: Record',
      "        if: github.event_name == 'pull_request'",
      '        env:',
      '          PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}',
      '        run: node tools/ci/lane-reuse.mjs --record --job "static (validate floor)"',
    ],
  }
  const good = [...S.harden, ...S.checkout, ...S.lookup, ...S.report, ...S.work, ...S.joined, ...S.record]
  const judge = (text) => reuseProblems(text, ['static'])
  assert.deepEqual(judge(lane({ steps: good })), [])

  const red = (text, re) => assert.ok(judge(text).some((p) => re.test(p)), `expected ${String(re)} in ${JSON.stringify(judge(text))}`)
  // the lookup is not the first step after checkout
  red(lane({ steps: [...S.harden, ...S.checkout, ...S.work, ...S.lookup, ...S.report, ...S.record] }), /first step after checkout is not the reuse lookup/)
  // --job differs from the job's name:
  red(lane({ steps: good.map((l) => l.replace('--job "static (validate floor)"', '--job "unit"')) }), /lookup's --job must equal/)
  // the lookup runs on every event
  red(lane({ steps: good.map((l) => l.replace("if: github.event_name == 'push'", 'if: always()')) }), /push only/)
  // a later step without the condition, and one that joins it with ||
  red(lane({ steps: [...S.harden, ...S.checkout, ...S.lookup, ...S.report, '      - name: Bare', '        run: echo bare', ...S.record] }), /'Bare' lacks the condition/)
  red(lane({ steps: good.map((l) => l.replace(`failure() && ${REUSE_CLAUSE}`, `failure() || ${REUSE_CLAUSE}`)) }), /'Joined' lacks the condition/)
  // the record step is not last, or not pull_request-only
  red(lane({ steps: [...S.harden, ...S.checkout, ...S.lookup, ...S.report, ...S.record, ...S.work] }), /last step must be the record/)
  red(lane({ steps: good.map((l) => l.replace("if: github.event_name == 'pull_request'", 'if: always()')) }), /last step must be the record/)
  // the record's run text carries the marker
  red(lane({ steps: good.map((l) => l.replace('      - name: Record', '      - name: Record ([lane-reuse] RECORD v1)')) }), /carries the marker itself/)
  // a job-level if:
  red(lane({ jobIf: "github.event_name == 'pull_request'", steps: good }), /job-level if:/)
  // permissions: one scope missing, or one widened
  red(lane({ perms: ['contents', 'pull-requests'], steps: good }), /permissions must be exactly/)
  red(lane({ steps: good }).replace('      actions: read', '      actions: write'), /permissions must be exactly/)
  // no reused-from output
  red(lane({ outputs: false, steps: good }), /outputs\.reused-from/)
  // no hit report
  red(lane({ steps: [...S.harden, ...S.checkout, ...S.lookup, ...S.work, ...S.record] }), /exactly one hit report/)
  // another job calls the script
  red(lane({ steps: good }).replace('      - run: echo other', '      - run: node tools/ci/lane-reuse.mjs --job "other"'), /#other: calls tools\/ci\/lane-reuse\.mjs but is not a reuse lane/)
})
