#!/usr/bin/env node
// Canary-coverage lockstep: every step in the shipped VALIDATE_STEPS ∪
// STOP_HOOK_STEPS must have at least one mechanical red-proof registered in
// tests/canary/injections.json, every proof reference must actually exist, and
// every guard rule id exported by the hooks' pure-data rule tables
// (.claude/hooks/lib/guard-rules.mjs) must have a behavioral canary in
// tests/hooks/hook-contract.test.mjs (per-rule falsifiability closure — an
// unreferenced rule id reds the PR). A NEW gate/rule cannot merge without a
// canary; a DELETED gate cannot leave a stale registry entry.
// 0.7.0 closes the same loop over the FACTORY: every gate script in scripts/
// (check-*.mjs, hygiene.mjs, generate-floor.mjs) unioned with every step name in
// .claude/hooks/stop-factory-gate.mjs needs a registry entry in #factoryGates, and
// every job in the factory's own .github/workflows needs one in #factoryLanes —
// keyed '<file>#<job>', never bare ids.
//   usage: node scripts/check-canary-coverage.mjs [registry-path] [hook-contract-path]
//            [factory-scripts-dir] [factory-hook-path] [factory-workflows-dir]
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { walkTemplate } from '../installer/lib/copy.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
// Flags and positionals are separated so `--no-spawn` may appear anywhere without being
// mistaken for the registry path (argv[2]); the two positionals are the optional overrides.
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const REGISTRY = resolve(positional[0] ?? join(ROOT, 'tests/canary/injections.json'))
const HOOK_CONTRACT = resolve(positional[1] ?? join(ROOT, 'tests/hooks/hook-contract.test.mjs'))
// The factory-closure overrides (0.7.0), same convention: tests present synthetic trees.
const FACTORY_SCRIPTS_DIR = resolve(positional[2] ?? join(ROOT, 'scripts'))
const FACTORY_HOOK = resolve(positional[3] ?? join(ROOT, '.claude/hooks/stop-factory-gate.mjs'))
const FACTORY_WORKFLOW_DIR = resolve(positional[4] ?? join(ROOT, '.github/workflows'))
const errs = []

const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'))
const config = await import(
  pathToFileURL(join(ROOT, 'template/base/tools/harness.config.mjs')).href
)
const stepNames = new Set(
  [...config.VALIDATE_STEPS, ...config.STOP_HOOK_STEPS].map(([name]) => name),
)

// 1. Bidirectional closure: steps ↔ registry.
for (const name of stepNames) {
  const proofs = registry.steps?.[name]
  if (!Array.isArray(proofs) || proofs.length === 0) {
    errs.push(`step '${name}' has NO red-proof in tests/canary/injections.json — a gate that cannot go red is decoration; add a fixture test or selftest canary`)
  }
}
for (const name of Object.keys(registry.steps ?? {})) {
  if (!stepNames.has(name)) {
    errs.push(`registry covers '${name}' but no such step exists in VALIDATE_STEPS ∪ STOP_HOOK_STEPS — stale entry`)
  }
}

// 2. Every proof reference resolves — and, unless --no-spawn, every runnable proof is RUN.
//
// G28: this used to be an existsSync() and nothing more. "The file is there" is a weaker claim
// than "the file is a working proof": a fixture broken by a refactor, or one whose tests were
// all deleted/commented-out, would satisfy existsSync while proving nothing. So each proof is
// now EXECUTED, and must clear two RELIABLE bars:
//   (1) it runs GREEN (exit 0) — catches a proof the gate-under-test's own refactor has broken;
//   (2) it contains at least one REAL test — catches an empty or gutted fixture.
//
// HONEST LIMIT — this does NOT prove the proof drives the gate RED. That is a semantic property
// no generic runner can verify (a test that asserts the gate PASSES also runs green with real
// tests). Writing a proof that actually reds the gate remains the fixture author's job; this
// check guarantees the proof is present, runnable and non-empty, not that it is correct.
//
// Emptiness is detected structurally, NOT by the test count: `node --test` reports "# tests 1"
// for a zero-test file (the file execution itself counts), so a count is useless at the 0/1
// boundary. When a file declares ZERO tests, node emits ONE synthetic point naming THE PATH IT
// WAS GIVEN — `ok N - <proof.ref>`. We match that exact ref, NOT a generic `*.mjs` pattern:
//   - a REAL test whose title happens to be a bare filename (`test('check-route-manifest.mjs', …)`
//     renders as `ok 1 - check-route-manifest.mjs`) would collide with a `*.mjs` pattern and be
//     falsely called empty — and titling a test after the file it exercises is idiomatic here;
//   - a `*.mjs` pattern also silently ignores an empty `.js`/`.cjs` proof.
// Matching the exact ref (which includes a directory, so a bare title cannot equal it) fixes both.
//
// NODE_TEST_* is stripped from the child env: without that, a checker spawned from inside
// `node --test` (the repo test suite) makes its OWN child run as a nested subtest, which
// suppresses the synthetic line — so the signal would flip depending on who invoked the checker.
// Stripping it makes the child behave identically standalone (real CI) and under the suite.
//
// --no-spawn keeps the fast static path for callers that only want the lockstep check (the
// gate-integrity hash surface, the docs-sync lockstep) and for the test suite itself.
const SPAWN = !process.argv.includes('--no-spawn')
// The searched selftest corpus FOLLOWS THE INVOCATION: the workflow plus every
// scripts/ci/* helper it invokes. The W6 emulator legs live in bash files
// (the emulator-runner action execs its `script:` under dash, so the canary
// legs moved to `bash scripts/ci/*.sh`) and carry their registry-greppable
// titles there — a leg deleted from a helper must red exactly like a deleted
// workflow step. A referenced-but-missing helper throws (fail loud).
const selftestWorkflow = readFileSync(join(ROOT, '.github/workflows/selftest.yml'), 'utf8')
const ciHelpers = [...new Set([...selftestWorkflow.matchAll(/scripts\/ci\/[A-Za-z0-9._-]+/g)].map((m) => m[0]))]
const selftest = [selftestWorkflow, ...ciHelpers.map((p) => readFileSync(join(ROOT, p), 'utf8'))].join('\n')
const CHILD_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('NODE_TEST')),
)
/**
 * A zero-test file emits exactly one synthetic TAP point named after the file node ran. How that
 * path is RENDERED is not portable: node varies it by platform (Windows separators, relative vs
 * absolute, a leading `file://`) and may append a ` # time=…` TAP comment. So we do not pattern
 * the text — we RESOLVE each point's name against ROOT and compare it to the resolved ref. A
 * full-path match (not a basename) still stops a real test merely TITLED after a bare filename
 * (`test('check-route-manifest.mjs')` → `ok 1 - check-route-manifest.mjs`) from being misjudged:
 * that resolves to ROOT/<name>, not to the ref's own directory.
 */
const ranAsEmpty = (tap, ref) => {
  const target = resolve(ROOT, ref).toLowerCase() // Windows paths are case-insensitive
  for (const raw of tap.split('\n')) {
    const m = raw.match(/^(?:not )?ok \d+ - (.+?)(?:\s+#.*)?\s*$/)
    if (!m) continue
    let name = m[1].trim()
    if (name.startsWith('file://')) {
      try {
        name = fileURLToPath(name)
      } catch {
        // not a valid file URL — fall through and let the compare reject it
      }
    }
    if (resolve(ROOT, name).toLowerCase() === target) return true
  }
  return false
}
const ran = new Set()
let spawned = 0
/**
 * Execute one proof file under `node --test` and apply the two G28 verdicts (green with
 * real tests). One spawn per distinct file across ALL registries: several runner-kind
 * steps point at validate-runner.test.mjs, and factoryGates entries share files with
 * steps entries.
 * @param {string} label e.g. `step 'format'` or `factory gate 'hygiene.mjs'`
 * @param {string} ref repo-relative proof path
 */
const runProof = (label, ref) => {
  if (!SPAWN || ran.has(ref)) return
  ran.add(ref)
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ref], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 300_000,
    env: CHILD_ENV,
  })
  spawned += 1
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  if (r.status !== 0) {
    errs.push(
      `${label}: red-proof ${ref} FAILS when run — the proof itself is broken (likely by a refactor of the gate it covers), so the gate has no working proof:\n${out.slice(-800)}`,
    )
  } else if (ranAsEmpty(out, ref)) {
    errs.push(
      `${label}: red-proof ${ref} runs but declares ZERO tests — an empty or gutted proof is not a proof. Restore its test bodies.`,
    )
  }
}

for (const [name, proofs] of Object.entries(registry.steps ?? {})) {
  for (const proof of proofs ?? []) {
    if (proof.kind === 'fixture' || proof.kind === 'runner') {
      if (!existsSync(join(ROOT, proof.ref))) {
        errs.push(`step '${name}': ${proof.kind} proof ${proof.ref} does not exist`)
        continue
      }
      runProof(`step '${name}'`, proof.ref)
    } else if (proof.kind === 'selftest') {
      // A selftest proof names a job in a REAL scaffold on CI (an installed
      // node_modules, a real expo config resolution, a Windows runner). It
      // cannot be spawned from here; the workflow is the execution.
      if (!selftest.includes(proof.ref)) {
        errs.push(`step '${name}': selftest proof step "${proof.ref}" not found in .github/workflows/selftest.yml (or a scripts/ci/* helper it invokes)`)
      }
    } else {
      errs.push(`step '${name}': unknown proof kind ${JSON.stringify(proof.kind)}`)
    }
  }
}

// 2b. CI-LANE closure. The determinism bar counts a BLOCKING CI LANE as enforcement — that
//     is the whole reason the mutation, runtime-rls, integration and device lanes may live
//     outside the Stop chain. But a lane that cannot be proven to go red is decoration
//     exactly like a gate that cannot, so every JOB in the shipped quality-gate workflow
//     must carry a proof here — including the explicit, reasoned declaration that a job
//     runs nothing but already-proven steps.
// ALL EIGHT SHIPPED WORKFLOWS (0.3.0), not just quality-gate.yml. The closure was written
// against the merge gate because that is where most lanes live, and the single hardcoded
// filename made the other seven invisible: codeql, gitleaks, osv-scan, actions-lint,
// adr-guard, migration-safety and mutation are every one of them a BLOCKING lane a
// reviewer reads as enforcement, and not one of them had to carry a red-proof. A supply-
// chain scan that cannot go red is decoration in exactly the way a gate that cannot go red
// is, and it is the kind nobody re-reads because its name sounds like it is working.
const WORKFLOW_DIR = join(ROOT, 'template/base/github/workflows')
const workflowFiles = readdirSync(WORKFLOW_DIR)
  .filter((f) => /\.ya?ml$/.test(f))
  .sort()
/** job id -> the workflow file it lives in (for the error messages). */
const jobHome = new Map()
for (const file of workflowFiles) {
  const text = readFileSync(join(WORKFLOW_DIR, file), 'utf8')
  const at = text.indexOf('\njobs:')
  if (at === -1) {
    errs.push(`${file} exposes no \`jobs:\` block — the CI-lane closure cannot fail open`)
    continue
  }
  const ids = [...text.slice(at).matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1])
  if (ids.length === 0) {
    errs.push(`${file} exposes no parseable jobs — the CI-lane closure cannot fail open`)
  }
  for (const id of ids) {
    // Two workflows naming the same job id would silently share one registry entry, and
    // whichever came second would be covered by a proof written for the first.
    const prior = jobHome.get(id)
    if (prior !== undefined && prior !== file) {
      errs.push(
        `job id '${id}' appears in BOTH ${prior} and ${file} — the lanes registry is keyed by id, so one proof would silently stand in for both. Rename one.`,
      )
    }
    jobHome.set(id, file)
  }
}
const jobIds = [...jobHome.keys()]
if (jobIds.length === 0) {
  errs.push('no workflow jobs found at all — the CI-lane closure cannot fail open')
}
const lanes = registry.lanes ?? {}
for (const job of jobIds) {
  const proofs = lanes[job]
  if (!Array.isArray(proofs) || proofs.length === 0) {
    errs.push(`${jobHome.get(job)} job '${job}' has NO red-proof in tests/canary/injections.json#lanes — a blocking CI lane counts as enforcement, so a lane that cannot go red is decoration. Add a proof, or declare {"kind":"steps"} with a note if the job only runs steps the step registry already proves.`)
  }
}
for (const id of Object.keys(lanes)) {
  if (!jobHome.has(id)) {
    errs.push(`lanes registry covers '${id}' but no shipped workflow has such a job — stale entry`)
  }
}
for (const [id, proofs] of Object.entries(lanes)) {
  for (const proof of proofs ?? []) {
    if (proof.kind === 'steps') {
      // The note requirement, mirrored from the factoryLanes loop below (0.11.0). A bare
      // {"kind":"steps"} here was a silent skip wearing a registry entry: it asserted that
      // the step registry already proves this lane's work and named nothing that does.
      if (typeof proof.note !== 'string' || proof.note.trim() === '') {
        errs.push(
          `lane '${id}': a {"kind":"steps"} declaration must carry a non-empty note naming what already proves the lane's work — a bare declaration is a silent skip wearing a registry entry`,
        )
      }
      continue
    }
    if (proof.kind === 'fixture' || proof.kind === 'runner') {
      if (!existsSync(join(ROOT, proof.ref))) {
        errs.push(`lane '${id}': ${proof.kind} proof ${proof.ref} does not exist`)
        continue
      }
      // EXECUTED, not merely present (0.11.0). Through 0.10.0 the two lane registries got
      // existsSync and nothing else, so a lane proof gutted to an empty file — or repointed
      // at a file testing something entirely different — passed the closure that exists to
      // catch exactly that. Same G28 bar the `steps` pass has applied since 0.3.0; 12
      // distinct files are added to the spawn set by this and the factoryLanes loop.
      runProof(`lane '${id}'`, proof.ref)
    } else if (proof.kind === 'selftest') {
      if (!selftest.includes(proof.ref)) {
        errs.push(`lane '${id}': selftest proof step "${proof.ref}" not found in .github/workflows/selftest.yml (or a scripts/ci/* helper it invokes)`)
      }
    } else {
      errs.push(`lane '${id}': unknown proof kind ${JSON.stringify(proof.kind)}`)
    }
  }
}

// 2c. FACTORY-LANE closure (0.7.0). The factory's own workflows are enforcement in
//     exactly the way the shipped ones are — hygiene, lint, release, scorecard and the
//     selftest matrix are what stand between a maintainer's turn and the fleet — and
//     until this release not one of their jobs had to carry a proof or even a reason.
//     Keyed '<file>#<job>', never bare ids: the consumer lanes registry above already
//     claims 'actionlint' and 'zizmor', so a bare-id factory entry would silently share
//     one proof between two different workflows — the exact collision the jobHome check
//     guards inside ONE directory, recreated across the two registries.
const factoryJobs = new Set()
for (const file of readdirSync(FACTORY_WORKFLOW_DIR)
  .filter((f) => /\.ya?ml$/.test(f))
  .sort()) {
  const text = readFileSync(join(FACTORY_WORKFLOW_DIR, file), 'utf8')
  const at = text.indexOf('\njobs:')
  if (at === -1) {
    errs.push(`${file} exposes no \`jobs:\` block — the factory-lane closure cannot fail open`)
    continue
  }
  const ids = [...text.slice(at).matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1])
  if (ids.length === 0) {
    errs.push(`${file} exposes no parseable jobs — the factory-lane closure cannot fail open`)
  }
  for (const id of ids) factoryJobs.add(`${file}#${id}`)
}
if (factoryJobs.size === 0) {
  errs.push('no factory workflow jobs found at all — the factory-lane closure cannot fail open')
}
const factoryLanes = registry.factoryLanes ?? {}
for (const key of factoryJobs) {
  const proofs = factoryLanes[key]
  if (!Array.isArray(proofs) || proofs.length === 0) {
    errs.push(
      `factory workflow job '${key}' has NO entry in tests/canary/injections.json#factoryLanes — the factory's own lanes count as enforcement exactly like the shipped ones. Point at the lane logic's own test file, or declare {"kind":"steps"} with a note naming what already proves the job's work.`,
    )
  }
}
for (const key of Object.keys(factoryLanes)) {
  if (!key.includes('#')) {
    errs.push(
      `factoryLanes key '${key}' is a bare job id — this registry is keyed '<workflow-file>#<job>' because the consumer lanes registry already claims bare ids (actionlint, zizmor), and one proof must never silently stand in for two workflows. Rekey it.`,
    )
    continue
  }
  if (!factoryJobs.has(key)) {
    errs.push(`factoryLanes registry covers '${key}' but no factory workflow has such a job — stale entry`)
  }
}
for (const [key, proofs] of Object.entries(factoryLanes)) {
  for (const proof of proofs ?? []) {
    if (proof.kind === 'steps') {
      if (typeof proof.note !== 'string' || proof.note.trim() === '') {
        errs.push(
          `factory lane '${key}': a {"kind":"steps"} declaration must carry a non-empty note naming what already proves the job's work — a bare declaration is a silent skip wearing a registry entry`,
        )
      }
    } else if (proof.kind === 'fixture') {
      if (!existsSync(join(ROOT, proof.ref))) {
        errs.push(`factory lane '${key}': fixture proof ${proof.ref} does not exist`)
        continue
      }
      // EXECUTED, not merely present (0.11.0) — see the lanes loop above for the class.
      runProof(`factory lane '${key}'`, proof.ref)
    } else {
      errs.push(`factory lane '${key}': unknown proof kind ${JSON.stringify(proof.kind)}`)
    }
  }
}

// 2d. FACTORY-GATE closure (0.7.0). The gates that guard the guards: every gate script
//     in scripts/ (check-*.mjs plus hygiene.mjs and generate-floor.mjs), UNIONED with
//     every step name in the factory Stop hook's two tables. A hook step that invokes a
//     scripts/*.mjs identifies with that script member (one gate, one entry); a
//     toolchain step with no script (eslint, types, dead-code, format, tests) stands
//     alone under its own name. The hook is PARSED, not imported: it EXECUTES on import
//     (top-level readHookInput() plus the gate spawns), so a text parse of the two
//     `const STEPS`/`const TOOLCHAIN_STEPS` tables is the honest mechanism — and a
//     missing table fails loud, because a closure that cannot see its universe fails open.
const factoryGateHome = new Map()
for (const f of readdirSync(FACTORY_SCRIPTS_DIR).sort()) {
  if (/^check-[a-z0-9-]+\.mjs$/.test(f) || f === 'hygiene.mjs' || f === 'generate-floor.mjs') {
    factoryGateHome.set(f, `scripts/${f}`)
  }
}
const factoryHookSrc = readFileSync(FACTORY_HOOK, 'utf8')
for (const table of ['STEPS', 'TOOLCHAIN_STEPS']) {
  const open = factoryHookSrc.indexOf(`const ${table} = [`)
  const close = factoryHookSrc.indexOf('\n]', open)
  if (open === -1 || close === -1) {
    errs.push(
      `.claude/hooks/stop-factory-gate.mjs exposes no parseable ${table} table — the factory-gate closure cannot fail open`,
    )
    continue
  }
  for (const m of factoryHookSrc
    .slice(open, close)
    .matchAll(/\[\s*'([a-z][a-z0-9-]+)',\s*\[([^\]]*)\]/g)) {
    const script = /scripts\/([A-Za-z0-9._-]+\.mjs)/.exec(m[2])
    const member = script === null ? m[1] : script[1]
    if (!factoryGateHome.has(member)) {
      factoryGateHome.set(member, `factory Stop-hook step '${m[1]}'`)
    }
  }
}
if (factoryGateHome.size === 0) {
  errs.push('no factory gates found at all — the factory-gate closure cannot fail open')
}
const factoryGates = registry.factoryGates ?? {}
for (const [member, home] of factoryGateHome) {
  const proofs = factoryGates[member]
  if (!Array.isArray(proofs) || proofs.length === 0) {
    errs.push(
      `factory gate '${member}' (${home}) has NO red-proof in tests/canary/injections.json#factoryGates — the gates that guard the guards are decoration too when they cannot go red. Add a fixture test, or a {"kind":"lane"} declaration naming the '<file>#<job>' that executes it.`,
    )
  }
}
for (const member of Object.keys(factoryGates)) {
  if (!factoryGateHome.has(member)) {
    errs.push(
      `factoryGates registry covers '${member}' but no such gate script or factory Stop-hook step exists — stale entry`,
    )
  }
}
for (const [member, proofs] of Object.entries(factoryGates)) {
  for (const proof of proofs ?? []) {
    if (proof.kind === 'fixture') {
      if (!existsSync(join(ROOT, proof.ref))) {
        errs.push(`factory gate '${member}': fixture proof ${proof.ref} does not exist`)
        continue
      }
      runProof(`factory gate '${member}'`, proof.ref)
    } else if (proof.kind === 'lane') {
      if (!factoryJobs.has(proof.ref)) {
        errs.push(
          `factory gate '${member}': lane declaration ${JSON.stringify(proof.ref)} names no factory workflow job — it must be a '<file>#<job>' present in the factory's .github/workflows`,
        )
      }
    } else {
      errs.push(`factory gate '${member}': unknown proof kind ${JSON.stringify(proof.kind)}`)
    }
  }
}

// 3. Hook-rule closure: every guard rule id has a behavioral canary. The rule
//    tables are pure data (no side effects) — import them directly and assert
//    each id appears as a quoted string literal in the hook-contract test (where
//    the RULE_CANARIES table keys them). Ids are kebab-case, so they can only
//    appear as quoted object keys — a substring collision is not possible.
const hookContract = readFileSync(HOOK_CONTRACT, 'utf8')
const guardRules = await import(
  pathToFileURL(join(ROOT, 'template/base/.claude/hooks/lib/guard-rules.mjs')).href
)
const ruleTables = [
  'BASH_RULES',
  'WRITE_PROTECTED',
  'WRITE_GLOBAL_CHECKS',
  'WRITE_SQL_CHECKS',
  'WRITE_CONFIG_CHECKS',
  'MCP_RULES',
]
const ruleIds = []
for (const table of ruleTables) {
  if (!Array.isArray(guardRules[table]) || guardRules[table].length === 0) {
    errs.push(`guard-rules.mjs is missing/empty export ${table} — the hooks fail closed without it`)
    continue
  }
  for (const rule of guardRules[table]) {
    if (typeof rule?.id !== 'string' || !rule.id) {
      errs.push(`guard-rules.mjs ${table} has a rule without a string id`)
      continue
    }
    ruleIds.push(rule.id)
  }
}
for (const id of ruleIds) {
  if (!hookContract.includes(`'${id}'`) && !hookContract.includes(`"${id}"`)) {
    errs.push(`guard rule id '${id}' has no behavioral canary in tests/hooks/hook-contract.test.mjs — every rule must have a deny/allow case (add a RULE_CANARIES entry)`)
  }
}

// 3a. GROUNDEDNESS: a WRITE_PROTECTED rule naming ONE exact file must name a file the
//     template actually ships.
//
// The per-id closure above cannot see this, and neither can the hook-contract canary,
// because a deny rule over a path that cannot exist is trivially satisfied: the canary
// feeds it the synthetic path, the hook denies, the test passes. 0.1.3 shipped exactly
// that — `migration-apply-runner` over tests/migrations/migration-apply.mjs, a file no
// template has ever contained. It had a rule, a canary, a settings.json allow entry and
// a slot in check-gate-integrity's SURFACE, and all four were green while it guarded
// nothing. An inert rule with a passing canary is the "green but bad" shape this whole
// registry exists to eliminate, so the registry has to be able to see it.
//
// Only FULLY-ANCHORED LITERAL patterns are judged (^…$ with no regex metacharacters
// beyond escaped dots). A prefix rule like ^\.github/workflows/ or ^apps/mobile/android/
// legitimately covers files a consumer authors and the template does not ship, so it is
// skipped — this asks the one question that is decidable, and asks it of every rule for
// which it is decidable.
// A regex LITERAL escapes its slashes, so the source of /^a\/b\.mjs$/ is `^a\/b\.mjs$`.
// Both escapes have to be accepted or this matches nothing and skips silently — which it
// did on the first draft, and the ghost-rule proof below is what caught it.
const LITERAL_RULE = /^\^((?:[A-Za-z0-9_.\-/]|\\[./])+)\$$/

// The template is not the only legitimate producer of a file an install carries, so
// "the template ships it" is too narrow a test for "this path can exist". Exactly two
// other producers exist, and each entry needs a named one — that is what keeps this from
// becoming a place to park inert rules. A third entry is a reviewable act, and the
// question to answer in review is always the same: WHO writes this file, and when?
const GROUNDED_ELSEWHERE = {
  'tools/agents.lock.json':
    'written by the INSTALLER, not shipped: init and update run tools/gen-agents-lock.mjs --write against the install\'s own .claude/{agents,commands,skills} (installer/lib/agents-lock.mjs). Shipping a lock from the template would pin the template\'s agent files, which is the opposite of what the lock is for.',
  '.claude/settings.local.json':
    "Claude Code writes it per developer and it is gitignored — a template that shipped one would be shipping one machine's local permission grants to every consumer. The rule exists precisely because it is the file an agent would reach for to widen its own permissions.",
  'tools/retrofit-accept.json':
    "written by a HUMAN, once, to accept a specific retrofit conflict. check-gate-integrity reads it absent-as-empty, so shipping an empty one would ship a reviewed-acceptance file nobody reviewed — and an install that never retrofitted has nothing to accept. The rule exists because CREATING this file is what converts a red into a NOTE, which is exactly as consequential as widening an escape list.",
  'tools/secret-scan-allow.json':
    'written by a HUMAN to allow a specific secret-shaped string the `secrets` gate found. check-secrets.mjs reads it absent-as-empty (the per-rule placeholder allowlist that ships lives in tools/secret-patterns.json, which IS shipped), so the file exists only on installs that have deliberately allowed something — and each entry is one credential shape the scanner stops reporting.',
  // 0.5.0. Same producer and same shape as the two above: check-migrations.mjs reads it
  // absent-as-empty, and the file exists only on installs that have acknowledged applied
  // history. It shipped in 0.4.0 with no write-guard rule at all — the rule arrives now,
  // and this entry is what says the rule is not inert. WHO writes it: a human, once per
  // (migration, rule) pair, and only for a migration that already existed at the diff
  // base, so the gate refuses an entry for one written today.
  'tools/migrations-allow.json':
    'written by a HUMAN to acknowledge that an APPLIED migration cannot be swept — both remedies live inside the migration and the append-only rule reds any edit to a committed one. check-migrations.mjs reads it absent-as-empty and reds a STALE entry, so the file exists only on installs carrying history they have deliberately exempted, one (file, rule) pair at a time.',
  // 0.9.0. The third producer class: GIT itself.
  '.git/config':
    'written by GIT, never by a template: `git init`/`clone` creates it and the `git config` CLI maintains it. The rule exists because a DIRECT overwrite of the file is `core.hooksPath` (and more) rewritten with no `git config` token for the bash guard\'s git-hookspath-repoint rule to see — layer 2 was disarmable by one Write while the whole chain stayed green.',
}

const shippedPaths = new Set(
  ['base', 'stack']
    .concat(readdirSync(join(ROOT, 'template', 'modules')).sort().map((m) => `modules/${m}`))
    .flatMap((tree) => walkTemplate(tree))
    .map((e) => e.installPath),
)
for (const rule of guardRules.WRITE_PROTECTED ?? []) {
  const m = LITERAL_RULE.exec(String(rule.re?.source ?? ''))
  if (m === null) continue
  const literal = m[1].split('\\.').join('.').split('\\/').join('/')
  if (!shippedPaths.has(literal) && GROUNDED_ELSEWHERE[literal] === undefined) {
    errs.push(
      `guard rule '${rule.id}' write-protects ${literal}, which NO template tree ships — a deny over a path that cannot exist is satisfied by every input, so its canary passes while the rule guards nothing. Delete the rule, or ship the file it was written for.`,
    )
  }
}

// The registry still names one grep-able deny example per guard surface (a
// human-readable spot check that the closure is wired to the real hooks).
for (const [hook, expected] of Object.entries(registry.hookRules ?? {})) {
  for (const example of expected.denyExamples ?? []) {
    if (!hookContract.includes(example)) {
      errs.push(`${hook}: deny example ${JSON.stringify(example)} not found in tests/hooks/hook-contract.test.mjs`)
    }
  }
}

// 3a-bis. THE HOOK -> REGISTRY DIRECTION (0.11.0). Every loop above iterates the REGISTRY,
// so a hook with no entry was required by nothing: no deny example, no call-site pin, no
// proof, and nothing anywhere noticed. Measured at 0.10.0 the tree shipped seven hooks and
// the registry named three — the four uncovered ones included `stop-validate-gate.mjs`, the
// TURN-FATAL hook whose whole job is that a turn cannot end on a red build. A closure that
// runs one way is a census of what somebody remembered to write down.
const shippedHooks = readdirSync(join(ROOT, 'template/base/.claude/hooks'))
  .filter((f) => f.endsWith('.mjs'))
  .sort()
if (shippedHooks.length === 0) {
  errs.push(
    'no .mjs hooks found under template/base/.claude/hooks — the hook closure cannot fail open',
  )
}
for (const hook of shippedHooks) {
  if (registry.hookRules?.[hook] === undefined) {
    errs.push(
      `hook '${hook}' ships under template/base/.claude/hooks but has NO entry in tests/canary/injections.json#hookRules — an unregistered hook is required to carry no deny example, no denyToolCallSites pin and no red-proof. Give it an entry, or declare {"kind":"steps"} with a note naming what already proves it.`,
    )
  }
}

// 3b. Path-scoped checks living INSIDE the hooks (app-config weakenings, append-only
// migrations, DAL wrapper, secure-store seam, …) are not in the data tables, so the
// per-id closure above cannot see them. Pin their denyTool( call-site count instead —
// adding an inline deny site forces a conscious registry bump plus a deny test, the
// speed bump the old denySites count provided.
for (const [hook, expected] of Object.entries(registry.hookRules ?? {})) {
  // A {"kind":"steps"} declaration is a reasoned exemption, not a pin — it carries a note
  // instead of a count, checked below.
  if (expected?.kind === 'steps') {
    if (typeof expected.note !== 'string' || expected.note.trim() === '') {
      errs.push(
        `hook '${hook}': a {"kind":"steps"} declaration must carry a non-empty note naming what already proves the hook's behaviour — a bare declaration is a silent skip wearing a registry entry`,
      )
    }
    continue
  }
  if (typeof expected.denyToolCallSites !== 'number') continue
  // A STALE entry naming a deleted hook reached an UNCAUGHT readFileSync here, so the gate
  // died with an ENOENT stack trace instead of reporting a finding — the failure mode of
  // the registry going stale was a CRASHED checker rather than a red one, and a crash is
  // the one outcome a reader cannot tell from infrastructure trouble.
  let src
  try {
    src = readFileSync(join(ROOT, 'template/base/.claude/hooks', hook), 'utf8')
  } catch {
    errs.push(
      `hookRules registry covers '${hook}' but template/base/.claude/hooks/${hook} does not exist — stale entry. Delete it, or restore the hook it was written for.`,
    )
    continue
  }
  const count = (src.match(/denyTool\(/g) ?? []).length
  if (count !== expected.denyToolCallSites) {
    errs.push(
      `${hook}: ${count} denyTool( call sites but the registry pins ${expected.denyToolCallSites} — update tests/canary/injections.json hookRules AND add a deny test for the new site`,
    )
  }
}

if (errs.length > 0) {
  console.error(`CANARY COVERAGE: ${errs.length} gap(s):`)
  for (const e of errs) console.error(`  - ${e}`)
  process.exit(1)
}
console.log(
  `CANARY COVERAGE: CLEAN (${stepNames.size} steps each carry a red-proof; ` +
    `${factoryGateHome.size} factory gates and ${factoryJobs.size} factory lanes closed; ` +
    `${ruleIds.length} guard rule ids all canaried; ` +
    `${String(spawned)} proof file(s) ${SPAWN ? 'EXECUTED green with real tests (not proof of redness — see G28 note)' : 'existence-checked only (--no-spawn)'})`,
)
