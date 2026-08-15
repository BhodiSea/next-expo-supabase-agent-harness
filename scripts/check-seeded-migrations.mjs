#!/usr/bin/env node
// seedOnInitOnly completeness gate for the harness repo itself (selftest CI —
// never shipped to consumers). The hazard it closes: `update` auto-plants any
// ABSENT non-owned file it does not recognize as init-time-only, so a template
// file newly ADDED since the previous release that installs as SEEDED or CONFIG
// content and is NOT registered seedOnInitOnly in template/migrations.json gets
// silently planted into every existing install on their next `update` — and an
// exemplar the consumer's routes/App never reference reds route-manifest +
// dead-code (the hand-maintained-list gap the 0.1.4 release survived by luck).
// This script makes forgetting the registration a red PR instead of a red fleet.
//   usage: node scripts/check-seeded-migrations.mjs
//   env:   PREVIOUS_RELEASE_TAG — the release to diff against (default: the highest
//          v*.*.* tag STRICTLY BELOW this tree's package.json version)
// Path mapping REUSES the installer's own storageToInstall (the .tmpl strip +
// top-level dotless RENAMES walkTemplate routes every install through), and the
// classification reuses fileMode + seedOnInitOnlyPatterns/matchSeedOnInitOnly —
// zero duplicated rename or mode logic, so this gate cannot drift from `update`.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { storageToInstall, walkTemplate } from '../installer/lib/copy.mjs'
import { templateCandidates } from '../installer/lib/layout.mjs'
import { fileMode } from '../installer/lib/manifest.mjs'
import {
  VERSION_KEY,
  matchSeedOnInitOnly,
  probeMatchesBroken,
  readTemplateMigrations,
  seedOnInitOnlyPatterns,
} from '../installer/lib/migrations.mjs'
import { highestReleaseBelow } from './lib/ramp-sites.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
// This tree's own version, so the previous-release baseline can be resolved STRICTLY BELOW
// it. Read here rather than inside the git block because the rule is about the version, not
// about git: a baseline that can equal the version being cut is the defect, wherever it came from.
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version

// Deliberate plants: rare seeded/config additions that SHOULD auto-plant into
// existing installs on `update` (nothing references them, or every install must
// carry them for a gate to keep working). Each entry needs the git path exactly
// as `git diff` prints it plus a written reason — an empty reason is a review
// reject. Example: { file: 'template/stack/tools/new-budget.json', reason: '…' }
const DELIBERATE_PLANT = [
  {
    file: 'template/base/tools/suppressions-allow.json',
    reason:
      'ABSENT, tools/check-suppressions.mjs still scans but then FAILS asking for the register (after the 1.0.0 ramp), so a pre-1.0.0 install would trade its dated NOTE for a hard red the moment the ramp expires — the observability.json shape exactly. Planting costs an existing install nothing: the census closes over THEIR tree, and the shipped rows describe the harness-seeded files their tree already carries (a consumer who edited a seeded file away simply deletes the stale row the gate names). The content is a review record of the scaffold’s own directives; it names no consumer-specific site.',
  },
  {
    file: 'template/base/tools/resilience.json',
    reason:
      'Identical reasoning to suppressions-allow.json one line up: tools/check-resilience.mjs fails closed on a missing register after its ramp, so withholding would convert a dated NOTE into a hard red on the exact install that cannot receive the file. The shipped rows declare the scaffold’s own eight seam files (tRPC client, rate-limiter fetch, five supabase-js factories, the delete-account Edge Function) — universal exemplar content, no consumer-specific seam.',
  },
  {
    file: 'template/base/tools/backup-posture.json',
    reason:
      "ABSENT, `tools/check-backup-posture.mjs` skips loudly and produces no backup evidence at all — and the scheduled `backup-evidence` job that runs it arrives on the SAME `update` that would withhold this file, so seedOnInitOnly would ship the job and hold back its one input, guaranteeing a lane that can never do anything on an upgraded install. Planting it costs an existing install NOTHING: the file ships deliberately incomplete (maxDailyBackupAgeHours null, restorationTesting.lastTestedOn null) and the script never reaches the shape check without credentials, so an install that has not wired SUPABASE_ACCESS_TOKEN sees exactly one loud SKIP on a weekly cron and no red anywhere. The content is a posture contract plus the vendor ceilings — it names no consumer table, project or number, exactly like tenancy.json above.",
  },
  {
    file: 'template/base/tools/eol.json',
    reason:
      'ABSENT, `version-sync`\'s end-of-life section has nothing to judge and says so — and "the register is missing" must never read as "no dependency here is abandoned", which is the vacuity the whole 0.9.9 release is written against. Withholding it (seedOnInitOnly) would be worse than either alternative: the ramp on its absence expires at 0.10.0, so an existing install would trade a dated NOTE for a hard red demanding a file `update` had deliberately refused to give it. So it is PLANTED, and the ambush that creates is paid for in the same diff rather than deferred: a consumer\'s lockfile is a SUPERSET of the harness\'s, so the planted six rows will not cover every deprecated package their tree resolves, and every finding the section produces is therefore ramped as one until 0.10.0 (obligations row eol-register-ramp-expiry). The planted content is the harness\'s own dependency set — jest\'s glob@7 and inflight, jsdom 20\'s abab/domexception/whatwg-encoding, and uuid@7 through expo\'s prebuild toolchain — plus two vendor support-policy quotes; it names no consumer package, exactly like tenancy.json above.',
  },
  {
    file: 'template/base/tools/observability.json',
    reason:
      'check-observability.mjs without this file still SCANS (on the built-in REQUIRED_VENDOR_FLOOR detector) but then FAILS asking for the register — there is no sinks[] to judge egress against, and that failure fires after the ramp, so a pre-0.8.0 install would trade its dated NOTE for a hard red the moment the ramp expires. The shipped content is the detector floor plus zero sinks — a contract, not project data — and planting it is what keeps the first post-update validate deterministic on every vintage.',
  },
  {
    file: 'template/base/tools/tenancy.json',
    reason:
      'check-tenancy.mjs FAILS CLOSED when the contract is missing, and that check runs before any ramp — an install with the `tenancy` step injected and no contract reds on its first validate. The file is a contract (the closed predicate-form set, the rank ladder, the two helper names), not project data: nothing in it names a consumer table. Planting it is what makes the injected step ramp instead of fail.',
  },
  {
    file: 'template/base/tools/db-limits.json',
    reason:
      'Identical reasoning to tenancy.json: check-db-limits.mjs fails closed on a missing ceiling list before it can ramp. The rows are role x knob ceilings and the quota trigger shape — universal, not project-specific.',
  },
  {
    file: 'template/base/tools/security-headers.json',
    reason:
      'The gate ramps on the absent MODULE (apps/web/lib/security-headers.ts, which IS withheld), so this file is never read by an un-adopted install. It is planted so that pulling the module later with `--refresh-seeded` yields a gate that judges the headers immediately, rather than one that fails closed on a missing policy. The policy is a web response posture; it names no consumer route.',
  },
  {
    file: 'template/base/tools/approved-tools.json',
    reason:
      "The registry pretool-mcp-guard.mjs reads, and the guard FAILS CLOSED without it: an absent registry is not an empty policy, it is no policy, so every mcp__ call in an updated install would be denied against a file that is not there. `update` wires the sixth hook into existing installs, so withholding its one input would ship the deny and hold back the policy. It is seeded rather than owned because the guard's own deny message asks the consumer to add a row, and sha-pinning a file you are told to edit calls that edit tampering; its integrity is the write-guard rule plus gate-integrity's escape-list dirty check. Same shape as tenancy.json above. Recorded in template/migrations.json under 0.3.0, and upgrade-lane.sh asserts the plant actually lands.",
  },
  {
    file: 'template/base/tools/auth-posture.json',
    reason:
      'check-auth-posture.mjs FAILS CLOSED when the policy is missing, and that check runs before any ramp — an install with the `auth-posture` step injected and no policy reds on its first validate. Identical reasoning to tenancy.json and db-limits.json above: the file is a POSTURE (token lifetimes, rotation, the anonymous-sign-in decision, the redirect-allowlist ceiling), not project data — nothing in it names a consumer table, route or procedure. Planting it is what makes the injected step ramp instead of fail.',
  },
  {
    file: 'template/base/tools/data-flow.json',
    reason:
      "check-data-flow.mjs FAILS CLOSED when the policy is missing — an install with the `data-flow` step injected and no policy reds on its first validate, exactly like tenancy.json, db-limits.json and auth-posture.json above. It is the schema-shaped one of the four, and that is deliberate rather than an exception: the entries name THIS template stack's tables, and an install whose schema differs gets those as stale-entry findings, which the 0.6.0 ramp holds as NOTEs until 0.7.0. Withholding it instead would hard-fail the step on every upgraded install, because a missing policy is not an empty policy — it is no policy, and the whole subject of the gate is that data surviving a deletion must be REVIEWED rather than merely absent from a list. Seeded rather than owned because the gate's own failure text tells the consumer to record their reasons in it, and sha-pinning a file you are told to edit calls that edit tampering.",
  },
  {
    file: 'template/base/tools/reviewer-triggers.json',
    reason:
      'check-reviewer-verdicts.mjs FAILS CLOSED when the trigger table is missing — the Stop step cannot evaluate who owed a review, and a step that cannot tell must not report that nobody did. Same call as approved-tools.json, whose guard `update` wires into existing installs and which would otherwise deny against a file that is not there: this release wires the SubagentStop hook the same way, so withholding its one input would ship the obligation and hold back the policy. The patterns name HARNESS paths (supabase/migrations, packages/api, apps/web/app/actions) that every scaffold from this template has, and a consumer narrows or widens them in a reviewed diff — which is why it is seeded rather than owned.',
  },
  {
    file: 'template/base/tools/web-route-allowlist.json',
    reason:
      "readAllowlist() treats an ABSENT allowlist as an EMPTY one, and an empty allowlist reds every chrome page — so check-web-routes.mjs fails closed without it, and the seeded-migrations rule says plant. Identical reasoning to approved-tools.json above, and the same seeded-not-owned choice for the same reason: the gate's failure message asks the consumer to add a row, and sha-pinning a file you are told to edit calls that edit tampering. The registry it guards (apps/web/lib/routes.generated.ts, the page.meta.ts files, app/not-found.tsx) is WITHHELD in the same release, so on an un-adopted install this file is data the gate reads and finds nothing to exempt — which is the correct empty state, not a bypass.",
  },
  {
    file: 'template/base/tools/vertical-anatomy-allow.json',
    reason:
      'The vertical-anatomy escape (boundaries part 3, 0.9.5). check-workspace-deps treats an ABSENT allow-file as an EMPTY allowlist — a deliberate absence tolerance, because pre-0.9.5 installs meet the laws as ramped NOTEs and must not red on a missing file the release never delivered. Planted anyway, per the escape-file convention (approved-tools.json, web-route-allowlist.json): the gate’s failure text asks the consumer to add a reviewed {package, law, reason} entry, and a consumer should edit a planted skeleton with its schema in the comment rather than reconstruct one from a failure message. Seeded not owned for the standard reason: sha-pinning a file you are told to edit calls the edit tampering.',
  },
  {
    file: 'template/stack/packages/platform/env/src/optional.ts',
    reason:
      'The optional server section of the env register (0.9.5, the env-register-gate discharge). PLANT, because the 0.9.5 seededSourceFixes entry instructs existing installs to route the seeded rate-limit runtime and the tRPC route through @app/env/optional — an instruction that is only applicable if the module it imports exists. The file is a contract (four optional schema lines + the both-or-neither pair invariant), names nothing project-specific, and `update` plants seeded files only when ABSENT, so a consumer who already built their own optional section keeps it untouched.',
  },
  {
    file: 'template/stack/packages/platform/env/src/optional.test.ts',
    reason:
      'The red-proofs for optional.ts above — the pair moves together or the planted module lands unproven (imports only ./optional.js + vitest, so it runs green on any install regardless of whether the package.json export line from the same source-fix has been applied yet).',
  },
  {
    file: 'template/base/SECURITY.md',
    reason:
      "PLANT, and the reasoning is the inverse of every entry above it: no gate reads this file, so there is no fail-closed argument — the argument is that an existing install has nothing to lose and something to gain. `update` plants a seeded file only when it is ABSENT, so a project that already wrote its own coordinated-disclosure policy keeps it untouched, and a project with none gets one with its placeholders already rendered from the manifest. Withholding it instead would leave the CRA Art. 14 enablement (from 2026-09-11, and the obligation is the CONSUMER'S — this repo is out of scope as unmonetised FOSS; see design/CONFORMANCE-FACTS.md §4) reaching only new scaffolds, which is the population least likely to be shipping commercially yet. It carries no dated field of its own on purpose: security.txt's mandatory RFC 9116 `Expires` is a reviewer-supplied date in a seeded file, which is exactly the off-switch shape 0.6.0 removed from framework-floor.json, and it is deferred until it ships with a bound.",
  },
  {
    file: 'template/modules/eval-live/packages/eval/package.json.tmpl',
    reason:
      "The eval-live module shipped src/adapters/live.ts with NO package.json — `@app/eval` never resolved, so every install that enabled the module had a workspace package pnpm could not link. Planting completes it. There is nothing of the consumer's to clobber: the file has never existed in any install.",
  },
  {
    file: 'template/modules/eval-live/packages/eval/tsconfig.json',
    reason:
      'Same gap as the package.json above — the module had no project reference, so `tsc -b` never type-checked its one source file. Planting is the fix, not an exemplar.',
  },
  {
    file: 'template/modules/eval-live/packages/eval/src/providers.ts',
    reason:
      'adapters/live.ts imports `../providers.js` and that module did not exist: the module did not compile. This is a repair to a shipped package, so every install with eval-live enabled needs it — withholding it would leave the import dangling exactly as it is today.',
  },
  {
    file: 'template/modules/e2ee/packages/platform/crypto/',
    reason:
      "The e2ee module's whole payload (@app/crypto: the envelope, keyring, ports, the WebCrypto provider, and their vectors and tests). PLANT, on the eval-live precedent above and for the same reason: `update` walks modules/<name> ONLY for modules the install's manifest lists, so a project that never enabled e2ee can never receive these — while a project that DID enable it must, and a seedOnInitOnly pattern would have withheld a later release's crypto fix from exactly the installs shipping cryptography. A directory entry rather than a file list because the package moves as a unit: the barrels, the keyring and the vectors are one contract, and half of it is not a smaller version of it.",
  },
]
// Every seedOnInitOnly pattern must name something the template ACTUALLY SHIPS.
//
// The field is a pure list read by a prefix/exact matcher, and both ways it can be
// wrong are silent. A typo or a path left behind by a rename withholds NOTHING while
// reading as protection, and `update` cheerfully plants the file the entry was meant to
// hold back. A comment string accidentally added to the array is the same bug wearing
// prose — and one ending in '/' would withhold an entire subtree, which is worse.
// Neither shows up in any other check, because both are perfectly valid JSON.
//
// `shipped` is derived from walkTemplate + storageToInstall — the installer's own
// mapping, so a .tmpl strip or a top-level dotless rename can never make this disagree
// with what `update` computes. Directory prefixes are included so a subtree pattern
// resolves against the tree it covers.
export function findUngroundedPatterns({ patterns, shippedInstallPaths }) {
  const dirs = new Set()
  for (const ip of shippedInstallPaths) {
    const parts = ip.split('/')
    for (let i = 1; i < parts.length; i += 1) dirs.add(`${parts.slice(0, i).join('/')}/`)
  }
  const files = new Set(shippedInstallPaths)
  return patterns.filter((p) => (p.endsWith('/') ? !dirs.has(p) : !files.has(p)))
}

// Pure core (unit-tested without git): given the template paths ADDED since the
// previous release, the parsed template/migrations.json, and an allowlist,
// return every addition that would be auto-planted as seeded/config content.
// Accepted path shapes: as git prints them ('template/base/…') or already
// template-relative ('base/…'); files directly under template/ (migrations.json
// itself) are packaging metadata and never install anywhere.
/**
 * The allowlist's own shape, judged (0.6.0).
 *
 * The header above says "an empty reason is a review reject" and until now NOTHING read the
 * field: `findUnregisteredSeededAdditions` maps the entries to `.file` and drops everything
 * else. The evidence that nobody was reading it is in the list itself — two entries had
 * drifted to a `why:` key, which is not the documented name and which no consumer would have
 * noticed either way. A reviewed escape whose review nothing checks is an unreviewed escape
 * with a longer entry.
 *
 * The length floor is the same instrument the ramp ledger and the mutation ratchet use: a
 * one-word reason is the shape a reason takes when the entry is being added to make a gate
 * stop complaining.
 */
export function plantAllowlistProblems(allowlist) {
  const problems = []
  const seen = new Set()
  for (const entry of allowlist) {
    const at = typeof entry?.file === 'string' ? entry.file : JSON.stringify(entry)
    if (typeof entry?.file !== 'string' || entry.file === '') {
      problems.push(
        `DELIBERATE_PLANT entry ${at} has no \`file\` — it can never match an addition.`,
      )
      continue
    }
    if (seen.has(entry.file)) {
      problems.push(`DELIBERATE_PLANT lists ${entry.file} twice — one of them is unreachable.`)
    }
    seen.add(entry.file)
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 40) {
      problems.push(
        `DELIBERATE_PLANT entry ${entry.file} carries no usable \`reason\` (the key is \`reason\`, not \`why\`, and it must say what the gate does when the file is ABSENT — that is the whole decision). Planting a file into every existing install is the act this list exists to make reviewable.`,
      )
    }
    problems.push(...subtreeEntryProblems(entry.file))
  }
  return problems
}

/**
 * A trailing-slash DELIBERATE_PLANT entry (0.9.5) approves a whole subtree, so it
 * carries two extra bars: it must name a real directory (a typo'd subtree approves
 * nothing while READING as approval), and it must not be a top-level tree, which
 * would pre-approve every future addition beneath it — the review this list exists
 * to force. Split out of plantAllowlistProblems for the harness's own ≤15
 * cognitive-complexity ratchet: the release that makes that ceiling unsuppressable
 * for consumers does not get to record an exemption for itself.
 * @param {string} file
 */
function subtreeEntryProblems(file) {
  if (!file.endsWith('/')) return []
  const problems = []
  if (!existsSync(join(ROOT, file))) {
    problems.push(
      `DELIBERATE_PLANT subtree entry ${file} names no directory in the template — a subtree that does not exist can never match, and a typo'd one silently approves nothing while reading as approval.`,
    )
  }
  if (file.replace(/\/$/, '').split('/').length < 3) {
    problems.push(
      `DELIBERATE_PLANT subtree entry ${file} is too broad — a top-level tree would pre-approve every future addition beneath it. Name the package or module subtree the decision actually covers.`,
    )
  }
  return problems
}

/**
 * `seededSourceFixes` records, judged (0.6.0).
 *
 * The key's whole purpose is to be an INSTRUCTION TO A HUMAN — nothing copies these files
 * into a real install, because the consumer owns them. That makes it the exact shape of
 * declaration that rots silently: the runbook prints the table, the sweep leg adopts the
 * paths, and if a path stops existing in the template both keep working while pointing at
 * nothing. `adopt()` in scripts/ci/upgrade-sweep.mjs returns quietly when the source is
 * missing, so a typo'd entry would make leg E adopt eight files instead of nine and the
 * ninth finding would come back as an unexplained failure two waves later.
 *
 * The `why` floor is the same instrument as DELIBERATE_PLANT's above, and for a stronger
 * reason: this record tells consumers to edit their own source, which is the largest thing
 * this repository ever asks of them.
 *
 * @param {object} migrations  parsed template/migrations.json
 * @param {string} root
 */
export function seededSourceFixProblems(migrations, root) {
  return Object.entries(migrations)
    .filter(([version]) => VERSION_KEY.test(version))
    .flatMap(([version, entry]) =>
      (entry.seededSourceFixes ?? []).flatMap((fix, i) =>
        oneSourceFixProblems(fix, `${version}.seededSourceFixes[${String(i)}]`, root),
      ),
    )
}

/**
 * One record's shape. Split out for the complexity bar the harness holds consumers to.
 * @param {{ paths?: string[], why?: string, gate?: string, probes?: object[] }} fix
 * @param {string} at
 * @param {string} root
 */
function oneSourceFixProblems(fix, at, root) {
  const problems = []
  if (typeof fix?.gate !== 'string' || fix.gate === '') {
    problems.push(
      `${at} names no \`gate\` — a consumer following this record needs to know which check reports the finding, and the record needs an owner that can go red.`,
    )
  }
  if (typeof fix?.why !== 'string' || fix.why.trim().length < 40) {
    problems.push(
      `${at} carries no usable \`why\`. This record asks a consumer to edit their OWN source; the reason is the whole of what makes that reviewable.`,
    )
  }
  const paths = fix?.paths ?? []
  if (paths.length === 0) {
    problems.push(`${at} lists no \`paths\` — a fix that names no file cannot be swept.`)
  }
  const missing = paths.filter(
    (rel) =>
      !['template/stack', 'template/base'].some((t) =>
        templateCandidates(rel).some((c) => existsSync(join(root, t, c))),
      ),
  )
  for (const rel of missing) {
    problems.push(
      `${at} names ${rel}, which is in neither template/stack nor template/base. The sweep's \`adopt()\` skips a missing source in SILENCE, so this entry would quietly stop being applied while the runbook kept telling consumers to apply it.`,
    )
  }
  // The probes are the record's RUNTIME half (0.7.0): `update` parks the set and `doctor`
  // warns only while a probe file exists and matches the recorded BROKEN shape, so a record
  // without probes raises nothing and a mis-aimed one parks an artifact nobody can clear.
  const probes = fix?.probes ?? []
  if (probes.length === 0) {
    problems.push(
      `${at} carries no \`probes\` — without a recorded BROKEN shape the runtime channel (\`update\`/\`doctor\`) can neither raise the obligation nor self-clear it. Describe the PRE-fix shape: probes: [{ path, brokenWhen: { contains } | { lacks } }].`,
    )
  }
  for (const [i, probe] of probes.entries()) {
    problems.push(...oneProbeProblems(probe, `${at}.probes[${String(i)}]`, paths, root))
  }
  return problems
}

/**
 * One probe's shape, judged against the record's own paths AND the current template copy.
 * The template ships FIXED, so an honest probe — one describing the PRE-fix broken shape —
 * must NOT match it: a probe that does would hold the parked obligation open on every
 * install that already took the fix, and the channel could never self-clear.
 * @param {{ path?: string, brokenWhen?: { contains?: string, lacks?: string } }} probe
 * @param {string} at
 * @param {string[]} paths
 * @param {string} root
 */
function oneProbeProblems(probe, at, paths, root) {
  const problems = []
  const rel = typeof probe?.path === 'string' ? probe.path : ''
  if (!paths.includes(rel)) {
    problems.push(
      `${at} names ${rel === '' ? '(no path)' : rel}, which is not in the record's own \`paths\` — a probe must sample the fix set it judges.`,
    )
  }
  const shipped = ['template/stack', 'template/base']
    .flatMap((t) => templateCandidates(rel).map((c) => join(root, t, c)))
    .find((p) => rel !== '' && existsSync(p))
  if (shipped === undefined) {
    problems.push(
      `${at} names ${rel === '' ? '(no path)' : rel}, which is in neither template/stack nor template/base — a probe over a file the template does not ship judges nothing.`,
    )
  }
  const brokenWhen = probe?.brokenWhen ?? {}
  const predicates = ['contains', 'lacks'].filter(
    (k) => typeof brokenWhen[k] === 'string' && brokenWhen[k] !== '',
  )
  if (predicates.length !== 1 || Object.keys(brokenWhen).length !== 1) {
    problems.push(
      `${at} must carry exactly one of \`contains\` or \`lacks\` as a non-empty string — \`brokenWhen\` is a single decidable predicate, not a rule language, and installer/lib/migrations.mjs reads a malformed one as NOT broken.`,
    )
  } else if (shipped !== undefined && probeMatchesBroken(readFileSync(shipped, 'utf8'), brokenWhen)) {
    problems.push(
      `${at} (${rel}): the recorded BROKEN shape matches the CURRENT template copy, which ships FIXED — this probe would hold the obligation open on every install that already took the fix, and the parked artifact could never self-clear. Probes describe the PRE-fix shape.`,
    )
  }
  return problems
}

export function findUnregisteredSeededAdditions({
  addedTemplatePaths,
  migrations,
  allowlist = [],
}) {
  const patterns = seedOnInitOnlyPatterns(migrations)
  const allowed = new Set(allowlist.map((a) => a.file))
  const violations = []
  for (const raw of addedTemplatePaths) {
    const p = raw.replace(/^template\//, '')
    // Which storage tree? base/ and stack/ strip one segment; modules/<name>/
    // strips two (module files install for every consumer with the module
    // enabled — the auto-plant hazard is identical there).
    let treeRel = null
    if (p.startsWith('base/')) treeRel = p.slice('base/'.length)
    else if (p.startsWith('stack/')) treeRel = p.slice('stack/'.length)
    else if (p.startsWith('modules/')) treeRel = p.split('/').slice(2).join('/')
    if (!treeRel) continue
    const installPath = storageToInstall(treeRel)
    const mode = fileMode(installPath)
    if (mode === 'owned') continue // owned files are update's job to plant — that is the product
    if (matchSeedOnInitOnly(installPath, patterns)) continue // registered: update withholds it
    // Reviewed deliberate plant: an exact path, or a trailing-slash SUBTREE entry
    // (0.9.5). The subtree form exists for a module whose package moves as a unit —
    // listing its files one by one means the next file added to that package
    // silently misses the review this list exists to force.
    if (allowed.has(raw)) continue
    if ([...allowed].some((a) => a.endsWith('/') && raw.startsWith(a))) continue
    violations.push({ templatePath: raw, installPath, mode })
  }
  return violations
}

// CLI wrapper — only when executed directly, so the tests can import the pure
// core without spawning git.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const git = (args) =>
    execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  // Grounding first — it needs no git, and a pattern that names nothing is wrong
  // whether or not there is a previous release to diff against.
  const migrations = readTemplateMigrations()
  const trees = ['base', 'stack']
  for (const name of readdirSync(join(ROOT, 'template', 'modules')).sort()) {
    trees.push(`modules/${name}`)
  }
  const shipped = trees.flatMap((t) => walkTemplate(t)).map((e) => e.installPath)
  const ungrounded = findUngroundedPatterns({
    patterns: seedOnInitOnlyPatterns(migrations),
    shippedInstallPaths: shipped,
  })
  if (ungrounded.length > 0) {
    console.error(
      `SEEDED-MIGRATIONS: FAIL (${ungrounded.length}) — seedOnInitOnly pattern(s) in template/migrations.json name nothing the template ships:`,
    )
    for (const p of ungrounded) {
      console.error(
        `  - ${JSON.stringify(p)} — ${p.endsWith('/') ? 'no shipped file installs under this directory' : 'no shipped file installs to this exact path'}`,
      )
    }
    console.error(
      '  why: the field is read by a prefix/exact matcher, so a typo, a path left behind by a rename, or a comment string added to the array withholds NOTHING while reading as protection — and `update` plants the file the entry was meant to hold back. Fix the pattern or delete it.',
    )
    process.exit(1)
  }

  let prev = process.env.PREVIOUS_RELEASE_TAG || null
  if (prev === null) {
    try {
      // STRICTLY BELOW this tree's own version, never `git describe --tags --abbrev=0`.
      // Through 0.10.0 this was the describe form, and it is the v0.6.0 self-predecessor
      // class surviving in its FOURTH copy: on a release commit the nearest reachable tag
      // IS the tag being cut, so the gate diffed the release against its own tree, found no
      // seeded addition by construction, and passed vacuously — green through development
      // and green forever after tagging, which is the one shape this gate exists to refuse.
      // check-ramp-ledger.mjs and check-dependency-channel.mjs already resolve it this way;
      // `highestReleaseBelow` is the single home for the rule.
      prev = highestReleaseBelow(git(['tag', '--list', 'v*.*.*']).split('\n'), VERSION)
    } catch {
      // fall through to the reachability failure below with prev still null
    }
  }
  // No tag resolved. Two very different situations hide behind that, and only
  // one of them is safe to skip:
  //   - a COMPLETE clone carrying zero tags has genuinely never been released
  //     (this repo before its first tag; any fresh "Use this template" copy).
  //     There is no previous release to diff against, so the check is vacuous
  //     rather than failing — skip LOUDLY.
  //   - a SHALLOW clone cannot tell "no releases" from "tags not fetched", so
  //     it keeps failing closed. Diffing against nothing would pass vacuously,
  //     which is the exact false green this gate exists to prevent.
  if (prev === null) {
    const shallow = (() => {
      try {
        return git(['rev-parse', '--is-shallow-repository']).trim() === 'true'
      } catch {
        return true // cannot establish completeness -> treat as shallow -> fail closed
      }
    })()
    let tagCount = 0
    try {
      tagCount = git(['tag', '--list']).split('\n').filter(Boolean).length
    } catch {
      /* leave at 0; the shallow branch below decides */
    }
    if (!shallow && tagCount === 0) {
      console.log(
        'SEEDED-MIGRATIONS: SKIP — this clone is complete and carries no tags, so there is no ' +
          'previous release to diff against. Expected before the first release and in a fresh ' +
          'template copy; the check engages on its own from the next release onward.',
      )
      process.exit(0)
    }
    console.error(
      'SEEDED-MIGRATIONS: FAIL — no previous release tag in this clone, and it is ' +
        `${shallow ? 'SHALLOW' : 'carrying tags that did not resolve'} — "no releases yet" cannot be ` +
        'distinguished from "tags were never fetched". Fetch tags first (`git fetch --tags`; in CI ' +
        'check out with fetch-depth: 0) or set PREVIOUS_RELEASE_TAG.',
    )
    process.exit(1)
  }
  try {
    git(['rev-parse', '--verify', `${prev}^{commit}`])
  } catch {
    console.error(
      `SEEDED-MIGRATIONS: FAIL — previous release tag '${prev}' is not reachable in this clone. ` +
        'Fetch tags first (`git fetch --tags`; in CI check out with fetch-depth: 0) or set PREVIOUS_RELEASE_TAG.',
    )
    process.exit(1)
  }

  // THREE SOURCES, NOT ONE (0.6.0). `prev..HEAD` sees only what is COMMITTED, and the
  // release being cut is by definition the one that is not committed yet. Through the whole
  // of 0.6.0 this gate reported `0 template file(s) added since v0.5.0` while a dozen new
  // template files sat untracked in the working tree — a CLEAN that reads as a finding and
  // is a vacuum. It would have corrected itself in CI, on a branch where everything is
  // committed, which is precisely the asymmetry that makes it dangerous: the maintainer
  // deciding plant-vs-withhold is the one running it locally, and they were told there was
  // nothing to decide.
  //
  // Staged and untracked are unioned in so the check judges the tree in front of you.
  // `--exclude-standard` keeps .gitignore'd paths out — a build artifact under template/ is
  // not a seeded addition.
  // SOURCE: docs/runbooks/harness-upgrade.md (the plant-or-withhold decision is per release)
  const lines = (args) =>
    git(args)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  const added = [
    ...new Set([
      ...lines(['diff', '--name-only', '--diff-filter=A', `${prev}..HEAD`, '--', 'template/']),
      ...lines(['diff', '--name-only', '--diff-filter=A', '--cached', '--', 'template/']),
      ...lines(['ls-files', '--others', '--exclude-standard', '--', 'template/']),
    ]),
  ].sort()

  // The allowlist's own shape first, because it is the thing the additions are judged
  // AGAINST: a malformed entry silently forgives whatever it names.
  const allowlistProblems = plantAllowlistProblems(DELIBERATE_PLANT)
  if (allowlistProblems.length > 0) {
    console.error(
      `SEEDED-MIGRATIONS: FAIL (${allowlistProblems.length}) — the DELIBERATE_PLANT allowlist is malformed:`,
    )
    for (const p of allowlistProblems) console.error(`  - ${p}`)
    process.exit(1)
  }

  // The other half of the plant-or-withhold decision: files the harness AUTHORED, a
  // release CORRECTED, and `update` cannot deliver because the consumer owns them.
  const fixProblems = seededSourceFixProblems(migrations, ROOT)
  if (fixProblems.length > 0) {
    console.error(
      `SEEDED-MIGRATIONS: FAIL (${fixProblems.length}) — a seededSourceFixes record is malformed:`,
    )
    for (const p of fixProblems) console.error(`  - ${p}`)
    process.exit(1)
  }

  const violations = findUnregisteredSeededAdditions({
    addedTemplatePaths: added,
    migrations,
    allowlist: DELIBERATE_PLANT,
  })

  if (violations.length > 0) {
    console.error(
      `SEEDED-MIGRATIONS: FAIL (${violations.length}) — template file(s) added since ${prev} install as seeded/config content but are not registered seedOnInitOnly:`,
    )
    for (const v of violations) {
      console.error(
        `  - ${v.templatePath} installs to ${v.installPath} (mode: ${v.mode}) — add "${v.installPath}" ` +
          '(or a covering "<dir>/" subtree pattern) to the CURRENT release version\'s seedOnInitOnly in template/migrations.json, ' +
          'or record it in DELIBERATE_PLANT (scripts/check-seeded-migrations.mjs) with a reason',
      )
    }
    console.error(
      '  why: `update` auto-plants unregistered absent seeded files into EXISTING installs, and an unreferenced exemplar reds route-manifest + dead-code on their next validate.',
    )
    process.exit(1)
  }
  // The seededSourceFixes count is printed rather than merely checked: it is a set that
  // SHRINKS to nothing in most releases, and a silently-empty closure reads identically to
  // a closure that had something to say.
  const fixPaths = Object.entries(migrations)
    .filter(([v]) => VERSION_KEY.test(v))
    .flatMap(([, e]) => (e.seededSourceFixes ?? []).flatMap((f) => f.paths ?? []))
  console.log(
    `SEEDED-MIGRATIONS: CLEAN (${added.length} template file(s) added since ${prev}; every seeded/config addition is registered seedOnInitOnly or a reviewed deliberate plant; ${fixPaths.length} seededSourceFixes path(s) resolve in the template)`,
  )
}
