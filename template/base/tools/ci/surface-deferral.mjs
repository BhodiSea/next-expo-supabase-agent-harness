#!/usr/bin/env node
// tools/ci/surface-deferral.mjs — read tools/surfaces.json, the dated deferral of a surface
// that is not built yet (1.1.0), and say whether a pull request may skip the device lanes.
//
// Two callers, two modes, and the difference between them is the design:
//   --mode=pr      the `changes` job in quality-gate.yml, on every pull request. Stdout is
//                  EXACTLY two lines, appended to $GITHUB_OUTPUT:
//                    mobile-deferred=true|false
//                    mobile-deferral=<until>: <reason>     (empty value when not deferred)
//                  Everything else, the table included, goes to stderr. It exits 1 only on a
//                  malformed register or a corrupt manifest, and still prints the two lines
//                  first, as `false`. A date or an edited tree can only turn a skip into a
//                  run, so a lapsed or void row exits 0: it never reds an unrelated PR.
//                  With an absent or empty register it reads nothing else, so an install
//                  that never writes a row gains no new way for `changes` to fail.
//   --mode=review  the scheduled `floor-review` job in osv-scan.yml. It reds on any expired,
//                  void or malformed row, so a stale deferral reds on the schedule, naming
//                  the row, and not on somebody's pull request. An absent or empty register
//                  is a NOTE.
// The clock is a parameter (`--today=YYYY-MM-DD`, default the UTC date), so the red-proof
// can move the calendar without waiting for it.
//
// Where a deferral reaches: mobile-e2e and perf-lane, on `pull_request` only. Scheduled and
// dispatched runs keep both lanes, no other job's `if:` reads the output, and gate-summary
// shows the reason beside a skipped lane without ever counting the skip as a pass.
//
// The judgement is tools/lib/surface-deferral.mjs (pure). This file owns the reads: the
// register, the install record (through lib/gate.mjs's fail-closed read), one
// `git ls-files`, and a sha256 over each tracked file under the surface's tree.
//   usage: node tools/ci/surface-deferral.mjs --mode=pr|review [--today=YYYY-MM-DD]
// SOURCE: docs/harness/gates-catalog.md (the device lanes; the surface deferral)
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import process from 'node:process'
// readManifest is new in 1.1.0. `update` parks the incoming copy of a FORKED lib/gate.mjs
// and plants this script anyway, so a named import of it would fail `changes` at link time
// on such an install. Reached through the namespace, a fork without it reads as "the
// manifest could not be read", which voids a row: the lanes run.
import * as gateLib from '../lib/gate.mjs'
import { fail, failures, MAX_BUFFER, ok } from '../lib/gate.mjs'
import {
  classifyRows,
  parseRegister,
  prOutputs,
  REGISTER_PATH,
  reviewProblems,
  SURFACES,
} from '../lib/surface-deferral.mjs'

const GATE = 'surface-deferral'
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const HINT = `\nA deferral is a reviewed row in ${REGISTER_PATH}: { "surface": "mobile", "deferredUntil": "YYYY-MM-DD", "reason": "<one line>" }. Fix the row, or delete it; either way it lands as a commit a human reviews.`

/** @param {string} name @param {string} fallback */
const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback

/** The two lines --mode=pr owes $GITHUB_OUTPUT, and nothing else ever reaches stdout. */
function emit(/** @type {{ deferred: boolean, deferral: string }} */ out) {
  process.stdout.write(`mobile-deferred=${String(out.deferred)}\nmobile-deferral=${out.deferral}\n`)
}

/** @param {string} line */
const note = (line) => console.error(`${GATE}: ${line}`)

/** The register's text, or null when it is absent. Any other read error is a problem. */
function readRegister() {
  try {
    return { text: readFileSync(REGISTER_PATH, 'utf8'), problems: [] }
  } catch (e) {
    if (e.code === 'ENOENT') return { text: null, problems: [] }
    return { text: null, problems: [`${REGISTER_PATH} cannot be read (${e.code ?? e.message}).`] }
  }
}

/**
 * Every tracked file under the deferred surfaces' trees, with the sha256 of its bytes.
 * @param {string[]} trees
 * @returns {{ files: Array<{ path: string, sha256?: string, error?: string }> | null, listError?: string }}
 */
function trackedFiles(trees) {
  let listing
  try {
    listing = execFileSync(
      'git',
      ['ls-files', '-z', '--', ...trees.map((t) => t.replace(/\/$/, ''))],
      {
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
  } catch (e) {
    const detail = String(e.stderr ?? e.message)
      .trim()
      .split('\n')[0]
    return { files: null, listError: `git ls-files failed: ${detail}` }
  }
  const files = listing
    .split('\0')
    .filter(Boolean)
    .map((path) => {
      try {
        return { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }
      } catch (e) {
        return { path, error: e.code ?? e.message }
      }
    })
  return { files }
}

/**
 * The install record. A corrupt one FAILS (it is write-guarded, so corrupt is tampering),
 * and in PR mode the two `false` lines go out first.
 * @param {() => void} [onCorrupt]
 */
function readInstallRecord(onCorrupt) {
  if (typeof gateLib.readManifest !== 'function') {
    return {
      manifest: null,
      manifestError:
        'tools/lib/gate.mjs has no readManifest export (a forked copy from before 1.1.0)',
    }
  }
  return { manifest: gateLib.readManifest(GATE, onCorrupt) }
}

/**
 * Judge the well-formed rows against the tree.
 * @param {import('../lib/surface-deferral.mjs').Row[]} rows @param {string} today
 * @param {() => void} [onCorrupt]
 */
function judge(rows, today, onCorrupt) {
  const { manifest, manifestError } = readInstallRecord(onCorrupt)
  if (manifestError !== undefined) {
    return classifyRows({ rows, today, manifest, files: null, manifestError })
  }
  const trees = [...new Set(rows.map((r) => SURFACES[r.surface].tree))]
  return classifyRows({ rows, today, manifest, ...trackedFiles(trees) })
}

/**
 * One line per row (and per void cause), to the given sink.
 * @param {import('../lib/surface-deferral.mjs').Classified[]} classified @param {string} today
 * @param {(line: string) => void} say
 */
function table(classified, today, say) {
  for (const row of classified) {
    const tree = SURFACES[row.surface].tree
    if (row.status === 'void') {
      for (const cause of row.causes) say(`${row.surface} deferral VOID — ${cause}`)
    } else if (row.status === 'expired') {
      say(
        `${row.surface} deferral EXPIRED — its last deferred day was ${row.deferredUntil} (today is ${today})`,
      )
    } else if (row.compared === 0) {
      say(
        `${row.surface} deferral LIVE until ${row.deferredUntil} — zero files were compared: nothing under ${tree} is tracked or recorded (an install with no ${row.surface} app)`,
      )
    } else {
      say(
        `${row.surface} deferral LIVE until ${row.deferredUntil} — ${String(row.compared)} file(s) under ${tree} match the sha the installer recorded`,
      )
    }
  }
}

/** @param {string} today */
function prMode(today) {
  const read = readRegister()
  const { rows, problems } = parseRegister(read.text)
  problems.unshift(...read.problems)
  if (problems.length === 0 && rows.length === 0) {
    emit({ deferred: false, deferral: '' })
    note(
      `no deferral is registered (${REGISTER_PATH} is ${read.text === null ? 'absent' : 'empty'}) — a mobile change runs mobile-e2e and perf-lane`,
    )
    return
  }
  const classified =
    problems.length === 0 ? judge(rows, today, () => emit({ deferred: false, deferral: '' })) : []
  const out = prOutputs(classified, problems)
  emit(out)
  table(classified, today, note)
  failures(GATE, problems, HINT)
  const lanes = SURFACES.mobile.lanes.join(' and ')
  note(
    out.deferred
      ? `${lanes} are SKIPPED on this pull request while the row is live; scheduled and dispatched runs keep both`
      : `${lanes} run on a mobile change`,
  )
}

/** @param {string} today */
function reviewMode(today) {
  const read = readRegister()
  const { rows, problems } = parseRegister(read.text)
  problems.unshift(...read.problems)
  if (problems.length === 0 && rows.length === 0) {
    console.log(
      `${GATE}: NOTE — ${REGISTER_PATH} is ${read.text === null ? 'absent' : 'empty'}, so no surface is deferred and there is nothing to review.`,
    )
    return
  }
  const classified = rows.length > 0 ? judge(rows, today) : []
  table(classified, today, (line) => console.log(`${GATE}: ${line}`))
  failures(GATE, [...problems, ...reviewProblems(classified, today)], HINT)
  ok(GATE, `${String(classified.length)} deferral(s) live as of ${today}`)
}

const mode = arg('mode', '')
const today = arg('today', new Date().toISOString().slice(0, 10))
if (!ISO_DATE.test(today)) fail(GATE, `--today=${today} is not a YYYY-MM-DD date.`)
if (mode === 'pr') prMode(today)
else if (mode === 'review') reviewMode(today)
else
  fail(
    GATE,
    `--mode=${mode || '<missing>'} — pass --mode=pr (the changes job) or --mode=review (the scheduled floor-review job).`,
  )
