// The obligations register's pure half — scripts/obligations.json judged as data, no I/O.
//
// WHAT PROBLEM THIS SOLVES. The release's forward-looking debts lived in three unjoined
// sources: the ramp fleet (rampNote call sites + template/migrations.json's records), the
// consumer deferral ledger (template/base/tools/deferrals.json), and prose — README loss
// sentences, gates-catalog paragraphs, design/CONFORMANCE-FACTS.md dispositions. The
// consumer side got its reader in 0.7.0 (check-docs-sync.mjs's deferral scan); the factory
// side got a SENTENCE — gates-catalog.md's docs-sync section flagged the gap "to the
// factory-coverage workstream" — and a sentence is exactly the control this repository
// deletes. A verbatim port of the consumer scan was considered and rejected as VACUOUS:
// the factory's prose carries near-zero "Deferred to x.y.z" sentences, so the port would
// have scanned faithfully and found nothing while the real debts sat unread in three
// formats. The fix is the REGISTER: one machine-read home for every open obligation, with
// a KIND discriminator deciding which clock (if any) may judge it.
//
// THE THREE KINDS, and why the split is load-bearing:
//   release   — target is x.y.z; reds when package.json reaches it. CLOCKLESS (arithmetic
//               over two committed values — check-ramp-ledger.mjs's version authority), so
//               it rides the per-PR machinery block and the same SHA answers the same way
//               forever.
//   calendar  — target is YYYY-MM-DD; judged ONLY under an explicit --clockful flag, wired
//               into the SCHEDULED hygiene lane and nothing else. A verdict that changes
//               with the date must never red a PR — the corpus-fidelity split (network
//               redness is a property of the internet that day), applied to time.
//   condition — target is null; NEVER reds on time. The bar is shape + evidence (a URL or
//               a repo file ref a reviewer can follow), and discharging one is DELETING it
//               in a reviewed diff. Undated is a reviewed disposition here, not a gap —
//               design/CONFORMANCE-FACTS.md §8 records why dating a debt you do not intend
//               to build next is the failure mode.
//
// Shape checks FAIL CLOSED: a row the reader cannot classify is a red, never a skip — an
// unreadable obligation is how a date rolls past while still reading as a plan.
//
// SITES ARE ANCHORS, ONE-WAY BY DESIGN. A row may carry sites[] = {file, mustContain?}
// pointing at the prose it indexes; every anchor must resolve (the file exists, the
// sentence is present). The reverse closure — every dated factory sentence must have a row
// — is deliberately NOT asserted: that is the consumer scan's grammar, and factory-side it
// is the vacuous port (zero regex hits). The register is the index; the sites are anchors.
// SOURCE: template/base/tools/check-docs-sync.mjs (the deferral-ledger grammar this
// adapts) · scripts/check-ramp-ledger.mjs (the clockless version authority)
import { cmpDotted } from './ramp-sites.mjs'

const KINDS = new Set(['release', 'calendar', 'condition'])
const RELEASE_RE = /^\d+\.\d+\.\d+$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const ID_RE = /^[a-z0-9][a-z0-9-]*$/

/**
 * Per-row shape problems for one row, id/kind aside (those are the caller's, because
 * duplicates and unknown kinds need the row LIST to judge).
 * @param {any} row
 * @returns {string[]}
 */
function fieldProblems(row) {
  const out = []
  if (row.kind === 'release' && (typeof row.target !== 'string' || !RELEASE_RE.test(row.target))) {
    out.push("a release row's target must be x.y.z — a target nothing can compare is a deadline with no date")
  }
  if (row.kind === 'calendar' && (typeof row.target !== 'string' || !DATE_RE.test(row.target))) {
    out.push("a calendar row's target must be YYYY-MM-DD — the clockful lane compares it to the date it runs")
  }
  if (row.kind === 'condition' && row.target !== null) {
    out.push('a condition row\'s target must be null — a dated condition is a calendar row wearing the kind that never expires')
  }
  if (row.kind === 'condition' && (typeof row.evidence !== 'string' || row.evidence.trim() === '')) {
    out.push('a condition row REQUIRES evidence (a URL or a repo file ref) — a condition nobody can check is a wish, and a wish never discharges')
  }
  if (typeof row.reason !== 'string' || row.reason.trim().length < 40) {
    out.push('reason must carry at least 40 characters — an unreasoned obligation is not a review')
  }
  if (typeof row.reviewedOn !== 'string' || !DATE_RE.test(row.reviewedOn)) {
    out.push('reviewedOn must be a YYYY-MM-DD date — an undated review cannot go stale visibly')
  }
  if (row.sites !== undefined) {
    if (!Array.isArray(row.sites) || row.sites.some((s) => typeof s?.file !== 'string' || s.file.trim() === '')) {
      out.push("sites must be an array of { file, mustContain? } — an anchor with no file anchors nothing")
    }
  }
  return out
}

/**
 * Shape problems over the whole register: ids, kinds, per-kind field shapes. Fails
 * closed — a malformed row is reported and every well-formed row is still judged.
 * @param {any[]} rows
 * @returns {string[]}
 */
export function rowShapeProblems(rows) {
  const problems = []
  const seen = new Set()
  for (const row of rows) {
    const id = typeof row?.id === 'string' && ID_RE.test(row.id) ? row.id : null
    const label = `row '${String(row?.id ?? '?')}'`
    if (id === null) {
      problems.push(`${label}: id must be a non-empty kebab-case string — the id is what a discharge deletes`)
    } else if (seen.has(id)) {
      problems.push(`duplicate id '${id}' — two rows under one name is how a discharge deletes the wrong one`)
    } else {
      seen.add(id)
    }
    if (!KINDS.has(row?.kind)) {
      problems.push(
        `${label}: kind ${JSON.stringify(row?.kind)} is not one of release|calendar|condition — a row the reader cannot classify fails closed, because an unreadable obligation is how a date rolls past while still reading as a plan`,
      )
      continue
    }
    for (const p of fieldProblems(row)) problems.push(`${label}: ${p}`)
  }
  return problems
}

/**
 * The time judgements, split by the discriminator. `release` rows are judged against
 * `version` unconditionally (clockless). `calendar` rows are judged against `today` ONLY
 * when `clockful` is set — the caller owns wiring that flag to the scheduled lane and
 * nowhere else. `condition` rows are never judged here at all.
 * @param {any[]} rows
 * @param {{ version: string, clockful: boolean, today?: string }} input
 * @returns {string[]}
 */
export function timeProblems(rows, { version, clockful, today }) {
  const problems = []
  for (const row of rows) {
    if (row?.kind === 'release' && typeof row.target === 'string' && RELEASE_RE.test(row.target)) {
      if (cmpDotted(version, row.target) >= 0) {
        problems.push(
          `release obligation '${row.id}' targeted ${row.target} and package.json is ${version} — the release has ARRIVED. Ship the discharge and DELETE the row, or re-target it in a reviewed diff (the register is committed data, so moving a target is a visible act, never a flag).`,
        )
      }
    }
    if (clockful && row?.kind === 'calendar' && typeof row.target === 'string' && DATE_RE.test(row.target)) {
      const now = today ?? new Date().toISOString().slice(0, 10)
      if (now >= row.target) {
        problems.push(
          `calendar obligation '${row.id}' fell due ${row.target} (today is ${now}) — the scheduled lane is the only caller allowed to say so. Do the dated re-verification the reason prescribes, then delete or re-date the row in a reviewed diff.`,
        )
      }
    }
  }
  return problems
}

/**
 * The census union: every consumer deferral (template/base/tools/deferrals.json) must
 * have a register row carrying ITS id, of a kind that can discharge it (condition when
 * the blocker is external, release when the debt is version-dated). Without this the two
 * ledgers drift — the exact three-unjoined-sources failure the register exists to end.
 * @param {any[]} rows
 * @param {string[]} deferralIds
 * @returns {string[]}
 */
export function censusProblems(rows, deferralIds) {
  const problems = []
  for (const id of deferralIds) {
    const row = rows.find((r) => r?.id === id)
    if (row === undefined) {
      problems.push(
        `template/base/tools/deferrals.json entry '${id}' has no register row — the consumer ledger and the factory register must agree on the open set, so every deferral needs a condition-or-release row here under the same id.`,
      )
    } else if (row.kind !== 'condition' && row.kind !== 'release') {
      problems.push(
        `template/base/tools/deferrals.json entry '${id}' is registered as kind '${String(row.kind)}' — a deferral discharges on a release or an upstream condition, never on the calendar.`,
      )
    }
  }
  return problems
}

/**
 * The ramp union: every shipped rampNote site whose deadline is still in the FUTURE —
 * `until` strictly above `base`, where base is the newest of package.json and the highest
 * template/migrations.json record — must be represented by a release row targeting that
 * expiry version and naming the gate in its id. Sites at or below `base` are already paid
 * by the current release's rampExpiry record (check-ramp-ledger.mjs computes that
 * population); the future ones are the debt the NEXT record will owe, and this is where
 * that debt is written down before it is due.
 *
 * Anti-vacuity first: a scan that found no sites at all proves nothing, so it reds — the
 * exact rule check-ramp-ledger.mjs applies to its own fleet.
 * @param {Array<{gate: string, until: string|null, file: string}>} sites
 * @param {any[]} rows
 * @param {string} base
 * @returns {string[]}
 */
export function rampObligationProblems(rows, sites, base) {
  if (sites.length === 0) {
    return [
      'the ramp scan found no rampNote() call sites at all — the fleet is never empty, so the scanner is not seeing the calls and the ramp-expiry union below would pass vacuously',
    ]
  }
  const problems = []
  const future = sites.filter((s) => s.until !== null && cmpDotted(s.until, base) > 0)
  for (const site of future) {
    const covered = rows.some(
      (r) => r?.kind === 'release' && r.target === site.until && typeof r.id === 'string' && r.id.includes(site.gate),
    )
    if (!covered) {
      problems.push(
        `gate '${site.gate}' (${site.file}) carries a ramp with until: '${site.until}' — a deadline the ${site.until} record will owe — but no kind:release row here targets ${site.until} with '${site.gate}' in its id. Add the row now, so the expiry is a debt the register carries rather than a surprise the release meets.`,
      )
    }
  }
  return problems
}
