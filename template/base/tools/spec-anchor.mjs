#!/usr/bin/env node
// spec-anchor — print one section of a spec, so a reviewer brief, an ADR or a later session
// can cite `specs/<feature>.md#<id>` instead of a whole file.
//
//   node tools/spec-anchor.mjs specs/<feature>.md#<id>   # the section, exit 0
//   node tools/spec-anchor.mjs specs/<feature>.md        # the index: id, line, heading
//
// A section is its heading and everything under it, up to the next heading of the same or a
// higher level, so a `##` section carries its `###` decisions. Ids are GitHub's heading
// anchors (tools/lib/spec-anchor.mjs says exactly how), so the same citation is a link on
// GitHub.
//
// Exit codes: 0 printed; 1 the id is unknown or ambiguous (two headings produce it), and
// stderr lists the file's ids; 2 the path is not a `.md` file under `<cwd>/specs/`, or the
// usage is wrong, and stdout stays empty. An absolute path, a path that leaves specs/
// through `..`, and a symlink whose target lies outside specs/ are all exit 2.
//
// It reads one file and writes nothing. It is a tool, not a gate: no chain or Stop step runs
// it and nothing reads its output, so it reports through its own exit codes rather than the
// gate library's failure line, which points at a gates-catalog entry and always exits 1.
// A spec written before the template had headings (bold labels) has no section ids; its
// index lists only the headings it does have.
// SOURCE: docs/harness/README.md (Spec-first SOP) [corpus: harness/doctrine]
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import process from 'node:process'
import { toPosix } from './lib/fs-walk.mjs'
import { findSection, formatIndex, parseHeadings, specPath } from './lib/spec-anchor.mjs'

const TOOL = 'spec-anchor'
const USAGE = 'usage: node tools/spec-anchor.mjs specs/<feature>.md[#<id>]'

/** @param {number} code @param {string} message @returns {never} */
function exit(code, message) {
  process.stderr.write(`${TOOL}: ${message}\n`)
  process.exit(code)
}

/**
 * Read the spec at `rel` (already lexically inside specs/), refusing a file whose real path
 * lies outside the real specs/ directory. Read first and judge the path the read used, so
 * nothing is checked on one inode and read from another.
 * @param {string} rel
 */
function readSpec(rel) {
  let root
  let file
  let text
  try {
    root = realpathSync(resolve('specs'))
    file = realpathSync(resolve(rel))
    text = readFileSync(file, 'utf8')
  } catch (e) {
    exit(2, `${rel} cannot be read (${e.code ?? e.message}); ${USAGE}`)
  }
  const inside = toPosix(relative(root, file))
  if (inside === '' || inside === '..' || inside.startsWith('../') || isAbsolute(inside)) {
    exit(
      2,
      `${rel} resolves outside specs/ (to ${toPosix(file)}); only a spec under specs/ is read`,
    )
  }
  return text
}

/** @param {number[]} lines at least two */
const lineList = (lines) => `lines ${lines.slice(0, -1).join(', ')} and ${String(lines.at(-1))}`

/** The stderr list after a refused id. @param {import('./lib/spec-anchor.mjs').Heading[]} headings */
const idList = (headings) =>
  formatIndex(headings).trimEnd() || '(none: a spec written with bold labels has no section ids)'

const args = process.argv.slice(2)
if (args.length !== 1) exit(2, USAGE)
const hash = args[0].indexOf('#')
const pathArg = hash === -1 ? args[0] : args[0].slice(0, hash)
const target = specPath(pathArg)
if (target.kind === 'refused')
  exit(2, `${pathArg || '(empty)'} is not a .md file under specs/: ${target.why}; ${USAGE}`)
const text = readSpec(target.rel)

if (hash === -1) {
  const index = formatIndex(parseHeadings(text))
  if (index === '') {
    process.stderr.write(
      `${TOOL}: ${target.rel} has no headings, so no section has an id (a spec written with bold labels predates the headed template)\n`,
    )
  }
  process.stdout.write(index)
} else {
  const id = args[0].slice(hash + 1)
  const found = findSection(text, id)
  if (found.kind === 'ambiguous') {
    exit(
      1,
      `#${id} is ambiguous in ${target.rel}: the headings at ${lineList(found.lines)} produce it. Rename all but one; the ids are:\n${idList(found.headings)}`,
    )
  }
  if (found.kind === 'unknown') {
    exit(
      1,
      `${target.rel} has no heading with the id '${id}'. Its ids are:\n${idList(found.headings)}`,
    )
  }
  process.stdout.write(found.text)
}
