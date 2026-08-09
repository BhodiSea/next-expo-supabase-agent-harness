#!/usr/bin/env node
// check-dependency-channel — a dependency a harness-OWNED config needs must have a CHANNEL
// to an existing install, not only to a fresh scaffold.
//
// THE DEFECT, in template/migrations.json's own 0.4.0 words: eslint.config.mjs is
// harness-OWNED so `update` refreshes it, but pnpm-workspace.yaml and package.json are
// SEEDED and the catalog merge runs only under `init`. So 0.4.0 shipped a config importing
// `eslint-plugin-jsx-a11y` against a pin that reached fresh scaffolds and no upgraded tree:
// eslint died before linting a file. Not one rule lost — the whole `lint` step.
//
// THE RULE, and the reason it is a DELTA rather than an absolute. Every install carries
// whatever catalog its own `init` wrote, so a package that has been in the catalog since
// before the previous release is already on every supported tree and needs no channel.
// What needs a channel is what the catalog GAINED. Comparing the working tree's catalog
// against the previous release tag's is therefore the exact question — and it is also why
// this cannot be answered from the tree alone.
//
// SKIP-LOUDLY / FAIL-CLOSED, the harness's own toolchain asymmetry, applied to git history:
// `machinery-lint` checks out at the runner's default depth, and a verdict that depends on
// clone depth is a verdict that passes for the wrong reason. Without the tag this SKIPS and
// says so; in CI (CI=true) the same condition FAILS. The lint job sets fetch-depth: 0.
// SOURCE: template/migrations.json (the 0.4.0 record states the hole in its own words)
//   usage: node scripts/check-dependency-channel.mjs [repo-root]
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { highestReleaseBelow } from './lib/ramp-sites.mjs'

// With a repo-root argument it judges THAT tree — files AND git history, so the red-proof
// (tests/gates/check-dependency-channel.test.mjs) can present a tagged fixture repo.
const ROOT = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('..', import.meta.url))
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const git = (args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const inCI = () => process.env.CI === 'true' || process.env.HARNESS_REQUIRE_TOOLCHAINS === '1'

const version = JSON.parse(read('package.json')).version
const migrations = JSON.parse(read('template/migrations.json'))
const workspaceYaml = read('template/base/pnpm-workspace.yaml')

// Harness-OWNED config that carries external dependencies. Owned means `update` refreshes
// it, which is exactly what makes its imports dangerous: the file lands on an upgraded
// install, its dependency does not. Seeded files cannot introduce this class of break,
// because `update` never rewrites them.
const OWNED_CONFIG = ['eslint.config.mjs', 'vitest.config.ts', 'stryker.config.mjs']

// Catalog keys, as a set. A two-space-indented `name:` under the catalog block.
const catalogKeys = (yaml) =>
  new Set([...yaml.matchAll(/^ {2}'?([@a-z0-9][@a-z0-9/.-]*)'?\s*:/gm)].map((m) => m[1]))

// PREVIOUS RELEASE TAG: the highest v*.*.* tag STRICTLY BELOW this tree's own version —
// `highestReleaseBelow`'s docblock owns the reason. The `.at(-1)` shape this replaces was
// the v0.6.0 hotfix class surviving here: on a release commit the highest tag IS the tag
// being cut, so the gate diffed the release against its own tree and the catalog delta was
// empty by construction. Same rule, one home (mirrors check-ramp-ledger.mjs).
function previousTag(current) {
  try {
    return highestReleaseBelow(git(['tag', '--list', 'v*.*.*']).split('\n'), current)
  } catch {
    return null
  }
}

const problems = []
const tag = previousTag(version)

if (tag === null) {
  const msg =
    'no v*.*.* tag reachable — the catalog delta cannot be computed. This needs full history (fetch-depth: 0).'
  if (inCI()) {
    console.error(`DEPENDENCY CHANNEL: FAIL — ${msg} (skips are not allowed in CI)`)
    process.exit(1)
  }
  console.log(`DEPENDENCY CHANNEL: SKIPPED — ${msg} (this check FAILS CLOSED in CI)`)
  process.exit(0)
}

let previousYaml
try {
  previousYaml = git(['show', `${tag}:template/base/pnpm-workspace.yaml`])
} catch {
  const msg = `\`git show ${tag}:template/base/pnpm-workspace.yaml\` failed — shallow clone or missing tag object.`
  if (inCI()) {
    console.error(`DEPENDENCY CHANNEL: FAIL — ${msg} (skips are not allowed in CI)`)
    process.exit(1)
  }
  console.log(`DEPENDENCY CHANNEL: SKIPPED — ${msg} (this check FAILS CLOSED in CI)`)
  process.exit(0)
}

const before = catalogKeys(previousYaml)
const now = catalogKeys(workspaceYaml)
const added = [...now].filter((k) => !before.has(k)).sort()

if (now.size < 20) {
  problems.push(
    `only ${String(now.size)} catalog key(s) parsed from template/base/pnpm-workspace.yaml — the catalog scanner is not matching, so this closure is vacuous`,
  )
}

// Which packages the owned configs actually reference. Static AND dynamic: 0.4.0's fix for
// the jsx-a11y break was to resolve it with `await import(...)`, so an import-statement-only
// scanner would miss the very package this check exists for.
const REF_RE =
  /(?:^|\n)\s*import\s[^'"]*?['"]([^'"]+)['"]|(?:await\s+)?import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g
const referenced = new Set()
let scanned = 0
for (const file of OWNED_CONFIG) {
  let src
  try {
    src = read(`template/base/${file}`)
  } catch {
    continue
  }
  scanned += 1
  for (const m of src.matchAll(REF_RE)) {
    const spec = m[1] ?? m[2] ?? m[3]
    if (spec.startsWith('node:') || spec.startsWith('.') || spec.startsWith('@app/')) continue
    referenced.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])
  }
}
if (scanned === 0) problems.push('no owned config found under template/base/ — the scan root is wrong')
if (referenced.size < 3) {
  problems.push(
    `only ${String(referenced.size)} external reference(s) across ${String(scanned)} owned config(s) — the reference scanner is not matching, so this closure is vacuous`,
  )
}

const obligated = new Map(
  Object.entries(migrations)
    .filter(([v]) => /^\d+\.\d+\.\d+/.test(v))
    .flatMap(([v, e]) => (e.dependencyObligations ?? []).map((o) => [o.name, { ...o, since: v }])),
)

// 1. A catalog key ADDED since the previous tag, and referenced by owned config, needs an
//    obligation — that is the class that reaches fresh installs only.
for (const pkg of added) {
  if (!referenced.has(pkg)) continue
  if (!obligated.has(pkg)) {
    problems.push(
      `template/base/pnpm-workspace.yaml gained \`${pkg}\` since ${tag} and a harness-owned config references it, but no dependencyObligations record carries it. A fresh \`init\` resolves it; every upgraded install does not, because pnpm-workspace.yaml is SEEDED. Add a record under this release.`,
    )
  }
}

// 2. KNOWN HISTORICAL GAPS. Packages that entered the catalog in an earlier release and
//    never had a channel, so installs from before that release still lack them. Reviewed
//    data rather than a computed sweep: this release closes the one that is proven broken
//    (0.4.0's jsx-a11y, which killed the whole lint step on every upgraded tree). A full
//    retroactive sweep back to the 0.1.3 floor is real and is NOT this release's scope —
//    saying so here is what stops the omission being silent.
const KNOWN_HISTORICAL_GAPS = new Map([
  [
    'eslint-plugin-jsx-a11y',
    'entered the catalog in 0.4.0. eslint.config.mjs resolves it dynamically and applies every rule at error over apps/web; without the pin the web a11y floor enforces nothing and check-wiring reds once its 0.4.0 ramp expires in 0.5.0.',
  ],
])
for (const [pkg, why] of KNOWN_HISTORICAL_GAPS) {
  if (!referenced.has(pkg)) {
    problems.push(
      `KNOWN_HISTORICAL_GAPS names \`${pkg}\`, which no harness-owned config references any more — a stale entry. Remove it. (${why})`,
    )
  } else if (!obligated.has(pkg)) {
    problems.push(
      `\`${pkg}\` is a known historical gap with no dependencyObligations record: ${why}`,
    )
  }
}

// 3. The inverse: an obligation naming a package nothing references is a stale record, and
//    a stale record asks every consumer to install something the harness no longer uses.
for (const [name, o] of obligated) {
  if (!referenced.has(name)) {
    problems.push(
      `template/migrations.json ${o.since} carries a dependencyObligations record for \`${name}\`, but no harness-owned config under template/base/ references it — a stale obligation.`,
    )
  }
  if (!now.has(name)) {
    problems.push(
      `dependencyObligations names \`${name}\` but the template's own catalog does not pin it — a fresh scaffold would be broken too, which is a packaging bug rather than an upgrade one.`,
    )
  }
}

// 4. Well-formedness: `update` builds its report line and doctor its error from these.
for (const [v, entry] of Object.entries(migrations)) {
  if (!/^\d+\.\d+\.\d+/.test(v)) continue
  for (const o of entry.dependencyObligations ?? []) {
    for (const field of ['name', 'catalog', 'why']) {
      if (typeof o?.[field] !== 'string' || o[field].length === 0) {
        problems.push(`template/migrations.json ${v}: an obligation is missing a non-empty \`${field}\``)
      }
    }
    if (typeof o?.why === 'string' && o.why.length < 40) {
      problems.push(
        `template/migrations.json ${v} obligation \`${o.name}\`: \`why\` is ${String(o.why.length)} chars — it is the only thing telling a consumer why they must edit a seeded manifest.`,
      )
    }
  }
}

if (problems.length > 0) {
  console.error(`DEPENDENCY CHANNEL: ${String(problems.length)} problem(s):`)
  for (const p of problems) console.error(`  - ${p}`)
  console.error(
    '\n`update` refreshes harness-owned config and never writes a seeded manifest. A dependency reaching only fresh installs is a gate that silently stops enforcing on every upgraded one.',
  )
  process.exit(1)
}

console.log(
  `DEPENDENCY CHANNEL: CLEAN (vs ${tag}: ${String(added.length)} catalog addition(s), ${String(referenced.size)} reference(s) across ${String(scanned)} owned config(s), ${String(obligated.size)} obligation(s))`,
)
