#!/usr/bin/env node
// check-claims (G12) — the harness's own quantitative claims must be TRUE and must not
// contradict each other. The README and CHANGELOG hand-author numbers ("21 gates",
// "cold ≈ 70 s"), and nothing recomputed them: the source harness's v0.1.5 shipped with
// the README claiming cold ≈70 s / warm ≈5 s while the CHANGELOG claimed ≈85 s / ≈6 s
// for the SAME release. A harness whose headline is "prove, don't claim" cannot ship
// unverified claims.
//
// Two classes of check:
//   1. DERIVABLE — recompute from the source of truth and assert the prose matches
//      (chain length, canary steps, guard-rule ids). A drifted count is a hard error.
//   2. CONSISTENT — wall-clock timings are hardware-dependent, so no gate can assert
//      they are true. What IS checkable is that the two documents describing the same
//      release do not CONTRADICT each other — which is exactly the defect found.
//
// Run by the repo's own CI (hygiene lane) and `pnpm test`.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { hasCommittedMeasurement } from './lib/chain-budget.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')

// SOFT-WRAP NORMALISATION, and it is not cosmetic: it is the fix for a claim that went
// stale IN THE SENTENCE THAT CLAIMS IT IS DERIVED. The README said "the 26 can-fail
// canaries (counted from the matrix itself, not hand-authored)" while the matrix declared
// 29, and this script passed — because markdown soft-wrapped the phrase as
// `26 can-fail\n> canaries`, and every matcher below is written against a CONTIGUOUS
// phrase. A prose file wraps where the column runs out, which is a place no author picks
// and no reviewer sees; a matcher that depends on it is a matcher that silently stops
// asking. Collapsing a newline plus its blockquote marker and indent into ONE space makes
// the matchers read the sentence a human reads. Byte offsets are not preserved and nothing
// here needs them — every consumer below matches phrases, never positions.
const unwrap = (s) => s.replace(/\n[ \t]*>?[ \t]*/g, ' ')

const readme = unwrap(read('../README.md'))
const changelog = unwrap(read('../CHANGELOG.md'))
const chainBudget = JSON.parse(read('./chain-budget.json'))

const { VALIDATE_STEPS } = await import(
  new URL('../template/base/tools/harness.config.mjs', import.meta.url).href
)
const guards = await import(
  new URL('../template/base/.claude/hooks/lib/guard-rules.mjs', import.meta.url).href
)
// The canary registry ships with the W5b test wave — until it lands, the canary-count
// class is SKIPPED (loudly, below), never crashed on and never silently passed.
const injectionsPath = new URL('../tests/canary/injections.json', import.meta.url)
const injections = existsSync(injectionsPath)
  ? JSON.parse(readFileSync(injectionsPath, 'utf8'))
  : null

// DERIVED, not enumerated. A hardcoded table list is how the claim silently stops
// being a claim about all the rules: adding WRITE_SQL_CHECKS to the guard module and
// to the hooks left this file counting the old three tables, so the README's number
// stayed "true" while covering only part of the surface it named. Every array export
// whose entries carry a string `id` is a rule table by construction.
const ruleIds = Object.values(guards)
  .filter((v) => Array.isArray(v) && v.length > 0 && typeof v[0]?.id === 'string')
  .flatMap((table) => table.map((r) => r.id))

// ── DERIVED (0.3.0): the EXECUTED canary count, read off the selftest matrix ─────
// The README's "N can-fail canaries" was hand-authored, so it drifted the moment a leg
// was added or renamed — and it is the one number a reader uses to decide how much of
// this repo's enforcement has actually been watched going red. It is now counted from
// the workflow itself: every step whose title matches `Canary <n>: …`, across the
// selftest workflow AND every scripts/ci/* helper that workflow invokes (the emulator
// legs live in bash files, because the emulator-runner action execs its script under
// dash). A leg deleted from a helper drops the count exactly as a deleted workflow step
// would.
const selftestPath = new URL('../.github/workflows/selftest.yml', import.meta.url)
const selftestText = existsSync(selftestPath) ? readFileSync(selftestPath, 'utf8') : ''
const ciHelperText = [
  ...new Set([...selftestText.matchAll(/scripts\/ci\/[A-Za-z0-9._-]+/g)].map((m) => m[0])),
]
  .map((p) => {
    const url = new URL(`../${p}`, import.meta.url)
    return existsSync(url) ? readFileSync(url, 'utf8') : ''
  })
  .join('\n')
const canaryNumbers = new Set(
  [...`${selftestText}\n${ciHelperText}`.matchAll(/\bCanary (\d+):/g)].map((m) => m[1]),
)

// ── DERIVED (0.3.0): the gates-catalog's own opening chain count ─────────────────
// The catalog opened with "the 26-step VALIDATE_STEPS chain" against a 29-step chain,
// live, for two releases — in the very document whose job is to describe that chain, and
// the one place a reader goes to find out how long it is. docs-sync holds the catalog's
// SECTIONS in lockstep with the steps; nothing held its prose.
const catalogPath = new URL('../template/base/docs/harness/gates-catalog.md', import.meta.url)
const catalogText = existsSync(catalogPath) ? readFileSync(catalogPath, 'utf8') : ''

// The SHIPPED doctrine and the runner's own header. Both state the chain length in prose a
// consumer reads, and until 0.4.0 both said "21" while the chain was 31 — for three
// releases, in files installed into every project. Nothing looked: this script scanned the
// factory's README/CHANGELOG and the gates-catalog opener, and check-docs-sync.mjs covers
// AGENTS.md's sentence and the catalog SECTIONS. The gap was the doctrine itself.
const doctrinePath = new URL('../template/base/docs/harness/README.md', import.meta.url)
const doctrineText = existsSync(doctrinePath) ? readFileSync(doctrinePath, 'utf8') : ''
const runnerPath = new URL('../template/base/tools/validate.mjs', import.meta.url)
const runnerText = existsSync(runnerPath) ? readFileSync(runnerPath, 'utf8') : ''

// ── DERIVED (0.6.0): how many hooks are actually shipped ────────────────────────
// 0.5.0 wired six; 0.6.0's process layer added a seventh (SubagentStop), and the number
// stayed "six" in the root README twice and in the shipped doctrine's own hook table —
// which also silently lost a row. Every other count in this file was derived years before
// this one, and the reason it was not is instructive: nobody thinks of "six hooks" as a
// derived figure until it is wrong. Top-level `.mjs` only; `lib/` holds modules, and
// nothing wires a module.
const hooksDirUrl = new URL('../template/base/.claude/hooks/', import.meta.url)
const shippedHooks = existsSync(hooksDirUrl)
  ? readdirSync(hooksDirUrl)
      .sort()
      .filter((f) => f.endsWith('.mjs'))
  : []

// ── DERIVED (0.7.0): CONTRIBUTING.md — the one document where a derived number survived ──
// unchecked. It told a release-cutter "--report-all runs all **31** steps" against a 33-step
// chain and "the **six** HARNESS_HOOK_VERSION stamps" against seven shipped hooks — in the
// exact file whose Local-development section warns that running a stale subset is how four
// checks came to be red at once. Guarded like every other input: the fixture tests run a
// byte-identical copy in a mirrored tree that need not model this file.
const contributingPath = new URL('../CONTRIBUTING.md', import.meta.url)
const contributingText = existsSync(contributingPath)
  ? readFileSync(contributingPath, 'utf8')
  : ''
const contributing = unwrap(contributingText)
// The "Local development" section, cut from the RAW text (unwrap erases the heading
// structure the boundaries live on; a command in a code block never soft-wraps mid-token).
const localDevSection = (() => {
  const m = contributingText.match(/^## Local development\b.*$/m)
  if (!m) return ''
  const start = (m.index ?? 0) + m[0].length
  const rest = contributingText.slice(start)
  const next = rest.search(/^## /m)
  return next === -1 ? rest : rest.slice(0, next)
})()
// The lint workflow's blocking `node scripts/check-*.mjs` steps, DERIVED from the workflow
// file — a hand-typed list here would drift exactly the way the list it polices did. Steps
// marked continue-on-error: true are advisory, not blocking, and must not impose themselves
// on the local list, so the text is split into per-step blocks before matching.
const lintYmlPath = new URL('../.github/workflows/lint.yml', import.meta.url)
const lintYmlText = existsSync(lintYmlPath) ? readFileSync(lintYmlPath, 'utf8') : ''
const lintBlockingChecks = (() => {
  const names = new Set()
  for (const block of lintYmlText.split(/\n(?=[ \t]+- )/)) {
    if (/^[ \t]+continue-on-error:[ \t]*true\b/m.test(block)) continue
    for (const [, base] of block.matchAll(/node scripts\/(check-[A-Za-z0-9._-]+\.mjs)/g)) {
      names.add(base)
    }
  }
  return [...names].sort()
})()

const truth = {
  chainSteps: VALIDATE_STEPS.length,
  canarySteps: injections === null ? null : Object.keys(injections.steps).length,
  guardRuleIds: ruleIds.length,
  canaryLegs: canaryNumbers.size,
  hooks: shippedHooks.length,
}

const problems = []

// The status line. It read "pre-release (0.1.x)" at version 0.3.0 — the first thing a
// reader sees, three minors stale, and derivable in one line.
//
// Read package.json only when there is a status line to judge, and guard the read. Every
// other input above is `existsSync`-guarded for the same reason: this script takes no
// positional overrides, so its own fixture tests run a byte-identical COPY inside a
// mirrored tree, and an unguarded read of a file the fixture does not model does not fail
// the claim — it CRASHES the script, which reads as six unrelated red tests.
const pkgPath = new URL('../package.json', import.meta.url)
for (const [, claimed] of readme.matchAll(/\*\*Status: pre-release \((\d+\.\d+)\.x\)/g)) {
  if (!existsSync(pkgPath)) {
    problems.push(
      `README claims "pre-release (${claimed}.x)" but there is no package.json to check it against — an unverifiable claim is not a passing one`,
    )
    continue
  }
  const pkgVersion = JSON.parse(readFileSync(pkgPath, 'utf8')).version
  const majorMinor = pkgVersion.split('.').slice(0, 2).join('.')
  if (claimed !== majorMinor) {
    problems.push(
      `README's status line says "pre-release (${claimed}.x)" but package.json is ${pkgVersion} — the first line a reader trusts`,
    )
  }
}

// Both new derivations, judged the same way as every claim above them.
for (const [, n] of readme.matchAll(/(\d+) (?:executed |can-fail )?canar(?:y|ies)\b/gi)) {
  if (Number(n) !== truth.canaryLegs) {
    problems.push(
      `README claims ${n} canaries but the selftest matrix (plus its scripts/ci helpers) declares ${String(truth.canaryLegs)} numbered "Canary <n>:" legs — the workflow is the source of truth, because it is what actually runs`,
    )
  }
}
for (const [file, text] of [
  ['template/base/docs/harness/README.md', doctrineText],
  ['template/base/tools/validate.mjs', runnerText],
]) {
  for (const [, n] of text.matchAll(/~?(\d+)[ -](?:step|canonical steps|gates)\b/g)) {
    if (Number(n) !== truth.chainSteps) {
      problems.push(
        `${file} claims a ${n}-step chain but VALIDATE_STEPS has ${String(truth.chainSteps)} — this file SHIPS into every consumer, so a stale count there is a wrong number in every installed project`,
      )
    }
  }
}
// The hook count, in the two places a reader meets it — the root README's "how it works"
// and the shipped doctrine's hook table. Number WORDS are matched as well as digits because
// both sites spell it out, and a matcher that only reads digits would have passed the exact
// drift that prompted this check. CHANGELOG is deliberately NOT scanned: "all six hooks
// wired" inside the 0.2.1 entry is a true statement about 0.2.1, and rewriting history to
// satisfy a present-tense claim is the opposite of what this file is for.
const NUM_WORDS = { four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }
for (const [file, text] of [
  ['README.md', readme],
  ['template/base/docs/harness/README.md', unwrap(doctrineText)],
]) {
  for (const [, word] of text.matchAll(/\b(\d+|four|five|six|seven|eight|nine|ten) hooks\b/gi)) {
    const claimed = NUM_WORDS[word.toLowerCase()] ?? Number(word)
    if (claimed !== truth.hooks) {
      problems.push(
        `${file} claims "${word} hooks" but template/base/.claude/hooks/ ships ${String(truth.hooks)} (${shippedHooks.join(', ')}) — the directory is the source of truth, and check-wiring.mjs holds every one of them to being wired`,
      )
    }
  }
}

// CONTRIBUTING's three verifiable facts, judged only when the file exists (fixture trees
// need not model it). Targeted matchers, not broad numeric scans: CONTRIBUTING is full of
// numbers that are not claims about the chain.
if (contributingText !== '') {
  // (a) "--report-all runs all **31** steps" — the count a release-cutter trusts.
  for (const [, n] of contributing.matchAll(/all \*\*(\d+)\*\* steps/g)) {
    if (Number(n) !== truth.chainSteps) {
      problems.push(
        `CONTRIBUTING.md says \`--report-all\` runs all **${n}** steps but VALIDATE_STEPS has ${String(truth.chainSteps)} — the chain is the source of truth (tools/harness.config.mjs)`,
      )
    }
  }
  // (b) "the **six** HARNESS_HOOK_VERSION stamps" — word or digit, same table as the README's
  // hook count, because the word form is what actually shipped stale.
  for (const [, word] of contributing.matchAll(
    /\*\*(\d+|four|five|six|seven|eight|nine|ten)\*\*\s*`HARNESS_HOOK_VERSION`\s*stamps/gi,
  )) {
    const claimed = NUM_WORDS[word.toLowerCase()] ?? Number(word)
    if (claimed !== truth.hooks) {
      problems.push(
        `CONTRIBUTING.md's release list says "**${word}** HARNESS_HOOK_VERSION stamps" but template/base/.claude/hooks/ ships ${String(truth.hooks)} (${shippedHooks.join(', ')}) — the lockstep gate iterates the directory, and so must this sentence`,
      )
    }
  }
  // (c) The local-list closure. The section opens with "this list is the whole of what CI
  // blocks on" — so every blocking check-*.mjs step lint.yml runs must appear in it, or a
  // maintainer who runs the list literally goes red in CI on a check they never ran: the
  // exact failure the section's own preamble documents, made mechanical.
  for (const base of lintBlockingChecks) {
    if (!localDevSection.includes(base)) {
      problems.push(
        `.github/workflows/lint.yml blocks on \`node scripts/${base}\` but CONTRIBUTING.md's "Local development" list omits it — that list claims to be "the whole of what CI blocks on", so an omitted gate is a maintainer red on a check they never ran`,
      )
    }
  }
}

for (const [, n] of catalogText.matchAll(/(\d+)-step `VALIDATE_STEPS` chain/g)) {
  if (Number(n) !== truth.chainSteps) {
    problems.push(
      `docs/harness/gates-catalog.md opens with "the ${n}-step VALIDATE_STEPS chain" but VALIDATE_STEPS has ${String(truth.chainSteps)} — this is the document a reader consults to find out how long the chain is`,
    )
  }
}

// ── 1c. DERIVABLE (0.9.0): the chain length, across EVERY live prose surface ─────
// The two-file loop above covered the doctrine README and the runner header, and round-2
// of the 0.9.0 research found five live sites still claiming a "31-step" chain against 34
// — every one in a file a reader trusts, none on the claim surface. So the surface is now
// the WALK: every .md under template/base/docs/** and design/**, the shipped AGENTS.md,
// and CONTRIBUTING.md (the root README already has its broader digit-scan above), judged
// wherever they claim "the N gates" / "N-step chain" / "N gates, in order". CHANGELOG.md
// and template/migrations.json are EXCLUDED as history: "the 21-step chain" inside an old
// entry is a true statement about an old release, and rewriting history to satisfy a
// present-tense claim is the opposite of what this file is for.
const walkMd = (rel) => {
  const dirUrl = new URL(rel, import.meta.url)
  if (!existsSync(dirUrl)) return []
  /** @type {Array<[string, string]>} display path + raw text */
  const out = []
  const visit = (abs, disp) => {
    const entries = readdirSync(abs, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    for (const entry of entries) {
      if (entry.isDirectory()) visit(`${abs}/${entry.name}`, `${disp}/${entry.name}`)
      else if (entry.name.endsWith('.md')) {
        out.push([`${disp}/${entry.name}`, readFileSync(`${abs}/${entry.name}`, 'utf8')])
      }
    }
  }
  visit(fileURLToPath(dirUrl), rel.replace(/^\.\.\//, '').replace(/\/$/, ''))
  return out
}
const agentsMdUrl = new URL('../template/base/AGENTS.md', import.meta.url)
/** @type {Array<[string, string]>} the widened live-prose surface, raw text */
const proseSurfaces = [
  ...walkMd('../template/base/docs/'),
  ...(existsSync(agentsMdUrl)
    ? [
        /** @type {[string, string]} */ ([
          'template/base/AGENTS.md',
          readFileSync(agentsMdUrl, 'utf8'),
        ]),
      ]
    : []),
  ...walkMd('../design/'),
  ...(contributingText === ''
    ? []
    : [/** @type {[string, string]} */ (['CONTRIBUTING.md', contributingText])]),
]
const CHAIN_PHRASE = /\b(?:the (\d+) gates|(\d+)[- ]step chain|(\d+) gates, in order)\b/gi
for (const [file, text] of proseSurfaces) {
  for (const m of unwrap(text).matchAll(CHAIN_PHRASE)) {
    const n = Number(m[1] ?? m[2] ?? m[3])
    if (n !== truth.chainSteps) {
      problems.push(
        `${file} claims "${m[0]}" but VALIDATE_STEPS has ${String(truth.chainSteps)} — the chain is the source of truth (tools/harness.config.mjs). Live prose is judged; CHANGELOG.md and template/migrations.json stay history.`,
      )
    }
  }
}

// ── 1. DERIVABLE: every "<n> gates" / "<n> steps" claim about the chain ──────────
// Matches "21 gates", "21-step", "21 steps". PLURAL "gates" only, deliberately: the
// README also counts gate FILES ("gate scripts"), and a singular "gate" must not be
// read as a chain-length claim.
for (const [, n] of readme.matchAll(/\b(\d+)[ -](?:gates|steps?\b)/g)) {
  if (Number(n) !== truth.chainSteps) {
    problems.push(
      `README claims "${n} gates/steps" but VALIDATE_STEPS has ${String(truth.chainSteps)} — the chain is the source of truth (tools/harness.config.mjs)`,
    )
  }
}

// ── 1b. DERIVABLE: the canary registry + guard-rule counts, wherever claimed ─────
if (injections === null) {
  console.log(
    'CLAIMS: NOTE — tests/canary/injections.json does not exist yet (it ships with W5b); ' +
      'the canary-count class is SKIPPED, not passed. Any README canary-registry claim is ' +
      'unverified until the registry lands.',
  )
} else {
  for (const [, n] of readme.matchAll(/canary registry \d+ → (\d+) steps/g)) {
    if (Number(n) !== truth.canarySteps) {
      problems.push(
        `README claims a ${n}-step canary registry but tests/canary/injections.json has ${String(truth.canarySteps)}`,
      )
    }
  }
}
for (const [, n] of readme.matchAll(/(\d+) guard[- ]rule ids/g)) {
  if (Number(n) !== truth.guardRuleIds) {
    problems.push(
      `README claims ${n} guard-rule ids but guard-rules.mjs exports ${String(truth.guardRuleIds)}`,
    )
  }
}

// ── 2. CONSISTENT: README vs the LATEST CHANGELOG entry on wall-clock figures ────
// Nothing can assert a timing is TRUE on someone else's hardware — but two documents
// describing the same release must not disagree. Extract "cold ≈ N s" / "warm ≈ N s"
// from each and compare.
const latestEntry = (() => {
  const start = changelog.search(/^## \[/m)
  if (start === -1) return ''
  const rest = changelog.slice(start + 1)
  const next = rest.search(/^## \[/m)
  return next === -1 ? changelog.slice(start) : changelog.slice(start, start + 1 + next)
})()

const timings = (text) => {
  const out = {}
  for (const [, kind, n] of text.matchAll(/\b(cold|warm)\s*≈\s*(\d+)\s*s\b/g)) {
    // Record the FIRST figure per kind; later restatements should agree with it.
    out[kind] ??= Number(n)
  }
  return out
}
const rTimes = timings(readme)
const cTimes = timings(latestEntry)
for (const kind of ['cold', 'warm']) {
  const a = rTimes[kind]
  const b = cTimes[kind]
  if (a !== undefined && b !== undefined && a !== b) {
    problems.push(
      `README says ${kind} ≈ ${String(a)} s but the latest CHANGELOG entry says ${kind} ≈ ${String(b)} s — the same release cannot have two measured timings; make them agree (or drop the figure)`,
    )
  }
}

// MEASURE, COMMIT THE MEASUREMENT, THEN PUBLISH — enforced here (0.6.0).
//
// `scripts/chain-budget.json`'s header states that "check-claims.mjs refuses any wall-clock
// figure in README.md" until a real run records one, and until now that was a sentence about
// a control nobody had written: `hasCommittedMeasurement` was exported, unit-tested, and
// imported by no production caller. So the ordering the file's own comment prescribes held
// only for as long as everyone remembered it, which is the definition this repo uses for a
// rule that is not enforced. Two documents agreeing about a number neither of them measured
// is the failure mode the consistency check above cannot see: it compares the figures to each
// other, never to a measurement.
if (
  !hasCommittedMeasurement(
    chainBudget,
    VALIDATE_STEPS.map(([name]) => name),
  )
) {
  for (const [kind, value] of [
    ...Object.entries(rTimes).map(([k, v]) => [`README ${k}`, v]),
    ...Object.entries(cTimes).map(([k, v]) => [`the latest CHANGELOG entry's ${k}`, v]),
  ]) {
    problems.push(
      `${kind} ≈ ${String(value)} s is published, but scripts/chain-budget.json carries no committed measurement (wall.measuredMs is null) — so the figure rests on nothing a reader can check. Record one from a selftest run (\`node scripts/check-chain-budget.mjs <log> --record\`, which only writes in CI because the numbers are that runner's and are not portable), commit it, and then publish.`,
    )
  }
}

// ── 2b. CONSISTENT (0.9.0): every "~Ns" / "N-second" CHAIN-COST phrase ───────────
// The ≈-classes above only ever read README/CHANGELOG, and the cost claims that actually
// went stale lived in CONFIG COMMENTS: four shipped sites justified "CI-only" with "the
// warm validate budget is ~6s" against a committed measurement of 24337 ms — a 4x-stale
// number nobody re-read, because a comment is where numbers go to be believed. Any ~Ns or
// N-second figure near chain vocabulary, across the live doc surfaces AND the four config
// sites that carried the defect, must now be consistent with a committed measuredMs
// (wall or stopWall, ±25% or ±1s — hardware wobble is real, a 4x claim is not), and with
// no committed measurement no such figure may be published at all: the same
// measure-commit-publish order the README licence enforces, applied to the whole surface.
const stripLineMarkers = (s) => s.replace(/\n[ \t]*(?:>|\/\/|#|\*)?[ \t]*/g, ' ')
const costConfigSurfaces = [
  '../template/base/tools/harness.config.mjs',
  '../template/base/stryker.config.mjs',
  '../template/base/tools/check-mutation-ratchet.mjs',
  '../template/base/github/workflows/quality-gate.yml',
].flatMap((rel) => {
  const url = new URL(rel, import.meta.url)
  return existsSync(url)
    ? [
        /** @type {[string, string]} */ ([
          rel.replace(/^\.\.\//, ''),
          readFileSync(url, 'utf8'),
        ]),
      ]
    : []
})
const costSurfaces = [
  /** @type {[string, string]} */ (['README.md', readme]),
  ...proseSurfaces,
  ...costConfigSurfaces,
]
const wallSec =
  typeof chainBudget?.wall?.measuredMs === 'number' ? chainBudget.wall.measuredMs / 1000 : null
const stopSec =
  typeof chainBudget?.stopWall?.measuredMs === 'number'
    ? chainBudget.stopWall.measuredMs / 1000
    : null
const fitsMeasured = (n) =>
  [wallSec, stopSec].some((s) => s !== null && Math.abs(n - s) <= Math.max(1, s / 4))
const measuredBits = [
  ...(wallSec === null ? [] : [`~${wallSec.toFixed(1)}s (the validate wall)`]),
  ...(stopSec === null ? [] : [`~${stopSec.toFixed(1)}s (the Stop turn-end)`]),
].join(' / ')
const chainCostLicensed = hasCommittedMeasurement(
  chainBudget,
  VALIDATE_STEPS.map(([name]) => name),
)
// The tilde form is a cost estimate by construction, so plain chain vocabulary nearby is
// enough context; the bare "N-second" form is everywhere in database prose ("a 5-second
// RPC"), so it needs the chain-cost COMPOUND vocabulary before it reads as a claim.
const COST_PHRASES = [
  [/~\s*(\d+(?:\.\d+)?)\s*s\b/g, /(chain|validate|turn[- ]end|stop hook)/i],
  [
    /\b(\d+(?:\.\d+)?)[- ]seconds?\b/g,
    /(warm validate|validate chain|validate budget|validate wall|chain budget|chain cost|chain wall|stop chain|turn[- ]end)/i,
  ],
]
/** @param {string} file @param {string} text */
const judgeCostClaims = (file, text) => {
  for (const [re, contextRe] of COST_PHRASES) {
    for (const m of text.matchAll(re)) {
      const at = m.index ?? 0
      if (!contextRe.test(text.slice(Math.max(0, at - 160), at + m[0].length + 40))) continue
      if (!chainCostLicensed) {
        problems.push(
          `${file} publishes a chain-cost figure ~${m[1]}s but scripts/chain-budget.json carries no committed measurement matching the live chain — the figure rests on nothing a reader can check. The order is measure, commit, then publish (\`node scripts/check-chain-budget.mjs <log> --record\`).`,
        )
      } else if (!fitsMeasured(Number(m[1]))) {
        problems.push(
          `${file} claims a chain cost of ~${m[1]}s but the committed measurement is ${measuredBits} — scripts/chain-budget.json is the source of truth; fix the phrase or record a new measurement.`,
        )
      }
    }
  }
}
for (const [file, text] of costSurfaces) judgeCostClaims(file, stripLineMarkers(text))

void root

if (problems.length > 0) {
  console.error(`CLAIMS: ${String(problems.length)} unverified/contradictory claim(s):`)
  for (const p of problems) console.error(`  - ${p}`)
  console.error(
    '\nThe harness ships on "prove, don\'t claim" — recompute the numbers or fix the prose.',
  )
  process.exit(1)
}
console.log(
  `CLAIMS: CLEAN (chain ${String(truth.chainSteps)} steps, ` +
    (truth.canarySteps === null
      ? 'canary registry pending (W5b), '
      : `canary ${String(truth.canarySteps)} steps, `) +
    `${String(truth.guardRuleIds)} guard-rule ids, ${String(truth.canaryLegs)} executed canary legs, ` +
    'gates-catalog chain count in lockstep; README/CHANGELOG timings agree)',
)
