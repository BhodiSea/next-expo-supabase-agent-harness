// Shared machinery for the model-free Single Home evals, A and B (2.1.0, #188):
// scripts/eval-a.mjs, scripts/eval-b.mjs and scripts/eval-a-freeze-vertical.mjs.
//
// A FROZEN TREE is a directory committed under tests/evals/ with a digest manifest beside
// it: one `<sha256>  <path>` line per file, repository-relative to the tree, POSIX, sorted
// by code unit. The manifest is what makes a tree frozen: `checkManifest` reports every
// file added, removed or changed since it was written. A file the factory's own toolchain
// would read as repository code is stored with a `.txt` suffix (`.dependency-cruiser.cjs`
// as `.dependency-cruiser.cjs.txt`), and `materialise` strips it in a temp copy, so eslint
// and knip never see the frozen tree's JavaScript (eslint.config.mjs reads `.mjs`, `.js`
// and `.cjs`; knip.json's project globs read `.mjs`).
//
// THE SWEEP is #186's, `sweep()` in template/base/tools/lib/sweep.mjs, which reads the
// working directory as the project root. `sweepIn` runs it with a tree as the working
// directory and always restores the caller's.
//
// DETERMINISM. Nothing here reads a clock, a hostname or an absolute path into an output
// that a digest covers; every sort compares code units.
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { walkFiles } from '../../template/base/tools/lib/fs-walk.mjs'
import { advisoryKey } from '../../template/base/tools/lib/gate.mjs'
import { sweep } from '../../template/base/tools/lib/sweep.mjs'

/** @param {string | Buffer} bytes */
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

export const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/** The suffix a frozen file the factory toolchain would read carries on disk. */
const STORED = /\.(cjs|mjs|js)\.txt$/

/**
 * Every file under `dir` with its sha256, sorted by path.
 * @param {string} dir @returns {[string, string][]}
 */
export function digestsOf(dir) {
  return walkFiles(dir)
    .sort(cmp)
    .map((rel) => [rel, sha256(readFileSync(join(dir, ...rel.split('/'))))])
}

/** The manifest text of a tree. @param {string} dir */
export const manifestText = (dir) =>
  digestsOf(dir)
    .map(([rel, digest]) => `${digest}  ${rel}\n`)
    .join('')

/** Write `dir`'s manifest to `file`. @param {string} dir @param {string} file */
export function writeManifest(dir, file) {
  writeFileSync(file, manifestText(dir))
}

/**
 * Every way `dir` differs from the manifest at `file`, as one line each: [] when it matches.
 * @param {string} dir @param {string} file @returns {string[]}
 */
export function checkManifest(dir, file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return [`no manifest at ${file}`]
  }
  const want = new Map()
  for (const line of text.split('\n').filter((l) => l !== '')) {
    const m = /^([0-9a-f]{64}) {2}(\S.*)$/.exec(line)
    if (m === null) return [`a manifest line is not "<sha256>  <path>": ${JSON.stringify(line)}`]
    want.set(m[2], m[1])
  }
  const have = new Map(digestsOf(dir))
  const out = []
  for (const [rel, digest] of want) {
    if (!have.has(rel)) out.push(`missing: ${rel}`)
    else if (have.get(rel) !== digest) out.push(`changed: ${rel}`)
  }
  for (const rel of have.keys()) if (!want.has(rel)) out.push(`not in the manifest: ${rel}`)
  return out
}

/**
 * A temp copy of a frozen tree with every stored `.txt` suffix stripped. The caller removes
 * it (`rmSync(dir, { recursive: true, force: true })`).
 * @param {string} dir @returns {string}
 */
export function materialise(dir) {
  const out = mkdtempSync(join(tmpdir(), 'epah-eval-'))
  cpSync(dir, out, { recursive: true })
  for (const rel of walkFiles(out, { filter: (p) => STORED.test(p) })) {
    const abs = join(out, ...rel.split('/'))
    renameSync(abs, abs.slice(0, -'.txt'.length))
  }
  return out
}

/** Remove a temp tree. @param {string} dir */
export const removeTree = (dir) => rmSync(dir, { recursive: true, force: true })

/**
 * #186's sweep document over `dir`, with `dir` as the working directory for the call.
 * @param {string} dir @param {any} ts the parser, or null
 */
export function sweepIn(dir, ts) {
  const cwd = process.cwd()
  try {
    process.chdir(dir)
    return sweep(ts)
  } finally {
    process.chdir(cwd)
  }
}

/** The sweep's stdout bytes for a document, exactly as `--sweep --json` writes them. */
export const sweepBytes = (doc) => `${JSON.stringify(doc)}\n`

/** A record's label key: #185's advisoryKey, 16 hex. */
export const key16 = (record) => advisoryKey(record)

/** Read a JSON file. @param {string} file */
export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

/** Write a JSON file the way every eval file is written: two-space, one trailing newline. */
export const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)

/**
 * Score a sweep document against a label file's entries. A label verdict `true` is a hit
 * the rule should report; `decoy`, `false` and `deliberate` are hits it should not (a
 * deliberate mirror is real duplication the tree keeps on purpose); `pending` is a key the
 * maintainer has not labelled yet, counted apart and in no precision, as is a hit with no label.
 * @param {any[]} records @param {Record<string, { verdict: string }>} labels
 */
export function score(records, labels) {
  const unlabelled = []
  /** @type {Map<string, { hits: number, true: number, pending: number, unlabelled: number }>} */
  const by = new Map()
  for (const r of records) {
    const key = key16(r)
    const label = labels[key]
    const group = `${r.rule} ${r.facts.tier}`
    const row = by.get(group) ?? { hits: 0, true: 0, pending: 0, unlabelled: 0 }
    row.hits += 1
    if (label === undefined) {
      unlabelled.push(key)
      row.unlabelled += 1
    }
    else if (label.verdict === 'pending') row.pending += 1
    else if (label.verdict === 'true') row.true += 1
    by.set(group, row)
  }
  const families = [...by.entries()]
    .sort(([a], [b]) => cmp(a, b))
    .map(([group, row]) => {
      const [rule, tier] = group.split(' ')
      const decided = row.hits - row.pending - row.unlabelled
      return { rule, tier, ...row, precision: decided === 0 ? null : row.true / decided }
    })
  return { families, unlabelled: unlabelled.sort(cmp) }
}

/** A precision as text: three decimals, or `n/a` with nothing decided. */
export const ratio = (x) => (x === null ? 'n/a' : x.toFixed(3))
