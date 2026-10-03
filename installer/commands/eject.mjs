// `eject` — take the worked example back out of an install that chose `init --with-demo`
// (2.0.0, #85). Three parts, each conservative in the direction `disable` is:
//
//   1. A demo-only file is DELETED while it is still the demo's: its bytes match its manifest
//      record AND that record is the demo's bytes (this release's demo for a seeded file; any
//      release, through lib/provenance.mjs, for an owned one). A drifted file or a re-recorded
//      fork is kept, and its record dropped: it is the project's now, as `disable` leaves it.
//   2. A shared file the demo REPLACED (the API router, the home tab, the command palette,
//      the seeded registers) gets the default install's bytes back while it is still the
//      demo's. One the project changed is kept, and the default copy parks under
//      .harness/pending/ for a hand merge.
//   3. A changed register keeps the project's rows: only the rows template/demo-index.json
//      lists, and only where they still equal the shipped demo row, are deleted, and the
//      default's rows the demo dropped or changed come back where they are absent
//      (lib/demo-rows.mjs).
//
// tsconfig.json is re-derived without the references to the packages eject deleted. It is the
// one owned file eject writes, because the installer derives it (provenance.mjs
// DERIVED_AT_INSTALL) the way init and update do. Each migration eject deletes is recorded,
// with the sha256 of the bytes it deleted, in manifest.ejectedMigrations: the `migrations`
// gate accepts the deletion of exactly those bytes and still reds every other one.
//
// An install with no demo record is refused: one made without --with-demo has nothing to
// eject, and one made before 2.0.0 carries the example inside its spine migrations, where no
// file-by-file removal is safe (docs/runbooks/harness-upgrade.md says how to remove it).
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { renderEntry, walkDemo, walkStack, walkTemplate } from '../lib/copy.mjs'
import { readDemoIndex, trimDemoRows } from '../lib/demo-rows.mjs'
import { readManifest, sha256, writeManifest } from '../lib/manifest.mjs'
import { refuseOlderCli } from '../lib/migrations.mjs'
import { createProvenance, readReleasedShas } from '../lib/provenance.mjs'
import { printReport } from '../lib/report.mjs'
import { dropProjectReferences } from '../lib/tsconfig-references.mjs'
import { writeInstallFile } from '../lib/write-file.mjs'
import { pruneEmptyDirs } from './enable.mjs'

const MIGRATIONS_DIR = 'supabase/migrations/'

const KEPT = {
  drift: 'kept: changed since init (its bytes no longer match the manifest record) — it is yours now; delete it by hand if you meant to',
  fork: "kept: its record is not the demo's bytes (a re-recorded fork) — it is yours now; delete it by hand if you meant to",
  unrecorded: "kept: no manifest record shows it is the demo's — delete it by hand if you meant to",
}

/**
 * @typedef {{ mode?: string, sha256: string, module?: string }} FileRecord
 * @typedef {{ title: string, written: string[], skipped: string[], conflicts: Array<{ path: string, detail: string }>,
 *             drift: Array<{ path: string, pending: string }>, notes: string[], removed: string[] }} EjectReport
 * @typedef {{ targetDir: string, answers: Record<string, unknown>, dryRun: boolean, report: EjectReport,
 *             files: Record<string, FileRecord>, defaults: Map<string, { sourcePath: string }>,
 *             provenance: { isFork: (ip: string, recordedSha: string, current: Buffer) => boolean, close: () => void },
 *             rows: Array<{ file: string, jsonPointer?: string, rowKey?: string, restore?: boolean }>,
 *             ejected: Record<string, string> }} Ctx
 */

/** @param {string | Buffer} content */
const bytes = (content) => (Buffer.isBuffer(content) ? content : Buffer.from(content))

/**
 * Why this install cannot be ejected, or null when it can.
 *
 * @param {{ demo?: unknown }} manifest
 * @returns {string | null}
 */
function refusalOf(manifest) {
  if (manifest.demo === true) return null
  if (manifest.demo === false) {
    return 'this install has no demo: it was created without --with-demo, so there is nothing to eject'
  }
  return 'this install records no demo choice: it was created before 2.0.0, when the worked example was part of every scaffold and its rails were written into the spine migrations, so it cannot be removed file by file. docs/runbooks/harness-upgrade.md (2.0.0) says how to remove it by hand.'
}

/**
 * Is the file on disk still the demo's? 'demo' when it is; otherwise why not.
 *
 * @param {Ctx} ctx @param {string} ip @param {Buffer} current @param {Buffer} shipped
 * @returns {'demo' | 'drift' | 'fork' | 'unrecorded'}
 */
function demoVerdict(ctx, ip, current, shipped) {
  const recorded = ctx.files[ip]
  if (recorded === undefined) return 'unrecorded'
  if (sha256(current) !== recorded.sha256) return 'drift'
  if (recorded.mode === 'owned') return ctx.provenance.isFork(ip, recorded.sha256, current) ? 'fork' : 'demo'
  return current.equals(shipped) ? 'demo' : 'fork'
}

/** @param {Ctx} ctx @param {string} ip @param {Buffer} current */
function removeFile(ctx, ip, current) {
  if (!ctx.dryRun) rmSync(join(ctx.targetDir, ip))
  ctx.report.removed.push(ip)
  delete ctx.files[ip]
  if (ip.startsWith(MIGRATIONS_DIR)) ctx.ejected[ip] = sha256(current)
}

/** @param {Ctx} ctx @param {string} ip @param {'drift' | 'fork' | 'unrecorded'} why */
function keepFile(ctx, ip, why) {
  delete ctx.files[ip]
  ctx.report.conflicts.push({ path: ip, detail: KEPT[why] })
}

/** @param {Ctx} ctx @param {string} ip @param {Buffer} content */
function writeShared(ctx, ip, content) {
  if (!ctx.dryRun) writeInstallFile(join(ctx.targetDir, ip), content)
  ctx.files[ip] = { ...(ctx.files[ip] ?? { mode: 'seeded' }), sha256: sha256(content) }
  ctx.report.written.push(ip)
}

/** @param {Ctx} ctx @param {string} ip @param {Buffer} restored */
function parkDefault(ctx, ip, restored) {
  const pending = join('.harness', 'pending', ip)
  if (!ctx.dryRun) writeInstallFile(join(ctx.targetDir, pending), restored)
  ctx.report.drift.push({ path: ip, pending })
}

/**
 * A shared file the project changed: trim the indexed demo rows out of a register (and put
 * the default's back), park the default copy of anything else.
 *
 * @param {Ctx} ctx @param {string} ip @param {Buffer} current @param {Buffer} shipped @param {Buffer} restored
 */
function trimOrPark(ctx, ip, current, shipped, restored) {
  const rows = ctx.rows.filter((r) => r.file === ip)
  if (rows.length === 0) return parkDefault(ctx, ip, restored)
  const result = trimDemoRows(ip, current.toString('utf8'), shipped.toString('utf8'), restored.toString('utf8'), rows)
  if (result.deleted.length + result.restored.length > 0) {
    writeShared(ctx, ip, Buffer.from(result.content))
    ctx.report.notes.push(
      `${ip}: you changed this register, so eject deleted only its ${result.deleted.length} demo row(s), restored ${result.restored.length} default row(s) and kept yours — run your formatter over it if it reflowed`,
    )
  }
  if (result.kept.length > 0) {
    ctx.report.conflicts.push({
      path: ip,
      detail: `kept ${result.kept.length} row(s) eject could not judge — a demo row that no longer equals the row the demo shipped, or one whose place in the register is gone (${result.kept.join(', ')}) — reconcile them with the default copy by hand`,
    })
  }
}

/**
 * One demo entry: delete it, restore the default over it, trim its rows, or keep it.
 *
 * @param {Ctx} ctx @param {{ installPath: string, sourcePath: string }} entry
 */
function ejectEntry(ctx, entry) {
  const ip = entry.installPath
  const dest = join(ctx.targetDir, ip)
  const fallback = ctx.defaults.get(ip)
  if (!existsSync(dest)) {
    if (fallback === undefined) delete ctx.files[ip]
    else ctx.report.notes.push(`${ip} is missing — the default install ships it; restore it with \`update --refresh-seeded ${ip}\``)
    return
  }
  const current = readFileSync(dest)
  const verdict = demoVerdict(ctx, ip, current, bytes(renderEntry(entry, ctx.answers)))
  if (fallback === undefined) {
    if (verdict === 'demo') removeFile(ctx, ip, current)
    else keepFile(ctx, ip, verdict)
    return
  }
  const restored = bytes(renderEntry(fallback, ctx.answers))
  if (verdict === 'demo') writeShared(ctx, ip, restored)
  else trimOrPark(ctx, ip, current, bytes(renderEntry(entry, ctx.answers)), restored)
}

/**
 * What a workspace package directory grows that no install wrote: `tsc -b` output, pnpm's
 * links, a task runner's cache. Regenerated by the next build or install, never the project's
 * own work.
 */
const BUILD_OUTPUT = new Set(['dist', 'node_modules', '.turbo'])

/**
 * A demo package eject removed whole leaves its directory behind when the tree was built
 * (dist/, node_modules/). Clear exactly that, so the directory goes too and no gate walking
 * packages/verticals/* meets a package with no package.json. A directory holding anything
 * else is the project's to judge: kept, with a note.
 *
 * @param {Ctx} ctx
 */
function clearBuildOutput(ctx) {
  if (ctx.dryRun) return
  for (const ip of ctx.report.removed.filter((p) => /(^|\/)package\.json$/.test(p))) {
    const abs = join(ctx.targetDir, dirname(ip))
    if (!existsSync(abs)) continue
    const left = readdirSync(abs)
    if (left.some((n) => !BUILD_OUTPUT.has(n) && !n.endsWith('.tsbuildinfo'))) {
      ctx.report.notes.push(
        `${dirname(ip)}/ is kept: it holds files eject did not write (${left.sort().join(', ')}) — delete it by hand once nothing in it is yours`,
      )
      continue
    }
    for (const n of left) rmSync(join(abs, n), { recursive: true, force: true })
    pruneEmptyDirs(ctx.targetDir, [ip], false)
  }
}

/**
 * Drop the root solution file's references to the demo packages eject deleted.
 *
 * @param {Ctx} ctx
 */
function rederiveSolution(ctx) {
  const gone = walkDemo()
    .map((e) => /^(packages\/.+)\/tsconfig\.json$/.exec(e.installPath)?.[1])
    .filter((dir) => dir !== undefined && ctx.report.removed.includes(`${dir}/tsconfig.json`))
  const dest = join(ctx.targetDir, 'tsconfig.json')
  if (gone.length === 0 || !existsSync(dest)) return
  const current = readFileSync(dest)
  const recorded = ctx.files['tsconfig.json']
  if (recorded !== undefined && sha256(current) !== recorded.sha256) {
    ctx.report.conflicts.push({
      path: 'tsconfig.json',
      detail: `kept (changed since it was recorded) — remove its reference(s) to ${gone.join(', ')} by hand, or \`tsc -b\` fails on the deleted project`,
    })
    return
  }
  writeShared(ctx, 'tsconfig.json', Buffer.from(dropProjectReferences(current.toString('utf8'), /** @type {string[]} */ (gone))))
}

/**
 * @param {{ dir: string, dryRun?: boolean, report?: string }} opts
 * @param {{ releasedShas?: Record<string, Record<string, Array<{ sha256: string, sites?: Array<[number, string]> }>>>,
 *           index?: { rows: Array<{ file: string, jsonPointer?: string, rowKey?: string, restore?: boolean }> } }} [deps]
 */
export async function eject(opts, { releasedShas = readReleasedShas(), index = readDemoIndex() } = {}) {
  const targetDir = opts.dir
  const manifest = readManifest(targetDir)
  if (!manifest) throw new Error('no .harness/manifest.json — run `init` first')
  refuseOlderCli(manifest, 'eject')
  const refusal = refusalOf(manifest)
  if (refusal !== null) {
    console.error(`error: ${refusal}`)
    return 1
  }
  const answers = { DESIGN_TOKENS: 'default', ...(manifest.answers ?? {}) }
  /** @type {EjectReport} */
  const report = { title: 'harness eject', written: [], skipped: [], conflicts: [], drift: [], notes: [], removed: [] }
  /** @type {Ctx} */
  const ctx = {
    targetDir,
    answers,
    dryRun: opts.dryRun === true,
    report,
    files: { ...manifest.files },
    defaults: new Map([...walkTemplate('base'), ...walkStack(answers)].map((e) => [e.installPath, e])),
    provenance: createProvenance({ tables: releasedShas, manifest, report }),
    rows: index.rows,
    ejected: {},
  }
  for (const entry of walkDemo()) ejectEntry(ctx, entry)
  ctx.provenance.close()
  pruneEmptyDirs(targetDir, report.removed, ctx.dryRun)
  clearBuildOutput(ctx)
  rederiveSolution(ctx)

  const ejectedMigrations = { ...(manifest.ejectedMigrations ?? {}), ...ctx.ejected }
  if (!ctx.dryRun) {
    writeManifest(targetDir, {
      ...manifest,
      demo: false,
      files: ctx.files,
      ejectedMigrations: Object.keys(ejectedMigrations).length > 0 ? ejectedMigrations : undefined,
    })
  }
  report.notes.push(
    `${report.removed.length} demo file(s) ${ctx.dryRun ? 'would be removed' : 'removed'}. If a database you keep has already applied the demo's migrations, read docs/runbooks/harness-upgrade.md (2.0.0) before you commit their deletion. Next: \`pnpm install\` (the lockfile still names the demo's workspace packages), then commit, then \`pnpm validate\`: eject rewrote registers gate-integrity holds to a commit, so a validate before the commit fails on each of them.`,
  )
  if (opts.report !== 'json') {
    for (const ip of report.removed) console.log(`  ${ctx.dryRun ? 'would remove' : 'removed'} ${ip}`)
  }
  return printReport(report, { json: opts.report === 'json' })
}
