#!/usr/bin/env node
// check-obligations — the factory's own forward-looking debts, in ONE machine-read home.
//
// gates-catalog.md's docs-sync section recorded the gap this discharges: the consumer
// deferral scan reads the template's OWNED surfaces only, and "a factory-side dated
// sentence needs a factory-side reader". The reader is this file; the subject is
// scripts/obligations.json — the register of every obligation the release carries
// forward, each row { id, kind: release|calendar|condition, target, sites?, reason,
// reviewedOn, evidence? }. The pure judgements live in scripts/lib/obligations.mjs; this
// file owns the I/O and the two lane wirings:
//
//   CLOCKLESS (no flag)  — lint.yml's machinery block + local runs. Judges shape, the
//                          anchors, the census and ramp unions, and kind:release arrival
//                          against package.json (check-ramp-ledger.mjs's version
//                          authority). Same SHA, same verdict, any machine, any day.
//   CLOCKFUL (--clockful) — hygiene.yml's SCHEDULED job ONLY — never the factory Stop
//                          chain, never lint. Adds the kind:calendar judgement, because a
//                          verdict that changes with the date must never red a PR: the
//                          same split the repo already runs for cc-floor/framework-floor
//                          (clockless, in-chain) vs floor-review (scheduled), and for
//                          corpus-fidelity's offline/network halves.
//
// WHAT IS DELIBERATELY NOT LEDGERED HERE: .harness/pending/source-fixes.json. That
// artifact is CONSUMER-side — `update` parks it on the INSTALL and it self-clears when
// the consumer's tree stops matching the recorded broken shape (template/migrations.json
// seededSourceFixes is its reviewed source, checked by scripts/check-seeded-migrations.mjs).
// A factory register row for it would be a second, staler copy of a record that already
// has an owner and a prober.
// SOURCE: docs/harness/gates-catalog.md (docs-sync, the factory-coverage sentence) ·
// scripts/check-ramp-ledger.mjs (the clockless version authority)
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  censusProblems,
  rampObligationProblems,
  rowShapeProblems,
  timeProblems,
} from './lib/obligations.mjs'
import { cmpDotted, shippedRampSites } from './lib/ramp-sites.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const rel = (p) => new URL(p, import.meta.url)
const CLOCKFUL = process.argv.includes('--clockful')

const problems = []

/** @type {any[]} */
let rows = []
let raw
try {
  raw = JSON.parse(readFileSync(rel('./obligations.json'), 'utf8'))
} catch (e) {
  problems.push(
    `scripts/obligations.json is not valid JSON (${e instanceof Error ? e.message : String(e)}) — an unreadable register fails CLOSED rather than un-dating every obligation; restore it from git history`,
  )
}
if (raw !== undefined && !Array.isArray(raw.obligations)) {
  problems.push(
    'scripts/obligations.json has no `obligations` array — a register with no readable rows un-dates every obligation; restore it from git history',
  )
} else if (raw !== undefined) {
  rows = raw.obligations
}

const version = JSON.parse(readFileSync(rel('../package.json'), 'utf8')).version

// 1. Shape, fail-closed.
problems.push(...rowShapeProblems(rows))

// 2. Anchors. Every sites[] entry must resolve — the file exists, and (when given) the
//    sentence the row indexes is present. ONE-WAY by design: the register is the index,
//    the sites are anchors; the reverse closure is the consumer scan's job on its own
//    surfaces, and factory-side it was the vacuous-port trap (zero regex hits).
for (const row of rows) {
  for (const site of Array.isArray(row?.sites) ? row.sites : []) {
    if (typeof site?.file !== 'string' || site.file.trim() === '') continue // shape check reported it
    const abs = new URL(site.file, `file://${ROOT}`)
    if (!existsSync(abs)) {
      problems.push(
        `row '${String(row.id)}': site ${site.file} does not exist — an anchor that outlives its prose is a second stale doctrine; fix the path or delete the row in the diff that moved the file`,
      )
      continue
    }
    if (typeof site.mustContain === 'string' && !readFileSync(abs, 'utf8').includes(site.mustContain)) {
      problems.push(
        `row '${String(row.id)}': ${site.file} does not contain ${JSON.stringify(site.mustContain)} — the sentence this row indexes has moved or been rewritten; re-anchor the row (or delete it) in the same diff that changed the prose`,
      )
    }
  }
  // Evidence must be followable: a URL is accepted as written (resolving it is network
  // work, and network flake must never red this lane — corpus-fidelity owns dead links);
  // anything else is a repo file ref and must exist.
  if (row?.kind === 'condition' && typeof row.evidence === 'string' && row.evidence.trim() !== '') {
    if (!/^https?:\/\//.test(row.evidence) && !existsSync(new URL(row.evidence, `file://${ROOT}`))) {
      problems.push(
        `row '${String(row.id)}': evidence ${row.evidence} is neither a URL nor a file this tree carries — evidence a reviewer cannot follow does not exist`,
      )
    }
  }
}

// 3. Time, per the discriminator. Release rows clockless; calendar rows only here under
//    --clockful; condition rows never.
problems.push(...timeProblems(rows, { version, clockful: CLOCKFUL }))

// 4. The census union over the consumer deferral ledger.
const deferralsUrl = rel('../template/base/tools/deferrals.json')
if (existsSync(deferralsUrl)) {
  const deferrals = JSON.parse(readFileSync(deferralsUrl, 'utf8'))
  const ids = (Array.isArray(deferrals?.deferrals) ? deferrals.deferrals : [])
    .map((d) => (typeof d?.id === 'string' ? d.id : null))
    .filter((id) => id !== null)
  problems.push(...censusProblems(rows, ids))
} else {
  problems.push(
    'template/base/tools/deferrals.json is missing — the census union has no consumer ledger to close over, and a closure that cannot see its universe fails closed',
  )
}

// 5. The ramp union. `base` is the newest of package.json and the highest
//    template/migrations.json record: deadlines at or below it are the CURRENT release's
//    rampExpiry business (check-ramp-ledger.mjs computes that population); deadlines
//    strictly above it are the next record's debt and must already be rows here.
const migrations = JSON.parse(readFileSync(rel('../template/migrations.json'), 'utf8'))
const base = Object.keys(migrations)
  .filter((k) => /^\d+\.\d+\.\d+$/.test(k))
  .reduce((hi, k) => (cmpDotted(k, hi) > 0 ? k : hi), version)
problems.push(...rampObligationProblems(rows, shippedRampSites(), base))

if (problems.length > 0) {
  console.error(`OBLIGATIONS: ${String(problems.length)} problem(s):`)
  for (const p of problems) console.error(`  - ${p}`)
  console.error(
    '\nAn obligation is a debt with a discharge condition. One with no row is a debt nobody wrote down, one whose row nothing reads is a sentence, and one that reds a PR on the calendar is a verdict about the day, not the tree.',
  )
  process.exit(1)
}

const counts = { release: 0, calendar: 0, condition: 0 }
for (const row of rows) counts[row.kind] += 1
console.log(
  `OBLIGATIONS: CLEAN (${String(counts.release)} release / ${String(counts.calendar)} calendar / ${String(counts.condition)} condition row(s) at v${version}; ` +
    `census + ramp unions closed; calendar rows ${CLOCKFUL ? 'judged (clockful)' : 'deferred to the clockful lane (hygiene schedule)'})`,
)
