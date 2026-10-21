#!/usr/bin/env node
// Eval A, the detector eval (2.1.0, #188; SINGLE-HOME §11.1 row A, plan v2 §11 A): about 40
// home helpers mutated by seven scripted mutators, plus decoys and plantings, each swept by
// #186's sweep in a tree of its own and scored against labels. Deterministic, under 10 s,
// and no model call.
//
// THE FILES, tests/evals/a/:
//   corpus.json       { v, seed, helpers: [{ id, lang, ext, name, from, tokens, dataShaped,
//                     text }] } (lib/eval-a-corpus.mjs builds it from eval B's fixture).
//   plantings.json    { v, families: { <family>: [{ id, why, verdict, expect, files }] } }:
//                     decoys, v3's plantings, and the wire plantings each wire PR adds under
//                     its own family (#189 `wire-orphan`, #196, #197). lib/eval-a-cases.mjs
//                     says what an entry means.
//   split.json        { v, seed, dev: [ids], holdout: [ids], blind: [dirs] }: the helpers
//                     split 70/30 by the committed seed; plantings are development material;
//                     the holdout adds the blind verticals under holdout/.
//   labels.json       { v, labels: { <key16>: { case, rule, tier, verdict, by } } }, keyed by
//                     #185's advisoryKey. `by: construction` is the verdict the case's own
//                     construction gives (a mutant of a helper is a true second home; a decoy
//                     is a decoy); the maintainer confirms them (`by: maintainer`) and labels
//                     every `pending` key (an incidental hit inside one helper, or a blind
//                     vertical's).
//   frozen.json       written by #194 from the development run, never by this script: FLOOR,
//                     the exact-small band, the near-miss thresholds, TOKEN_CONVENTION and
//                     the extractor digest. The holdout refuses to run without it.
//   dev.sha256        the sha256 of the development record without its date: the
//                     two-machine check (tests/evals/sweep-digest.test.mjs).
//   blind-vertical.prompt.md, holdout/vertical-<n>/   the blind verticals
//                     (scripts/eval-a-freeze-vertical.mjs).
//   <date>.json       a recorded run (--write): posture, results and the input digests.
//
// THE MODES.
//   --split dev|holdout   which split (default dev). Exit 1 when a key the sweep produces has
//                         no label, or a leg did not complete.
//   --strict              also exit 1 while any key is `pending`.
//   --write               also write tests/evals/a/<date>.json.
//   --write-labels        label every unlabelled key by construction; never changes a label.
//   --write-digest        rewrite dev.sha256.
//   --build-corpus        rebuild corpus.json, plantings.json and split.json from eval B's
//                         fixture (changes every key: labels must be rebuilt after it).
//
// THE GUARD. It applies no bar. The holdout bars (owed precision 1.0, near-miss precision at
// least 0.90) are applied by #194's recorded run and the exact rule's gate-proposal. Owed
// recall on renames and literal swaps is true by construction, and is a unit test
// (tests/evals/eval-a.test.mjs), not a bar. The name is not check-*.mjs, so it stays out of
// the factory-gate canary closure.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadParser } from '../template/base/tools/lib/i18n-tree.mjs'
import { extractorDigest, TOKEN_CONVENTION } from '../template/base/tools/lib/shapes.mjs'
import { FLOOR, NEAR_MISS, SMALL_FLOOR } from '../template/base/tools/lib/sweep.mjs'
import { buildCorpus } from './lib/eval-a-corpus.mjs'
import { A_RULES, constructedVerdict, mutationCases, plantingCase, sweepCase } from './lib/eval-a-cases.mjs'
import { MUTATORS, prng } from './lib/eval-a-mutators.mjs'
import { cmp, digestsOf, key16, materialise, ratio, readJson, removeTree, score, sha256, sweepIn, writeJson } from './lib/evals.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const A_DIR = join(ROOT, 'tests/evals/a')
const B_FIXTURE = join(ROOT, 'tests/evals/b/fixture')
const CENSUS = join(B_FIXTURE, 'tools/exports-walls.json')
/** The corpus seed and the split seed, committed with the files they make. */
export const SEED = 188
export const DEV_SHARE = 0.7
const USAGE =
  'usage: node scripts/eval-a.mjs [--split dev|holdout] [--strict] [--write] [--write-labels] [--write-digest] [--build-corpus] [--dir <eval-dir>]'

const files = (dir) => ({
  corpus: join(dir, 'corpus.json'),
  plantings: join(dir, 'plantings.json'),
  split: join(dir, 'split.json'),
  labels: join(dir, 'labels.json'),
  frozen: join(dir, 'frozen.json'),
  digest: join(dir, 'dev.sha256'),
  holdout: join(dir, 'holdout'),
})

/** The provisional values a holdout run must find frozen, as frozen.json records them. */
export const liveConstants = (x) => ({
  FLOOR,
  SMALL_FLOOR,
  NEAR_MISS: { ...NEAR_MISS },
  TOKEN_CONVENTION,
  extractor: x,
})

// ---- the cases --------------------------------------------------------------------------

/** The blind verticals frozen under holdout/, each one case over its whole tree. */
function blindCases(dir) {
  const root = files(dir).holdout
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^vertical-\d+$/.test(e.name))
    .map((e) => e.name)
    .sort(cmp)
    .map((name) => ({ id: `blind:${name}`, helper: null, family: 'blind', verdict: 'pending', expect: null, planted: [], tree: join(root, name) }))
}

/** Every case of a split. */
export function casesOf(ts, dir, split) {
  const f = files(dir)
  const corpus = readJson(f.corpus)
  const ids = new Set(readJson(f.split)[split])
  const out = corpus.helpers.filter((h) => ids.has(h.id)).flatMap((h) => mutationCases(ts, h, corpus.seed))
  if (split === 'dev') {
    for (const [family, entries] of Object.entries(readJson(f.plantings).families)) {
      out.push(...entries.map((p) => plantingCase(family, p)))
    }
  }
  return split === 'holdout' ? [...out, ...blindCases(dir)] : out
}

/** One case swept: a blind vertical over its frozen tree, any other over a written tree. */
function sweepOne(c, ts, census) {
  if (c.tree === undefined) return sweepCase(c, ts, census)
  const tmp = materialise(c.tree)
  try {
    const doc = sweepIn(tmp, ts)
    return { x: doc.x, complete: doc.complete, records: doc.records.filter((r) => A_RULES.has(r.rule)) }
  } finally {
    removeTree(tmp)
  }
}

/** Every case swept, with its records keyed. */
export function sweepAll(ts, dir, split) {
  const census = readFileSync(CENSUS, 'utf8')
  let x = null
  let complete = true
  const runs = casesOf(ts, dir, split).map((c) => {
    const run = sweepOne(c, ts, census)
    x = run.x
    complete &&= run.complete
    return { c, records: run.records.map((r) => ({ key: key16(r), r })) }
  })
  return { x, complete, runs }
}

// ---- scoring ----------------------------------------------------------------------------

/** Whether a case's records hold the rule it expects over its planted files. */
function found(run) {
  const want = run.c.expect
  if (want === null) return null
  const rule = typeof want === 'string' ? want : want.rule
  const tier = typeof want === 'string' ? undefined : want.tier
  return run.records.some(({ r }) => r.rule === rule && (tier === undefined || r.facts.tier === tier) && constructedVerdict(run.c, r) === run.c.verdict)
}

/** Recall per family (mutator or planting family): cases expecting a rule, and how many found it. */
export function recallOf(runs) {
  const by = new Map()
  for (const run of runs) {
    const hit = found(run)
    const row = by.get(run.c.family) ?? { family: run.c.family, cases: 0, expected: 0, found: 0 }
    row.cases += 1
    if (hit !== null) row.expected += 1
    if (hit === true) row.found += 1
    by.set(run.c.family, row)
  }
  const order = (f) => (MUTATORS.includes(f) ? MUTATORS.indexOf(f) : MUTATORS.length)
  return [...by.values()]
    .sort((a, b) => order(a.family) - order(b.family) || cmp(a.family, b.family))
    .map((row) => ({ ...row, recall: row.expected === 0 ? null : row.found / row.expected }))
}

/** Owed recall over one mutator's cases: those expecting `exact` that found it owed. */
export function owedRecall(runs, mutator) {
  const owed = runs.filter((run) => run.c.family === mutator && run.c.expect === 'exact')
  const hit = owed.filter((run) => run.records.some(({ r }) => r.rule === 'exact' && r.facts.tier === 'owed' && constructedVerdict(run.c, r) === 'true'))
  return { expected: owed.length, found: hit.length, recall: owed.length === 0 ? null : hit.length / owed.length }
}

/** The ±3 audit: every class within 3 tokens of FLOOR, with its label. */
export function audit(runs, labels) {
  const out = []
  for (const run of runs) {
    for (const { key, r } of run.records) {
      if (r.rule === 'near-miss' || Math.abs((r.counts.tokens ?? 0) - FLOOR) > 3) continue
      out.push({ key, case: run.c.id, rule: r.rule, tier: r.facts.tier, tokens: r.counts.tokens, verdict: labels[key]?.verdict ?? 'unlabelled' })
    }
  }
  return out.sort((a, b) => a.tokens - b.tokens || cmp(a.key, b.key))
}

/** Run eval A over one split of an eval directory. */
export function runA(ts, dir, split) {
  const f = files(dir)
  const labels = existsSync(f.labels) ? readJson(f.labels).labels : {}
  const swept = sweepAll(ts, dir, split)
  const records = swept.runs.flatMap((run) => run.records.map(({ r }) => r))
  const { families, unlabelled } = score(records, labels)
  return {
    split,
    x: swept.x,
    complete: swept.complete,
    runs: swept.runs,
    cases: swept.runs.length,
    hits: records.length,
    families,
    unlabelled,
    pending: families.reduce((s, row) => s + row.pending, 0),
    recall: recallOf(swept.runs),
    owed: Object.fromEntries(['rename', 'literal'].map((m) => [m, owedRecall(swept.runs, m)])),
    audit: audit(swept.runs, labels),
  }
}

function report(result) {
  const lines = [`eval A (${result.split}): ${String(result.cases)} cases, ${String(result.hits)} hits`, 'recall per family (cases, expecting a rule, found it):']
  for (const r of result.recall) {
    lines.push(`  ${r.family.padEnd(18)} cases ${String(r.cases).padStart(3)}  expected ${String(r.expected).padStart(3)}  found ${String(r.found).padStart(3)}  recall ${ratio(r.recall)}`)
  }
  for (const [m, o] of Object.entries(result.owed)) lines.push(`owed recall, ${m}: ${String(o.found)} of ${String(o.expected)} (${ratio(o.recall)})`)
  lines.push('precision per rule and tier (labelled hits):')
  for (const f of result.families) {
    lines.push(`  ${f.rule.padEnd(18)} ${f.tier.padEnd(9)} hits ${String(f.hits).padStart(4)}  true ${String(f.true).padStart(4)}  pending ${String(f.pending).padStart(4)}  precision ${ratio(f.precision)}`)
  }
  lines.push(`the ±3 audit (classes within 3 tokens of FLOOR ${String(FLOOR)}):`)
  for (const a of result.audit) lines.push(`  ${a.key} ${String(a.tokens).padStart(3)} ${a.rule} ${a.tier} ${a.verdict} (${a.case})`)
  if (result.audit.length === 0) lines.push('  none')
  if (result.pending > 0) lines.push(`${String(result.pending)} keys are pending the maintainer's label`)
  for (const key of result.unlabelled) lines.push(`unlabelled: ${key}`)
  return lines.join('\n')
}

// ---- records, labels, corpus --------------------------------------------------------------

const fileDigest = (file) => (existsSync(file) ? sha256(readFileSync(file)) : null)

/** The record of a run, without its date. */
export function recordOf(dir, result) {
  const f = files(dir)
  const holdout = existsSync(f.holdout) ? sha256(digestsOf(f.holdout).map(([p, d]) => `${d}  ${p}\n`).join('')) : null
  return {
    v: 1,
    eval: 'A',
    split: result.split,
    posture: { modelCalls: 0, constants: liveConstants(result.x), complete: result.complete, pending: result.pending },
    digests: {
      extractor: result.x,
      corpus: fileDigest(f.corpus),
      plantings: fileDigest(f.plantings),
      split: fileDigest(f.split),
      labels: fileDigest(f.labels),
      holdout: result.split === 'holdout' ? holdout : null,
    },
    recall: result.recall,
    owed: result.owed,
    families: result.families,
    audit: result.audit,
  }
}

/** The development record's digest line: the two-machine check. */
export const devDigestLine = (record) => `${sha256(`${JSON.stringify(record)}\n`)} x=${String(record.digests.extractor)}\n`

/** --write-labels: every unlabelled key labelled by its case's construction. */
function addConstructed(dir, result) {
  const f = files(dir)
  const file = existsSync(f.labels) ? readJson(f.labels) : { v: 1, labels: {} }
  for (const run of result.runs) {
    for (const { key, r } of run.records) {
      const verdict = constructedVerdict(run.c, r)
      file.labels[key] ??= { case: run.c.id, rule: r.rule, tier: r.facts.tier, verdict, by: verdict === 'pending' ? 'pending' : 'construction' }
    }
  }
  file.labels = Object.fromEntries(Object.entries(file.labels).sort(([a], [b]) => cmp(a, b)))
  writeJson(f.labels, file)
}

/** The 70/30 split of the helpers by the committed seed. */
export function splitOf(helpers, seed) {
  const rand = prng(seed ^ 0x5eed)
  const order = helpers.map((h) => ({ id: h.id, r: rand() })).sort((a, b) => a.r - b.r || cmp(a.id, b.id))
  const n = Math.round(helpers.length * DEV_SHARE)
  const ids = (xs) => xs.map((x) => x.id).sort(cmp)
  return { dev: ids(order.slice(0, n)), holdout: ids(order.slice(n)) }
}

function build(ts, dir) {
  const f = files(dir)
  const { helpers, plantings } = buildCorpus(ts, B_FIXTURE, SEED)
  writeJson(f.corpus, { v: 1, seed: SEED, comment: 'Eval A corpus (scripts/eval-a.mjs). Built from tests/evals/b/fixture by --build-corpus; never edited by hand.', helpers })
  writeJson(f.plantings, { v: 1, comment: 'Eval A plantings and decoys (scripts/lib/eval-a-cases.mjs). A wire PR adds its 5 plantings and 5 decoys under its own family key.', families: plantings })
  writeJson(f.split, { v: 1, seed: SEED, share: DEV_SHARE, ...splitOf(helpers, SEED), blind: ['holdout/vertical-1', 'holdout/vertical-2', 'holdout/vertical-3'] })
  console.log(`eval A: built ${String(helpers.length)} helpers into ${f.corpus}`)
}

// ---- the CLI ----------------------------------------------------------------------------

function parseArgs(argv) {
  const flags = new Set(['--strict', '--write', '--write-labels', '--write-digest', '--build-corpus'])
  const valued = new Map([['--split', 'dev'], ['--dir', A_DIR]])
  const rest = []
  for (let i = 0; i < argv.length; i += 1) {
    if (valued.has(argv[i])) {
      if (argv[i + 1] === undefined) return null
      valued.set(argv[i], argv[i + 1])
      i += 1
    } else if (flags.has(argv[i])) rest.push(argv[i])
    else return null
  }
  const split = valued.get('--split')
  if (split !== 'dev' && split !== 'holdout') return null
  return { split, dir: resolve(valued.get('--dir')), has: (flag) => rest.includes(flag) }
}

/** The holdout guard: the reason a holdout run may not start, or null. */
export function holdoutRefusal(dir, x) {
  const file = files(dir).frozen
  if (!existsSync(file)) {
    return `eval A: the holdout needs ${file}; #194 writes it from the development run, and thresholds are frozen before held-out data is seen`
  }
  const frozen = readJson(file)
  const live = liveConstants(x)
  const drifted = Object.keys(live).filter((k) => JSON.stringify(frozen[k]) !== JSON.stringify(live[k]))
  return drifted.length === 0 ? null : `eval A: the live detector differs from ${file} at ${drifted.join(', ')}; the holdout runs only against the frozen values`
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
    console.error('eval A: typescript cannot be imported; run `pnpm install` at the repository root first')
    return 1
  }
  if (args.has('--build-corpus')) build(ts, args.dir)
  if (args.split === 'holdout') {
    const refusal = holdoutRefusal(args.dir, extractorDigest(ts))
    if (refusal !== null) {
      console.error(refusal)
      return 1
    }
  }
  let result = runA(ts, args.dir, args.split)
  if (args.has('--write-labels')) {
    addConstructed(args.dir, result)
    result = runA(ts, args.dir, args.split)
  }
  const record = recordOf(args.dir, result)
  if (args.has('--write-digest') && args.split === 'dev') writeFileSync(files(args.dir).digest, devDigestLine(record))
  console.log(report(result))
  if (args.has('--write')) {
    const date = new Date().toISOString().slice(0, 10)
    writeJson(join(args.dir, `${date}${args.split === 'dev' ? '' : '-holdout'}.json`), { date, ...record })
  }
  const failed = result.unlabelled.length > 0 || !result.complete
  return failed || (args.has('--strict') && result.pending > 0) ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2))
}
