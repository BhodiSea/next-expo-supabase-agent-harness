#!/usr/bin/env node
// THE SWEEP: adopt a release's new seams in an upgraded install, the way its runbook says to.
//
// WHY THIS EXISTS. `graduate` has two branches and only one has ever been executed. Every
// upgrade-lane leg ends with it REFUSING, because an upgraded install always has ramped
// findings outstanding — that is what a ramp is for. The SUCCESS branch is the one that moves
// `baseVersion` in .harness/manifest.json and arms every ramped check at once, and through
// 0.5.0 nothing anywhere had run it. A door nobody has opened is not a door you know opens.
//
// So this performs the sweep a consumer performs, and the lane then requires graduate to
// succeed. That makes the leg a proof of TWO things at once: that graduate opens, and that
// the sweep documented in docs/runbooks/harness-upgrade.md is sufficient — a runbook whose
// steps do not actually clear the findings is worse than no runbook, and nothing else in this
// repository would notice.
//
// WHAT IS DELIBERATELY NOT DONE HERE: re-running `init`, or copying the template wholesale.
// Either would clear the findings while proving nothing about which seams a release actually
// requires, and would make this leg vacuous the moment a release added a gate it did not also
// hand the consumer a file for.
//
// THE FILE LIST IS DERIVED, not written. `seedOnInitOnly` in template/migrations.json is the
// set a release deliberately WITHHELD from `update` — files whose planting would red a gate
// on an install that never asked for them. That is exactly the set a consumer must adopt by
// hand, so the same data that withholds them names the sweep.
//   usage: node scripts/ci/upgrade-sweep.mjs <installDir> <repoRoot> <headVersion>
// SOURCE: docs/runbooks/harness-upgrade.md (the sweep this executes)
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const [installDir, repoRoot, headVersion] = process.argv.slice(2)
if (installDir === undefined || repoRoot === undefined || headVersion === undefined) {
  process.stderr.write('usage: upgrade-sweep.mjs <installDir> <repoRoot> <headVersion>\n')
  process.exit(2)
}

const done = []
const TEMPLATE_ROOTS = ['template/stack', 'template/base']

/** Where in the template a given install-relative path lives, or null. */
function sourceOf(rel) {
  for (const root of TEMPLATE_ROOTS) {
    const p = join(repoRoot, root, rel)
    if (existsSync(p)) return p
  }
  return null
}

/** Copy one file, or every file under it when the pattern names a directory. */
function adopt(rel) {
  const src = sourceOf(rel)
  if (src === null) return
  const isDir = rel.endsWith('/')
  if (!isDir) {
    const dest = join(installDir, rel)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(src, dest)
    done.push(rel)
    return
  }
  const walk = (dir, prefix) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) walk(join(dir, e.name), `${prefix}${e.name}/`)
      else adopt(`${prefix}${e.name}`)
    }
  }
  walk(src, rel)
}

// ── 1. every seam this release withheld ──────────────────────────────────────────
const migrations = JSON.parse(readFileSync(join(repoRoot, 'template/migrations.json'), 'utf8'))
for (const rel of migrations[headVersion]?.seedOnInitOnly ?? []) adopt(rel)

// ── 1b. the page bodies that RENDER what the new meta files declare ──────────────
// A `page.meta.ts` declares state test ids; the route-manifest gate requires the page to
// actually RENDER them, because a declared-but-unrendered state is a claim nothing checks.
// On a fresh scaffold both ship together. On an UPGRADE only the meta file is delivered —
// the page body is seeded (0.2.0) and belongs to the consumer — so adopting the seam without
// touching the page leaves a finding the seam itself created.
//
// That is a real consumer obligation, and docs/runbooks/harness-upgrade.md now states it:
// when you adopt a page.meta.ts, render its ids (`data-testid={meta.states.<key>}`). Copying
// HEAD's page here MODELS that edit, and is only honest because the lane's install is a
// pristine scaffold with zero local drift. A real consumer edits their own page; they must
// never copy these, which is why the list is explicit rather than a glob over app/.
for (const rel of ['apps/web/app/(protected)/o/page.tsx']) adopt(rel)

// ── 1c. the seeded source this release CORRECTED ─────────────────────────────────
// `seedOnInitOnly` is the set a release withheld. This is its opposite number: seeded files
// the harness AUTHORED and this release FIXED, where `update` cannot deliver the fix because
// the consumer owns the file. 0.6.0's is the web session handoff — the browser client wrote
// its session to localStorage while every server render read the cookie jar, so a correct
// sign-in bounced straight back to /sign-in. An upgraded install keeps that break, and until
// leg E ran, the only thing that said so was a ramped NOTE with no runbook step behind it.
//
// Copying here MODELS the human edit, on the same terms as §1b: honest only because the
// lane's install is a pristine scaffold with zero local drift. A real consumer applies the
// change the gate names in their own file — the runbook says so, and says why the nine move
// as one set (a browser client cannot take a storage adapter the platform package does not
// export).
for (const fix of migrations[headVersion]?.seededSourceFixes ?? []) {
  for (const rel of fix.paths ?? []) adopt(rel)
}

// ── 2. the auth posture, renamed in place ────────────────────────────────────────
// NOT a copy of the template's config.toml: that file carries rendered placeholders, and
// overwriting a consumer's Supabase configuration to satisfy a section-name check would be a
// far larger act than the finding calls for. The finding is that the CLI RENAMED a section
// (`[inbucket]` → `[local_smtp]`) and warns rather than erroring, which is how a deprecated
// section sat in the shipped config with nothing reading the warning. Renaming it in place is
// the sweep, and it is what the runbook tells a human to do.
const configPath = join(installDir, 'supabase/config.toml')
if (existsSync(configPath)) {
  const before = readFileSync(configPath, 'utf8')
  const after = before.replace(/^\[inbucket\]$/m, '[local_smtp]')
  if (after !== before) {
    writeFileSync(configPath, after)
    done.push('supabase/config.toml ([inbucket] → [local_smtp])')
  }
}

// ── 3. AGENTS.md's gate list, from the install's OWN chain ───────────────────────
// AGENTS.md is seeded and carries per-project rendering, so it is rewritten rather than
// copied. The gate's own failure text prescribes exactly this — "paste the N names above into
// AGENTS.md's gate-list sentence and the N-step chain line" — so executing it here is what
// proves that instruction is sufficient rather than merely plausible.
const agentsPath = join(installDir, 'AGENTS.md')
const configUrl = pathToFileURL(join(installDir, 'tools/harness.config.mjs')).href
const { VALIDATE_STEPS } = await import(configUrl)
const names = VALIDATE_STEPS.map(([n]) => n)
if (existsSync(agentsPath)) {
  const before = readFileSync(agentsPath, 'utf8')
  const after = before
    .replace(/The \d+ gates, in order:[\s\S]*?\n {2}\(docs\/harness\/gates-catalog\.md/, () => {
      const wrapped = names.map((n) => `\`${n}\``).join(', ')
      return `The ${String(names.length)} gates, in order: ${wrapped}\n${'  '}(docs/harness/gates-catalog.md`
    })
    .replace(/the \d+-step chain/g, `the ${String(names.length)}-step chain`)
    .replace(/The \d+ gates,/, `The ${String(names.length)} gates,`)
  if (after !== before) {
    writeFileSync(agentsPath, after)
    done.push(`AGENTS.md (gate list + counts → ${String(names.length)})`)
  }
}

if (done.length === 0) {
  process.stderr.write(
    'upgrade-sweep: nothing to adopt. Either this release withheld no seams and changed no posture, or the sweep no longer matches what the ramps report — and a sweep that clears nothing cannot prove graduate opens.\n',
  )
  process.exit(1)
}
process.stdout.write(`upgrade-sweep: adopted ${String(done.length)} item(s)\n`)
for (const d of done) process.stdout.write(`  ${d}\n`)
