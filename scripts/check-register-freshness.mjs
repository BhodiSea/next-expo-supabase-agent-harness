#!/usr/bin/env node
// scripts/check-register-freshness.mjs — have the SHIPPED review-dated registers lapsed?
//
// WHY THIS IS FACTORY-SIDE, WHEN A CONSUMER LANE ALREADY ASKS THE SAME QUESTION. The
// consumer's scheduled `floor-review` job judges tools/framework-floor.json and
// tools/eol.json against today — but it only exists INSIDE AN INSTALL. The copies in
// template/base/tools/ are the seeds every future scaffold is rendered from, and nothing
// anywhere judges those. So a review can lapse in the factory and the first thing to
// notice is a consumer who scaffolds and waits a week for their own cron: every project
// generated between the lapse and the next harness release ships a register whose review
// had already expired on arrival, and its first `floor-review` reds a tree the consumer
// created that morning for research the HARNESS never re-read. This is that gap, closed
// where the artefact is authored — the same argument scripts/check-tier-coverage.mjs and
// scripts/check-essential-eight-evidence.mjs make for living here.
//
// WHY IT IS SCHEDULE-ONLY. Both verdicts change with the date and nothing else, so a
// PR-blocking home would red an untouched commit overnight. It rides hygiene.yml's
// scheduled block beside `obligations-clockful`, which is the same split for the same
// reason. The CLOCKLESS half of both registers' review discipline — is the window the
// reviewer granted themselves bounded at all — is not here: `reviewWindowProblems` and
// `eolReviewWindow` run inside the shipped gates on every consumer chain, and the factory
// runs them over these same seeds through the gates' own test suites.
//
// WHAT IT DELIBERATELY DOES NOT JUDGE. tools/essential-eight.json's per-row `reviewedOn`.
// The register's shelf life is real and already owned: the obligations row
// `conformance-e8-retirement` carries 2027-06-15 — ASD opened consultation on 15 Jun 2026
// to replace the Essential Eight — and is judged one job over, in --clockful. A review
// window here would be a second, staler copy of a verdict that has an owner, and the
// number it needed would be invented rather than published.
//
// THE JUDGEMENTS ARE THE SHIPPED ONES, imported rather than re-implemented: two copies of
// "has this lapsed" is how the factory and a consumer come to disagree about one date.
//   usage: node scripts/check-register-freshness.mjs [--today=YYYY-MM-DD]
// SOURCE: template/base/tools/lib/framework-floor.mjs (staleReviews) ·
// template/base/tools/lib/eol.mjs (staleEolReview) · scripts/check-obligations.mjs (the
// clockless/clockful split this follows)
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { staleEolReview } from '../template/base/tools/lib/eol.mjs'
import { staleReviews } from '../template/base/tools/lib/framework-floor.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Every seed that carries a review window, with the shipped judgement that reads it.
 * A register added here without an entry is a register nothing watches, which is why the
 * anti-vacuity guard below counts what it actually reached rather than trusting the list.
 */
const SEEDS = [
  {
    path: 'template/base/tools/framework-floor.json',
    /** @param {any} doc @param {string} today */
    judge: (doc, today) => staleReviews({ floor: doc, today }),
  },
  {
    path: 'template/base/tools/eol.json',
    /** @param {any} doc @param {string} today */
    judge: (doc, today) => staleEolReview({ register: doc, path: 'tools/eol.json', today }),
  },
]

const todayArg = process.argv.find((a) => a.startsWith('--today='))
// A `--today=` parameter exists so the red-proof does not have to wait for a calendar —
// the same reason tools/check-framework-floor.mjs takes one, and the reason its canary
// entry can be `kind: fixture` rather than a structural claim.
const today = todayArg === undefined ? new Date().toISOString().slice(0, 10) : todayArg.slice(8)
if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
  process.stderr.write(`REGISTER FRESHNESS: --today must be an ISO date (YYYY-MM-DD); got ${today}\n`)
  process.exit(2)
}

const problems = []
let judged = 0

for (const seed of SEEDS) {
  let doc
  try {
    doc = JSON.parse(readFileSync(join(ROOT, seed.path), 'utf8'))
  } catch (e) {
    // Fail CLOSED. An unreadable register is not a fresh one, and skipping it here would
    // silently retire the only control that reads its dates.
    problems.push(
      `${seed.path} is missing or unparseable (${e instanceof Error ? e.message : String(e)}) — a seed nobody can read is a seed nobody can date; restore it from git history.`,
    )
    continue
  }
  problems.push(...seed.judge(doc, today))
  judged += 1
}

// Anti-vacuity, in the shape check-secrets.mjs and check-obligations.mjs already use:
// zero registers reached is a hard FAIL, never a green "nothing to do". A rename that
// moved both seeds would otherwise turn this job into decoration on the day it mattered.
if (judged === 0) {
  problems.push(
    `no shipped register was read at all (${String(SEEDS.length)} declared) — this job asserts freshness by reading dates, so reading none of them is a failure and not a pass.`,
  )
}

if (problems.length > 0) {
  process.stderr.write(`REGISTER FRESHNESS: ${String(problems.length)} problem(s) (today is ${today}):\n`)
  for (const p of problems) process.stderr.write(`  - ${p}\n`)
  process.stderr.write(
    '\nThese are the SEEDS every new scaffold is rendered from. A lapsed one ships a register that expired before the consumer created their project, and their first floor-review reds it for research this repository never re-read. Re-read the upstream feeds, move the rows AND the dates in one commit.\n',
  )
  process.exit(1)
}

process.stdout.write(
  `REGISTER FRESHNESS: CLEAN (${String(judged)} shipped register(s) carry a live review as of ${today})\n`,
)
