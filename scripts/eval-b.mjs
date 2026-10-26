#!/usr/bin/env node
// Eval B, all-hits precision (2.1.0, #188; SINGLE-HOME §11.1 row B, plan v2 §11 B): every
// hit #186's sweep reports on a frozen pre-dogfood fixture, labelled, and its precision per
// family and tier. Deterministic, under 10 s, and no model call.
//
// THE FILES, tests/evals/b/:
//   fixture/          the frozen tree (scripts/lib/eval-b-fixture.mjs says what it holds and
//                     where it comes from); fixture.sha256 is its digest manifest.
//   labels.json       { v, labels: { <key16>: { rule, tier, verdict, actionable?, by, why? } } }.
//                     key16 is #185's advisoryKey. verdict is `true`, `false`, `deliberate`
//                     or `pending` (a key the maintainer has not labelled yet: it counts in no
//                     precision, and --strict fails on it). `actionable` is the complexity
//                     families' flag B's actionable rate reads (SINGLE-HOME §4).
//   expect.json       the dogfood rows B should find (SINGLE-HOME §11.6 and the Dogfood
//                     table), each with the members that identify it in the fixture.
//   sweep.sha256      the sha256 of `--sweep --json` over the fixture: the two-machine check
//                     (tests/evals/sweep-digest.test.mjs, run on ubuntu and on Windows).
//   <date>.json       a recorded run (--write): posture, results and the input digests.
//
// SAMPLING. A family with more than SAMPLE hits is labelled on a stratified sample of SAMPLE:
// its hits are grouped by the workspace directory of their first member, each group gets a
// share by largest remainder, and within a group the hits are taken in key order (a key is a
// hash, so key order is an arbitrary order fixed by the hits themselves).
//
// THE MODES.
//   (none)            run, print, exit 1 when the fixture drifted from its manifest or a
//                     required key has no label.
//   --strict          also exit 1 while any required key is `pending`.
//   --write           also write tests/evals/b/<date>.json.
//   --write-labels    add a `pending` label for every required key that has none, and drop a
//                     `pending` one no hit needs any more. It never changes a decided label.
//   --write-digest    rewrite sweep.sha256 (after a change to the extractor or the parser).
//   --freeze          rebuild fixture/ and fixture.sha256 from the 2.0.0 stack head.
//
// THE GUARD. It applies no bar: owed precision 1.0, advisory >= 0.8 over at least 20 labelled
// hits and graduation >= 46 of 50 are applied by the rule PRs and graduations that cite a
// record. Its name is not check-*.mjs, so it stays out of the factory-gate canary closure.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadParser } from '../template/base/tools/lib/i18n-tree.mjs'
import { FIXTURE_COMMIT, freezeFixture } from './lib/eval-b-fixture.mjs'
import {
  checkManifest,
  cmp,
  key16,
  manifestText,
  materialise,
  ratio,
  readJson,
  removeTree,
  score,
  sha256,
  sweepBytes,
  sweepIn,
  writeJson,
  writeManifest,
} from './lib/evals.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const B_DIR = join(ROOT, 'tests/evals/b')
export const SAMPLE = 50
const USAGE =
  'usage: node scripts/eval-b.mjs [--strict] [--write] [--write-labels] [--write-digest] [--freeze] [--dir <eval-dir>]'

const files = (dir) => ({
  fixture: join(dir, 'fixture'),
  manifest: join(dir, 'fixture.sha256'),
  labels: join(dir, 'labels.json'),
  expect: join(dir, 'expect.json'),
  digest: join(dir, 'sweep.sha256'),
})

/** The sweep over the fixture, materialised in a temp copy. @param {string} dir @param {any} ts */
export function sweepFixture(dir, ts) {
  const tmp = materialise(files(dir).fixture)
  try {
    return sweepIn(tmp, ts)
  } finally {
    removeTree(tmp)
  }
}

/** The workspace directory a record's first member sits in: two path segments. */
const stratumOf = (r) => (r.facts.members?.[0] ?? r.facts.member).path.split('/').slice(0, 2).join('/')

/** A stratified sample of `n` of `records` (see SAMPLING). */
export function stratified(records, n) {
  if (records.length <= n) return records
  const groups = new Map()
  for (const r of [...records].sort((a, b) => cmp(key16(a), key16(b)))) {
    groups.set(stratumOf(r), [...(groups.get(stratumOf(r)) ?? []), r])
  }
  const names = [...groups.keys()].sort(cmp)
  const exact = names.map((g) => (groups.get(g).length * n) / records.length)
  const take = exact.map(Math.floor)
  const byRemainder = names.map((_, i) => i).sort((a, b) => exact[b] - take[b] - (exact[a] - take[a]) || a - b)
  const short = n - take.reduce((s, x) => s + x, 0)
  for (let k = 0; k < short; k += 1) take[byRemainder[k]] += 1
  return names.flatMap((g, i) => groups.get(g).slice(0, take[i]))
}

/** The hits that need a label: every family's, sampled where it has more than SAMPLE. */
export function requiredRecords(records) {
  const byRule = new Map()
  for (const r of records) byRule.set(r.rule, [...(byRule.get(r.rule) ?? []), r])
  return [...byRule.keys()].sort(cmp).flatMap((rule) => stratified(byRule.get(rule), SAMPLE))
}

/** Whether a record's members include every member a dogfood row names. */
const matches = (r, row) => {
  const members = r.facts.members ?? (r.facts.member === undefined ? [] : [r.facts.member])
  return row.members.every((m) => members.some((x) => x.path === m.path && x.name === m.name))
}

/** The dogfood coverage table: each row with what the sweep found for it. */
export function coverage(records, rows) {
  return rows.map((row) => {
    const hit = row.members.length === 0 ? undefined : records.find((r) => matches(r, row))
    return {
      row: row.row,
      secondHome: row.secondHome,
      expect: row.expect,
      found: hit === undefined ? null : { rule: hit.rule, tier: hit.facts.tier, key: key16(hit) },
    }
  })
}

const pct = (n, d) => `${String(n)} of ${String(d)}`

/** The printed report, one line per family and tier, then coverage. */
function report(result) {
  const lines = [`eval B: ${String(result.hits)} hits, ${String(result.required)} need a label (families over ${String(SAMPLE)} sampled)`]
  for (const f of result.families) {
    lines.push(`  ${f.rule.padEnd(18)} ${f.tier.padEnd(9)} hits ${String(f.hits).padStart(4)}  true ${String(f.true).padStart(4)}  pending ${String(f.pending).padStart(4)}  precision ${ratio(f.precision)}`)
  }
  lines.push('dogfood coverage (row: expected -> found):')
  for (const c of result.coverage) {
    const found = c.found === null ? 'no hit' : `${c.found.rule} ${c.found.tier} ${c.found.key}`
    lines.push(`  #${c.row.padEnd(4)} ${c.expect.padEnd(26)} -> ${found}`)
  }
  const homes = result.coverage.filter((c) => c.secondHome)
  lines.push(`second homes with a hit: ${pct(homes.filter((c) => c.found !== null).length, homes.length)}`)
  if (result.pending > 0) lines.push(`${String(result.pending)} required keys are pending the maintainer's label`)
  for (const key of result.unlabelled) lines.push(`unlabelled: ${key}`)
  return lines.join('\n')
}

/**
 * Run eval B over an eval directory: the fixture checked against its manifest, the sweep,
 * the score of the required hits, and the coverage table.
 * @param {string} dir @param {any} ts
 */
export function runB(dir, ts) {
  const f = files(dir)
  const drift = checkManifest(f.fixture, f.manifest)
  const doc = sweepFixture(dir, ts)
  const labels = existsSync(f.labels) ? readJson(f.labels).labels : {}
  const required = requiredRecords(doc.records)
  const { families, unlabelled } = score(required, labels)
  return {
    doc,
    drift,
    hits: doc.records.length,
    required: required.length,
    families,
    unlabelled,
    pending: families.reduce((s, x) => s + x.pending, 0),
    coverage: coverage(doc.records, existsSync(f.expect) ? readJson(f.expect).rows : []),
  }
}

/** The input digests a record carries. */
function digests(dir, doc) {
  const f = files(dir)
  const of = (file) => (existsSync(file) ? sha256(readFileSync(file)) : null)
  return {
    extractor: doc.x,
    fixture: sha256(manifestText(f.fixture)),
    labels: of(f.labels),
    expect: of(f.expect),
    sweep: sha256(sweepBytes(doc)),
  }
}

/** The record (--write), without its date. */
export function recordOf(dir, result) {
  return {
    v: 1,
    eval: 'B',
    posture: { modelCalls: 0, sample: SAMPLE, fixtureCommit: FIXTURE_COMMIT, complete: result.doc.complete, pending: result.pending },
    digests: digests(dir, result.doc),
    families: result.families,
    coverage: result.coverage,
  }
}

/** --write-labels: a `pending` label for every required key with none. */
function addPending(dir, result) {
  const f = files(dir)
  const file = existsSync(f.labels) ? readJson(f.labels) : { v: 1, labels: {} }
  const required = requiredRecords(result.doc.records)
  const live = new Set(required.map((r) => key16(r)))
  for (const [key, label] of Object.entries(file.labels)) if (label.verdict === 'pending' && !live.has(key)) delete file.labels[key]
  for (const r of required) {
    file.labels[key16(r)] ??= { rule: r.rule, tier: r.facts.tier, verdict: 'pending', by: 'pending' }
  }
  file.labels = Object.fromEntries(Object.entries(file.labels).sort(([a], [b]) => cmp(a, b)))
  writeJson(f.labels, file)
}

/** The two-machine digest line: the sweep's sha256 and the extractor digest it was taken under. */
export const digestLine = (doc) => `${sha256(sweepBytes(doc))} x=${String(doc.x)}\n`

function freeze(dir) {
  const f = files(dir)
  rmSync(f.fixture, { recursive: true, force: true })
  freezeFixture(ROOT, f.fixture)
  writeManifest(f.fixture, f.manifest)
  console.log(`eval B: froze ${f.fixture} and wrote ${f.manifest}`)
}

/** Parse argv: the flags, and the eval directory, or null on bad usage. */
function parseArgs(argv) {
  const flags = new Set(['--strict', '--write', '--write-labels', '--write-digest', '--freeze'])
  const at = argv.indexOf('--dir')
  if (at !== -1 && argv[at + 1] === undefined) return null
  const rest = argv.filter((_, i) => at === -1 || (i !== at && i !== at + 1))
  if (rest.some((a) => !flags.has(a))) return null
  return { dir: at === -1 ? B_DIR : resolve(argv[at + 1]), has: (flag) => rest.includes(flag) }
}

/** @param {string[]} argv @returns {Promise<number>} */
export async function main(argv) {
  const args = parseArgs(argv)
  if (args === null) {
    console.error(USAGE)
    return 1
  }
  const ts = await loadParser()
  if (ts === null) {
    console.error('eval B: typescript cannot be imported; run `pnpm install` at the repository root first')
    return 1
  }
  if (args.has('--freeze')) freeze(args.dir)
  let result = runB(args.dir, ts)
  if (args.has('--write-labels')) {
    addPending(args.dir, result)
    result = runB(args.dir, ts)
  }
  if (args.has('--write-digest')) writeFileSync(files(args.dir).digest, digestLine(result.doc))
  console.log(report(result))
  for (const line of result.drift) console.error(`eval B: the fixture drifted from fixture.sha256: ${line}`)
  if (args.has('--write')) {
    const date = new Date().toISOString().slice(0, 10)
    writeJson(join(args.dir, `${date}.json`), { date, ...recordOf(args.dir, result) })
  }
  const failed = result.drift.length > 0 || result.unlabelled.length > 0 || !result.doc.complete
  return failed || (args.has('--strict') && result.pending > 0) ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2))
}
