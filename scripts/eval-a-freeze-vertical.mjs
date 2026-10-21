#!/usr/bin/env node
// Freeze one blind vertical into eval A's holdout (2.1.0, #188; plan v2 §11 A).
//
// A blind vertical is a vertical slice an agent wrote in a fresh install from
// tests/evals/a/blind-vertical.prompt.md and the shipped slice skill, without seeing the
// Single Home rules. Generating one costs 3 to 6M tokens, so it is the maintainer's (#194);
// this script only freezes the result, and checks a frozen one.
//
//   --from <install> --n <k>   copy what the sweep reads from the install (the same subset
//                              eval B's fixture keeps: TS sources under apps/ and packages/,
//                              every workspace manifest, supabase/schemas and migrations, the
//                              census and the rule files, .dependency-cruiser.cjs stored as
//                              `.cjs.txt`) into tests/evals/a/holdout/vertical-<k>/, and write
//                              its digest manifest, vertical-<k>.sha256, beside it.
//   --check <dir>              validate a frozen vertical: its manifest (`<dir>.sha256`)
//                              matches its files, it holds no `.js`, `.mjs` or `.cjs` file
//                              (eslint and knip would read one), and it has a vertical: a
//                              packages/verticals/<name>/package.json and at least one TS
//                              source under that vertical's src/.
//
// Exit 0 when the freeze or the check succeeds, 1 with one line per problem otherwise.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { walkFiles } from '../template/base/tools/lib/fs-walk.mjs'
import { keptAs } from './lib/eval-b-fixture.mjs'
import { checkManifest, writeManifest } from './lib/evals.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const HOLDOUT = join(ROOT, 'tests/evals/a/holdout')
const USAGE = 'usage: node scripts/eval-a-freeze-vertical.mjs --from <install> --n <k> | --check <dir>'
const EXCLUDE = new Set(['node_modules', 'dist', 'coverage', '.next', '.expo', '.turbo', '.git'])

/** Every problem with a frozen vertical at `dir`. @param {string} dir @returns {string[]} */
export function checkVertical(dir) {
  if (!existsSync(dir)) return [`${dir}: no such directory`]
  const problems = checkManifest(dir, `${dir}.sha256`)
  const all = walkFiles(dir)
  for (const rel of all.filter((p) => /\.(js|mjs|cjs)$/.test(p))) problems.push(`JavaScript in a frozen tree: ${rel}`)
  const verticals = all
    .map((p) => /^packages\/verticals\/([^/]+)\/package\.json$/.exec(p)?.[1])
    .filter((v) => v !== undefined)
  const withSource = verticals.filter((v) => all.some((p) => p.startsWith(`packages/verticals/${v}/src/`) && /\.tsx?$/.test(p)))
  if (withSource.length === 0) problems.push('no vertical: no packages/verticals/<name>/package.json with TS sources under its src/')
  return problems
}

/** Freeze an install's sweep inputs as vertical `n`. @returns {string[]} problems */
export function freezeVertical(from, n, holdout = HOLDOUT) {
  const dest = join(holdout, `vertical-${String(n)}`)
  if (existsSync(dest)) return [`${dest} exists: a frozen vertical is never refrozen in place`]
  for (const rel of walkFiles(from, { excludeDirs: EXCLUDE })) {
    const as = keptAs(rel)
    if (as === null) continue
    const to = join(dest, ...as.split('/'))
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(join(from, ...rel.split('/')), to)
  }
  if (!existsSync(dest)) return [`${from}: nothing the sweep reads`]
  writeManifest(dest, `${dest}.sha256`)
  return checkVertical(dest)
}

/** @param {string[]} argv @returns {number} */
export function main(argv) {
  const value = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined)
  let problems
  if (argv[0] === '--check' && argv.length === 2) problems = checkVertical(resolve(argv[1]))
  else if (argv.length === 4 && value('--from') !== undefined && /^[1-9]\d*$/.test(value('--n') ?? '')) {
    problems = freezeVertical(resolve(value('--from')), Number(value('--n')))
  } else {
    console.error(USAGE)
    return 1
  }
  for (const p of problems) console.error(`eval A vertical: ${p}`)
  if (problems.length === 0) console.log('eval A vertical: ok')
  return problems.length === 0 ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2))
}
