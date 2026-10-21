// Eval A's corpus and case trees (2.1.0, #188; plan v2 §11 A, SINGLE-HOME §11.6).
//
// THE CORPUS, tests/evals/a/corpus.json, is built once from eval B's frozen fixture
// (`node scripts/eval-a.mjs --build-corpus`) and then committed, so the template moving on
// never moves eval A: about 40 home helpers (top-level function declarations and SQL
// functions, chosen by the committed seed across three token bands so the band around FLOOR
// is populated), each with its text, origin and the extractor's token count at build time.
//
// THE PLANTINGS, tests/evals/a/plantings.json, are every case that is not a mutation: the
// decoys (the per-vertical seam constructors and the real invalidExportCursor mirror, local
// and UTC formatDate, the design-system mirror, the i18n catalogs, the zod tables, the route
// convention files, planted toCents/fromCents, tiny same-name functions with different
// bodies), v3's additions (the shorthand planting, the owed same-file tag-only twin, the
// silent decoy) and, per family, the wire plantings the wire PRs add (#189, #196, #197).
// Each entry is `{ id, why, verdict, expect, files: { <path>: <text> } }`: `verdict` is the
// label every record over its files gets (`true` or `decoy`), and `expect` the rule a
// planting must produce (null for a decoy, which should produce nothing owed).
//
// A CASE is one tree the sweep runs over, alone: a mutation case holds the helper and its
// mutant (or, for `move`, the mutant alone); a planting case holds its files. Every case
// tree carries the fixture's workspace census (tools/exports-walls.json), which is decision
// 2's census entry for a scaffolded vertical until #160 changes its shape.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { FLOOR, SMALL_FLOOR } from '../../template/base/tools/lib/sweep.mjs'
import { MUTATE, MUTATORS, seedFor, sqlRenamed } from './eval-a-mutators.mjs'
import { removeTree, sweepIn } from './evals.mjs'

/** The rules eval A scores: the duplication detector's. Complexity families are eval B's. */
export const A_RULES = new Set(['exact', 'exact-small', 'exact-nohome', 'near-miss'])

const pkgJson = (name) =>
  `${JSON.stringify({ name, private: true, type: 'module', exports: { '.': './src/index.ts' }, dependencies: {} }, null, 2)}\n`

/** Where a mutation case puts the helper and the mutant, per mutator. */
function layout(helper, mutator) {
  const file = `${helper.id}.${helper.ext}`
  if (helper.lang === 'sql') {
    return {
      original: `supabase/migrations/20260101000000_${helper.id}.sql`,
      mutant: `supabase/migrations/20260101000100_${helper.id}_${mutator.replace('-', '_')}.sql`,
      packages: {},
    }
  }
  if (mutator === 'sibling') {
    return {
      original: `packages/verticals/alpha/src/${file}`,
      mutant: `packages/verticals/beta/src/${file}`,
      packages: { 'packages/verticals/alpha': '@eval/alpha', 'packages/verticals/beta': '@eval/beta' },
    }
  }
  if (mutator === 'move') {
    return { original: null, mutant: `packages/elsewhere/src/${file}`, packages: { 'packages/elsewhere': '@eval/elsewhere' } }
  }
  return {
    original: `packages/home/src/${file}`,
    mutant: `packages/home/src/${helper.id}-${mutator}.${helper.ext}`,
    packages: { 'packages/home': '@eval/home' },
  }
}

/**
 * The rule a mutation case should produce, by construction: an exact copy (rename, sibling,
 * sql-schema) is an exact class at FLOOR and above and exact-small in the small band; a
 * literal swap is exact only at FLOOR and above (exact-small needs equal literals); an edit
 * is a near-miss candidate; a move leaves nothing to find. A data-shaped helper is never
 * owed, so none of its copies is expected.
 */
function expectedRule(helper, mutator) {
  if (mutator === 'move') return null
  if (mutator === 'reorder' || mutator === 'resemble') return 'near-miss'
  if (helper.tokens >= FLOOR) return helper.dataShaped ? null : 'exact'
  const copy = mutator !== 'literal'
  return copy && helper.tokens >= SMALL_FLOOR ? 'exact-small' : null
}

/** Every mutation case of a helper (the mutators that apply to it). */
export function mutationCases(ts, helper, seed) {
  const out = []
  for (const mutator of MUTATORS) {
    let text = MUTATE[mutator](ts, helper, seedFor(seed, helper.id, mutator))
    if (text === null) continue
    if (helper.lang === 'sql' && mutator !== 'move') text = sqlRenamed(text, 'm')
    const where = layout(helper, mutator)
    const files = { [where.mutant]: text }
    if (where.original !== null) files[where.original] = helper.text
    for (const [dir, name] of Object.entries(where.packages)) files[`${dir}/package.json`] = pkgJson(name)
    out.push({
      id: `${helper.id}:${mutator}`,
      helper: helper.id,
      family: mutator,
      verdict: 'true',
      expect: expectedRule(helper, mutator),
      planted: [where.original, where.mutant].filter((p) => p !== null),
      files,
    })
  }
  return out
}

/** A planting entry as a case. */
export const plantingCase = (family, p) => ({
  id: `${family}:${p.id}`,
  helper: null,
  family,
  verdict: p.verdict,
  expect: p.expect,
  planted: Object.keys(p.files).filter((f) => !f.endsWith('package.json')),
  files: p.files,
})

/** Write a case's files (and the census) into a fresh temp tree. */
function writeCase(c, census) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-eval-a-'))
  const files = census === null ? c.files : { 'tools/exports-walls.json': census, ...c.files }
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(dir, ...rel.split('/'))
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, text)
  }
  return dir
}

/** The sweep over one case tree: the records eval A scores, and whether every leg completed. */
export function sweepCase(c, ts, census) {
  const dir = writeCase(c, census)
  try {
    const doc = sweepIn(dir, ts)
    return { x: doc.x, complete: doc.complete, records: doc.records.filter((r) => A_RULES.has(r.rule) || r.producer !== 'duplication') }
  } finally {
    removeTree(dir)
  }
}

/** A record's members (a pair, a class, or one member). */
const membersOf = (r) => r.facts.members ?? (r.facts.member === undefined ? [] : [r.facts.member])

/**
 * The label construction gives a record of a case: the case's verdict when every member sits
 * in a planted file and the record joins at least two of them (or the case planted only one
 * file and the record is in it), else `pending` (an incidental hit inside one helper).
 */
export function constructedVerdict(c, r) {
  const paths = membersOf(r).map((m) => m.path)
  if (!paths.every((p) => c.planted.includes(p))) return 'pending'
  return new Set(paths).size >= Math.min(2, c.planted.length) ? c.verdict : 'pending'
}
