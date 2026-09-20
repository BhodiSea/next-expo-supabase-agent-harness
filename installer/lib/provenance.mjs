// Provenance (1.0.2): did a RELEASE ship these bytes — the question `sha256(current) ===
// recordedSha` was standing in for, and cannot answer.
//
// The manifest sha says the file matches what was RECORDED. It does not say who recorded
// it. A consumer who forks an owned file re-records its sha, because that is the only way
// to keep their own `gate-integrity` green; the installer does the same to bytes no release
// ever shipped (retrofit-merged settings, a human-merged config whose conflict was just
// resolved). To a classifier that only compares file and record, every one of those is
// "pristine", and `update` overwrote it — or `disable` and a `removed` migration deleted it.
//
// The evidence that separates them is what the harness actually shipped: template/shas/
// <version>.json lists, per OWNED install path, every byte-variant a commit carrying that
// version put on `main` (the documented install command carries no tag, so an untagged
// commit is a release as far as an install is concerned). Shas are over the template
// SOURCE, tokens intact, because the rendered bytes differ per project; `sites` records
// where the tokens sat so the source can be rebuilt from an installed copy. No historical
// blob ships.
//
// Pure judgements first, then the one IO loader, then the policy object the commands
// share — so update's sweep, --refresh-seeded, enable/disable and the removed/renamed
// migrations cannot drift apart the way four inline copies of the old test did.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { renderEntry, templateRoot } from './copy.mjs'
import { installerVersion, sha256 } from './manifest.mjs'
import { cmpVersions } from './migrations.mjs'
import { classifyDrift } from './reconcile.mjs'

/** @typedef {{ sha256: string, sites?: Array<[number, string]> }} Variant */
/** @typedef {Record<string, Record<string, Variant[]>>} Tables version → install path → variants */
/** @typedef {{ recordedSha: string, current: Buffer | string | null, answers: Record<string, unknown> }} Evidence */
/** @typedef {{ kind: 'released' | 'older-release', version: string } | { kind: 'fork' | 'unverifiable' | 'derived' }} Verdict */

// Owned files whose INSTALLED bytes are derived at plan time rather than copied, so no
// table can ever vouch for them: init and update inject a project reference per module
// package into the root tsconfig.json and prune the ones this install withholds
// (tsconfig-references.mjs). Judging it would park it on the second update of every
// install that has a module package or a withheld exemplar — a fork verdict about a file
// nobody edited. It keeps the pre-1.0.2 behaviour. scripts/generate-released-shas.mjs
// proves this list COMPLETE on every table it writes: it runs the commit's own `init` and
// requires every other owned manifest sha to be explained.
export const DERIVED_AT_INSTALL = new Set(['tsconfig.json'])

// What sits at one site of an installed copy: the literal token (no answer existed when
// the file was rendered — an install upgraded from before the token shipped — even if one
// was backfilled since), else the answer's value. Literal first, so a later backfill can
// never turn an untouched file into a mismatch.
/** @param {string} text @param {number} at @param {string} literal @param {unknown} value */
function consumedAt(text, at, literal, value) {
  if (text.startsWith(literal, at)) return literal.length
  if (value !== undefined && text.startsWith(String(value), at)) return String(value).length
  return null
}

/**
 * Rebuild the template SOURCE from an installed, placeholder-rendered copy, or null.
 *
 * Walks the recorded sites in order — never a search: `main` occurs all over a workflow
 * and only the offset says which occurrence was `{{DEFAULT_BRANCH}}`. Null means a site
 * does not hold (the rendered value was edited, the answers changed since install, or the
 * sites are not ascending); an edit anywhere ELSE survives into the rebuilt text and moves
 * its sha. Either way the caller reads "not what a release shipped", which can only park.
 *
 * @param {string} installed
 * @param {Array<[number, string]>} sites
 * @param {Record<string, unknown>} answers
 * @returns {string | null}
 */
export function derender(installed, sites, answers) {
  let out = ''
  let cursor = 0 // into `installed`
  let sourceAt = 0 // into the source being rebuilt
  for (const [offset, token] of sites) {
    const gap = offset - sourceAt
    if (gap < 0 || cursor + gap > installed.length) return null
    const literal = `{{${token}}}`
    const consumed = consumedAt(installed, cursor + gap, literal, answers[token])
    if (consumed === null) return null
    out += installed.slice(cursor, cursor + gap) + literal
    cursor += gap + consumed
    sourceAt = offset + literal.length
  }
  return out + installed.slice(cursor)
}

/**
 * Does ANY variant vouch for these bytes? A token-free variant is judged by the recorded
 * sha itself (every caller has already established that the file still matches its
 * record); a placeholder-bearing one by derendering the bytes on disk.
 *
 * @param {Variant[]} variants
 * @param {Evidence} evidence
 */
export function explains(variants, { recordedSha, current, answers }) {
  const text = current === null ? null : current.toString('utf8')
  for (const variant of variants) {
    if (variant.sites === undefined) {
      if (variant.sha256 === recordedSha) return true
      continue
    }
    const source = text === null ? null : derender(text, variant.sites, answers)
    if (source !== null && sha256(source) === variant.sha256) return true
  }
  return false
}

/** @param {{ tables: Tables, installPath: string, toVersion: string }} spec @param {Evidence} evidence */
function vouchingVersions({ tables, installPath, toVersion }, evidence) {
  const known = []
  const vouching = []
  for (const version of Object.keys(tables).sort(cmpVersions)) {
    const variants = tables[version][installPath]
    // A table newer than the running installer cannot ship with it; an injected one is ignored.
    if (variants === undefined || cmpVersions(version, toVersion) > 0) continue
    known.push(version)
    if (explains(variants, evidence)) vouching.push(version)
  }
  return { known, vouching }
}

/**
 * The verdict on one owned path whose bytes still match its manifest record.
 *
 *   released       a release from the install's version up to the running installer shipped
 *                  them. UP TO, not only AT: `enable` and `--refresh-seeded` write the
 *                  running installer's bytes without advancing harnessVersion.
 *   older-release  only an OLDER release shipped them — a pin back, which is a fork, but
 *                  reported as what it is rather than as "no release shipped this".
 *   fork           the tables know the path in range and none vouches.
 *   unverifiable   no table for the install's own version (a vintage without one, or a
 *                  manifest NEWER than this installer), or no table in range knows the
 *                  path. Callers keep the pre-1.0.2 behaviour and say so once — never a
 *                  mass park over missing evidence.
 *   derived        DERIVED_AT_INSTALL.
 *
 * @param {{ tables: Tables, fromVersion: string, toVersion: string, installPath: string } & Evidence} spec
 * @returns {Verdict}
 */
export function classifyProvenance(spec) {
  const { tables, fromVersion, installPath, recordedSha, current, answers } = spec
  if (DERIVED_AT_INSTALL.has(installPath)) return { kind: 'derived' }
  if (tables[fromVersion] === undefined) return { kind: 'unverifiable' }
  const { known, vouching } = vouchingVersions(spec, { recordedSha, current, answers })
  /** @param {string} version */
  const inRange = (version) => cmpVersions(version, fromVersion) >= 0
  const released = vouching.find(inRange)
  if (released !== undefined) return { kind: 'released', version: released }
  const older = vouching.at(-1)
  if (older !== undefined) return { kind: 'older-release', version: older }
  return { kind: known.some(inRange) ? 'fork' : 'unverifiable' }
}

/**
 * Has upstream left this path alone since the install's version? True only when EVERY
 * variant in range is the incoming source — two variants mean the file changed inside the
 * range, and which one a fork was based on is unknowable, so that parks. It is what stops
 * a fork from costing exit 2 on every update forever: there is nothing new to merge.
 *
 * @param {{ tables: Tables, fromVersion: string, toVersion: string, installPath: string, incomingSourceSha: string }} spec
 */
export function upstreamUnchanged({ tables, fromVersion, toVersion, installPath, incomingSourceSha }) {
  let seen = 0
  for (const version of Object.keys(tables)) {
    if (cmpVersions(version, fromVersion) < 0 || cmpVersions(version, toVersion) > 0) continue
    for (const variant of tables[version][installPath] ?? []) {
      if (variant.sha256 !== incomingSourceSha) return false
      seen += 1
    }
  }
  return seen > 0
}

/**
 * Every shipped released-sha table, keyed by version. An absent directory is an installer
 * older than the tables (or a fork that dropped them) and reads as "no evidence"; a table
 * that does not parse is a packaging regression and fails loud, like an empty plan does.
 *
 * @param {string} [dir]
 * @returns {Tables}
 */
export function readReleasedShas(dir = join(templateRoot(), 'shas')) {
  let names
  try {
    names = readdirSync(dir).sort()
  } catch {
    return {}
  }
  /** @type {Tables} */
  const tables = {}
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    let table
    try {
      table = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    } catch {
      throw new Error(`template/shas/${name} is not valid JSON — installer packaging is broken`)
    }
    tables[table.version] = table.files
  }
  return tables
}

// The park sentence for a file kept because of LOCAL CHANGES (or, under --refresh-seeded,
// because no install record proves it untouched). One wording, shared by the sweep and
// --refresh-seeded, pushed where the park is decided.
/** @param {string} ip */
export function parkedNote(ip) {
  return `${ip} has local changes — kept; the current template version is parked at ${join('.harness', 'pending', ip)} (merge by hand, or re-run with --force)`
}

/** @param {string[]} paths */
function listed(paths) {
  const shown = paths.slice(0, 10).join(', ')
  return paths.length > 10 ? `${shown} (+${String(paths.length - 10)} more)` : shown
}

/**
 * The policy the commands share, bound to one install and one report.
 *
 * `classifyOwned` wraps classifyDrift (unchanged, still pure) and layers the provenance
 * policy on the ONE decision it cannot make alone — `update-clean` over a file that has a
 * record. It pushes its own notes, identically in dry-run and real runs (the parity test
 * holds the two reports deep-equal), so no caller grows a branch: update and enable sit at
 * their complexity ceilings.
 *
 * @param {{ tables: Tables, manifest: { harnessVersion: string, answers?: Record<string, unknown> },
 *           report: { notes: string[] }, toVersion?: string }} args
 */
export function createProvenance({ tables, manifest, report, toVersion = installerVersion() }) {
  const fromVersion = manifest.harnessVersion
  const answers = manifest.answers ?? {}
  /** @type {string[]} */
  const unverifiable = []
  /** @type {string[]} */
  const keptForks = []

  /** @param {string} installPath @param {string} recordedSha @param {Buffer | string | null} current */
  const judge = (installPath, recordedSha, current) =>
    classifyProvenance({ tables, fromVersion, toVersion, installPath, recordedSha, current, answers })

  /** @param {string} ip @param {Verdict} verdict */
  const forkNote = (ip, verdict) => {
    const pending = join('.harness', 'pending', ip)
    const what =
      verdict.kind === 'older-release'
        ? `the recorded sha matches release ${verdict.version}, older than this install (${fromVersion}) — kept as a deliberate pin`
        : 'the recorded sha matches no release of this harness — a local fork, kept'
    report.notes.push(
      `${ip}: ${what}. The incoming version is parked at ${pending} (merge it by hand; --force discards yours)`,
    )
  }

  /** @param {string} ip @param {{ sourcePath?: string } | undefined} entry */
  const unchangedUpstream = (ip, entry) =>
    typeof entry?.sourcePath === 'string' &&
    upstreamUnchanged({
      tables,
      fromVersion,
      toVersion,
      installPath: ip,
      incomingSourceSha: sha256(renderEntry({ sourcePath: entry.sourcePath }, {})),
    })

  return {
    /**
     * @param {{ ip: string, current: Buffer | null, recorded?: { sha256?: string }, incoming: Buffer | string,
     *           force?: boolean, entry?: { sourcePath?: string }, explicit?: boolean, owned?: boolean }} spec
     *   `explicit`: the path was asked for by name (--refresh-seeded) — it always gets the
     *   template's copy parked, never the unchanged-upstream skip.
     *   `owned`: false for a seeded/config path reached through --refresh-seeded. The tables
     *   list owned paths only, and a project-owned file is the project's to edit — there is
     *   no fork to find there, and reporting it "unverifiable" on every refresh would be noise.
     */
    classifyOwned({ ip, current, recorded, incoming, force = false, entry, explicit = false, owned = true }) {
      const kind = classifyDrift({ current, recordedSha: recorded?.sha256, incoming, force })
      if (kind === 'park') report.notes.push(parkedNote(ip))
      if (kind !== 'update-clean' || !owned || typeof recorded?.sha256 !== 'string') return kind
      const verdict = judge(ip, recorded.sha256, current)
      if (verdict.kind === 'released' || verdict.kind === 'derived') return kind
      if (verdict.kind === 'unverifiable') {
        unverifiable.push(ip)
        return kind
      }
      if (force) return 'force-overwrite'
      if (!explicit && unchangedUpstream(ip, entry)) {
        keptForks.push(ip)
        return 'skip-same'
      }
      forkNote(ip, verdict)
      return 'park'
    },

    /**
     * For the DELETING call sites (`disable`, removed/renamed migrations): the bytes match
     * the record, but did a release ship them? A fork is kept; missing evidence deletes as
     * before.
     *
     * @param {string} ip @param {string} recordedSha @param {Buffer} current
     */
    isFork(ip, recordedSha, current) {
      const { kind } = judge(ip, recordedSha, current)
      return kind === 'fork' || kind === 'older-release'
    },

    /** The aggregate notes — once per run, after the last classification. */
    close() {
      if (keptForks.length > 0) {
        report.notes.push(
          `${String(keptForks.length)} local fork(s) kept and nothing parked for them — upstream has not changed these files since ${fromVersion}: ${listed(keptForks)}`,
        )
      }
      if (unverifiable.length > 0) {
        report.notes.push(
          `provenance unverifiable for ${String(unverifiable.length)} harness-owned file(s) this run refreshed — no released-sha table covers ${fromVersion} (or the path), so "unmodified" rested on the manifest record alone: ${listed(unverifiable)}`,
        )
      }
    },
  }
}
