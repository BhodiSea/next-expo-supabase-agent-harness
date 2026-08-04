// The root tsconfig.json is a SOLUTION file: `tsc -b` walks its `references`, and the
// `contracts` gate asserts that list agrees with the pnpm workspace graph and the knip
// map — three parallel topologies that desynchronise into type errors pointing
// everywhere except at the drift.
//
// An opt-in module that plants a workspace package (eval-live → packages/eval) must
// therefore appear in that list, and CANNOT be written into the template's copy: a
// core-tier scaffold has no such directory, and `tsc -b` fails outright on a reference
// to a project that does not exist. Listing it unconditionally would trade a red
// `contracts` on strict for a red `types` on core.
//
// So the references are derived from the PLAN — whatever packages the install actually
// writes are what the solution file names. That is the same closure the gate performs,
// applied at the one moment both facts are in hand.
//
// Textual insertion rather than JSON.parse + re-serialise, deliberately: the file is
// JSONC and its comments carry the layering law (kernel → platform → verticals → api)
// plus the reasoned absence of apps/web and apps/mobile. A round-trip through
// JSON.stringify would silently delete all of it.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileMode } from './manifest.mjs'
import { matchSeedOnInitOnly } from './migrations.mjs'

/** `{ "path": "packages/x" }` — the shape every reference entry has. */
const REFERENCE_LINE = /^(\s*)\{\s*"path":\s*"([^"]+)"\s*\}(,?)\s*$/

/**
 * Drop references to projects that will not exist after this run.
 *
 * The mirror of the injection below, and it exists because the two halves of a new
 * workspace package can travel separately. `tsconfig.json` is OWNED, so `update` rewrites
 * it from the template — including a reference to any package the template has GAINED.
 * If that package's files are seedOnInitOnly (packages/platform/ratelimit in 0.2.0: a new
 * Upstash dependency nobody opted into, withheld on purpose), `update` plants the
 * reference and withholds the project. `tsc -b` then dies on the FIRST line it reads —
 * `error TS5083: Cannot read file …/tsconfig.json` — taking the whole typecheck with it,
 * including every package that was fine. Found by running the real 0.1.3 → 0.2.0 upgrade.
 *
 * A reference survives only if its tsconfig will EXIST when the run finishes. Plan
 * membership is not that question and answering it that way is the bug's second form:
 * every seedOnInitOnly file is in the plan and is skipped later, in the write loop. So
 * this re-asks update's own rule — already on disk, or planned and not withheld — which
 * is why the patterns are a parameter rather than a lookup. `init` passes none, because
 * init is what plants seeded exemplars in the first place.
 *
 * @param {{ installPath: string, content: unknown }[]} plan
 * @param {string} targetDir
 * @param {{ notes: string[] }} report
 * @param {string[]} [withheld] seedOnInitOnly patterns this run will not auto-plant
 * @returns {string[]} the package directories pruned
 */
export function pruneMissingProjectReferences(plan, targetDir, report, withheld = []) {
  const root = plan.find((e) => e.installPath === 'tsconfig.json')
  if (root === undefined || typeof root.content !== 'string') return []

  const planned = new Set(plan.map((e) => e.installPath))
  const willExist = (ip) => {
    if (existsSync(join(targetDir, ip))) return true
    if (!planned.has(ip)) return false
    // Owned files are always written; a seeded one is written unless it is registered
    // init-time-only — exactly the branch installer/commands/update.mjs takes.
    return fileMode(ip) === 'owned' || matchSeedOnInitOnly(ip, withheld) === null
  }

  const lines = root.content.split('\n')
  const kept = []
  const pruned = []
  for (const line of lines) {
    const m = REFERENCE_LINE.exec(line)
    const path = m?.[2]
    if (path === undefined || !path.startsWith('packages/')) {
      kept.push(line)
      continue
    }
    if (willExist(`${path}/tsconfig.json`)) {
      kept.push(line)
      continue
    }
    pruned.push(path)
  }
  if (pruned.length === 0) return []

  // Re-fix the trailing comma: whichever reference is last must not carry one, and the
  // one before a survivor must. Rebuilding the run is simpler than patching around a hole.
  const idx = kept.map((l, i) => (REFERENCE_LINE.test(l) ? i : -1)).filter((i) => i !== -1)
  for (const [n, i] of idx.entries()) {
    kept[i] = kept[i].replace(/,\s*$/, '')
    if (n < idx.length - 1) kept[i] = `${kept[i]},`
  }
  root.content = kept.join('\n')
  report.notes.push(
    `tsconfig.json: project reference(s) omitted for package(s) not in this install: ${pruned.join(', ')} — they are seedOnInitOnly; pull one with \`update --refresh-seeded <path>/\` and the reference returns on the next update`,
  )
  return pruned
}

/**
 * Inject a project reference for every module-provided workspace package in the plan.
 *
 * Mutates the plan's root-`tsconfig.json` entry in place, and records what it did on the
 * install report. A no-op when no module plants a package, when the entry is absent
 * (retrofit conflict path), or when every package is already referenced — so calling it
 * twice cannot double-write.
 *
 * The report line is written HERE rather than by the caller so neither command grows a
 * branch: both `init` and `update` are at their recorded complexity ceiling, and the
 * ratchet counts an `if` in the caller exactly as it counts one anywhere else.
 *
 * @param {{ installPath: string, content: unknown, module?: string }[]} plan
 * @param {{ notes: string[] }} report
 * @param {string} verb — 'added' at init, 'kept' at update (which rewrites the owned file)
 * @returns {string[]} the package directories added
 */
export function injectModuleProjectReferences(plan, report, verb) {
  const wanted = []
  for (const e of plan) {
    // `module` is set only for entries planned from template/modules/<name>/. Base
    // packages are already in the template's list; re-deriving them here would make
    // the injection responsible for a layering order it has no way to know.
    if (e.module === undefined) continue
    const m = /^(packages\/.+)\/tsconfig\.json$/.exec(e.installPath)
    if (m !== null) wanted.push(m[1])
  }
  if (wanted.length === 0) return []

  const root = plan.find((e) => e.installPath === 'tsconfig.json')
  if (root === undefined || typeof root.content !== 'string') return []

  const lines = root.content.split('\n')
  let last = -1
  const present = new Set()
  for (const [i, line] of lines.entries()) {
    const m = REFERENCE_LINE.exec(line)
    if (m === null) continue
    present.add(m[2])
    last = i
  }
  const missing = wanted.filter((p) => !present.has(p)).sort()
  if (missing.length === 0 || last === -1) return []

  const [, indent, , comma] = /** @type {RegExpExecArray} */ (REFERENCE_LINE.exec(lines[last]))
  // The previous last entry needs the comma it did not have; the new tail must not.
  if (comma === '') lines[last] = `${lines[last]},`
  lines.splice(last + 1, 0, ...missing.map((p) => `${indent}{ "path": "${p}" }`))
  for (let i = 1; i < missing.length; i += 1) lines[last + i] = `${lines[last + i]},`
  root.content = lines.join('\n')
  report.notes.push(`tsconfig.json: project reference(s) ${verb} for module package(s) ${missing.join(', ')}`)
  return missing
}
