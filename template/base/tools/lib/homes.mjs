// tools/lib/homes.mjs — home(class): where one copy of a class of equal bodies can live
// (2.1.0, #186). One total function of the members' files and the rule files the gates
// already enforce, so a home it prints is one the tree's own laws admit:
//   - the `forbidden` rules of .dependency-cruiser.cjs (the `architecture` step), loaded
//     in-process and evaluated on the resolved paths, `$1` back-references included;
//   - the vertical-anatomy laws (lib/vertical-anatomy.mjs anatomyRefuses: domain purity,
//     events purity, no client reach);
//   - the workspace walls (lib/workspace-tiers.mjs mayDepend, over the census).
//
// The four homes, tried in order:
//   1. IMPORT — some member's module is already value-importable from every other member's
//      file: the member is exported, every other member's workspace either IS its workspace
//      or already declares a runtime dependency on its package and reaches it through an
//      `exports` subpath, and no law forbids the import. Only when the members' literals are
//      equal too: importing one copy where another said something different is the silent
//      behaviour change the literal-parameter count exists to prevent. The target is the
//      member with the most importers; ties break by path, then line.
//   2. MODULE — all members are in one workspace: a new module there takes the body, with
//      the differing literals as parameters. For SQL, a function in schema `private` added
//      by a forward migration.
//   3. LIFT — a new packages/shared/<concept> is legal for every member.
//   4. NONE — no legal home. For example a web↔mobile class: packages/shared/* is outside
//      the mobile wall, and only a human-reviewed census entry could admit it (#154's
//      census guard row keeps an agent from adding one in-turn, so NONE stays honest).
//      NONE is advisory (`exact-nohome`), never owed.
// SOURCE: docs/harness/gates-catalog.md (duplication gate) [corpus: harness/doctrine]
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { anatomyRefuses } from './vertical-anatomy.mjs'
import { mayDepend, workspaceKind } from './workspace-tiers.mjs'

/** @typedef {import('./shapes.mjs').Callable} Callable */
/** @typedef {ReturnType<typeof import('./importers.mjs').buildImporters>} Importers */
/**
 * @typedef {{ importers: Importers, census: Set<string>, forbidden: any[] }} HomeContext
 * @typedef {{ kind: 'import' | 'module' | 'lift' | 'none', target: Callable | null }} Home
 */

const DEPCRUISE = '.dependency-cruiser.cjs'
const LIFT_PROBE = 'packages/shared/concept/src/index.ts'
const LIFT_PACKAGE = { name: '@app/concept', tier: 'shared' }

/**
 * The `forbidden` rules of the project's .dependency-cruiser.cjs, or [] when it is absent
 * or does not load (the `architecture` step is then not judging them either).
 * @returns {any[]}
 */
export function loadForbidden() {
  if (!existsSync(DEPCRUISE)) return []
  try {
    const abs = resolve(DEPCRUISE)
    const config = createRequire(pathToFileURL(abs))(abs)
    return Array.isArray(config?.forbidden) ? config.forbidden : []
  } catch {
    return []
  }
}

/** A dependency-cruiser path condition: a string or an array of alternatives. */
const pattern = (p) => (Array.isArray(p) ? p.join('|') : p)
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Does one forbidden rule forbid an import from `from` to `to` (resolved, repo-relative
 * POSIX paths)? Rules that judge anything but paths (cycles, dependency types) are not
 * this function's subject and never forbid here.
 */
function ruleForbids(rule, from, to) {
  const f = rule?.from ?? {}
  const t = rule?.to ?? {}
  const judged = new Set(['path', 'pathNot'])
  if (Object.keys(t).some((k) => !judged.has(k)) || Object.keys(f).some((k) => !judged.has(k))) {
    return false
  }
  const fm = f.path === undefined ? [from] : new RegExp(pattern(f.path)).exec(from)
  if (fm === null) return false
  if (f.pathNot !== undefined && new RegExp(pattern(f.pathNot)).test(from)) return false
  const sub = (re) => pattern(re).replace(/\$(\d)/g, (_m, n) => escape(fm[Number(n)] ?? ''))
  if (t.path !== undefined && !new RegExp(sub(t.path)).test(to)) return false
  if (t.pathNot !== undefined && new RegExp(sub(t.pathNot)).test(to)) return false
  return true
}

/** The path relative to a vertical's src/, or null outside one. */
function verticalRel(path) {
  const m = /^packages\/verticals\/[^/]+\/src\/(.+)$/.exec(path)
  return m === null ? null : m[1]
}

/**
 * Whether a file may newly value-import `spec` resolving to `to`: no forbidden rule on the
 * resolved paths and no anatomy law on the importing file.
 * @param {string} from @param {string} spec @param {string} to @param {any[]} forbidden
 */
function lawsAdmit(from, spec, to, forbidden) {
  if (forbidden.some((rule) => ruleForbids(rule, from, to))) return false
  const rel = verticalRel(from)
  return rel === null || anatomyRefuses(rel, spec) === null
}

/** A relative specifier from one file to another (extension dropped). */
function relativeSpec(from, to) {
  const a = from.split('/').slice(0, -1)
  const b = to.replace(/\.tsx?$/, '').split('/')
  let i = 0
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i += 1
  const up = a.length - i
  return `${up === 0 ? './' : '../'.repeat(up)}${b.slice(i).join('/')}`
}

/**
 * The export name a callable is imported by: its own name, or `default` when the module's
 * default export is it. Null for a callable nothing outside its module can import.
 * @param {Callable} m @param {Importers} importers
 */
export function exportName(m, importers) {
  if (m.kind !== 'function' || !m.exported) return null
  return importers.defaultName(m.path) === m.name ? 'default' : m.name
}

/** Can `other`'s file import `target` as it stands today? */
function canImport(other, target, name, ctx) {
  if (other.path === target.path) return true
  const { importers, census, forbidden } = ctx
  if (other.workspace.dir === target.workspace.dir) {
    return lawsAdmit(other.path, relativeSpec(other.path, target.path), target.path, forbidden)
  }
  const fromWs = importers.workspaceOf(other.path)
  if (fromWs === null || !fromWs.deps.has(target.workspace.name)) return false
  const from = { name: fromWs.name, kind: workspaceKind(fromWs.dir) }
  const to = { name: target.workspace.name, tier: workspaceKind(target.workspace.dir) }
  if (mayDepend(from, to, census) !== null) return false
  return importers
    .exposedVia(target.path, name)
    .some((via) => lawsAdmit(other.path, via.spec, target.path, forbidden))
}

/** The importer count of a member's export (0 when it is not exported). */
function importerCount(m, importers) {
  const name = exportName(m, importers)
  return name === null ? 0 : importers.importersOf(m.path, name).length
}

/** IMPORT's target: the importable member with the most importers, or null. */
function importTarget(members, ctx) {
  const ranked = members
    .map((m) => ({ m, n: importerCount(m, ctx.importers) }))
    .sort((a, b) => b.n - a.n || cmp(a.m.path, b.m.path) || a.m.line - b.m.line)
  for (const { m } of ranked) {
    const name = exportName(m, ctx.importers)
    if (name === null) continue
    if (members.every((o) => o === m || canImport(o, m, name, ctx))) return m
  }
  return null
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/** Is a new packages/shared package legal for one member? */
function liftAdmits(m, ctx) {
  const ws = ctx.importers.workspaceOf(m.path)
  const kind = workspaceKind(ws?.dir ?? m.workspace.dir)
  if (mayDepend({ name: m.workspace.name, kind }, LIFT_PACKAGE, ctx.census) !== null) return false
  return lawsAdmit(m.path, LIFT_PACKAGE.name, LIFT_PROBE, ctx.forbidden)
}

/**
 * home(class): IMPORT, MODULE, LIFT or NONE, in that order.
 * @param {{ lang: 'ts' | 'sql', members: Callable[], litEqual: boolean }} cls
 * @param {HomeContext} ctx
 * @returns {Home}
 */
export function home(cls, ctx) {
  if (cls.lang === 'sql') return { kind: 'module', target: null }
  if (cls.litEqual) {
    const target = importTarget(cls.members, ctx)
    if (target !== null) return { kind: 'import', target }
  }
  const dirs = new Set(cls.members.map((m) => m.workspace.dir))
  if (dirs.size === 1) return { kind: 'module', target: null }
  if (cls.members.every((m) => liftAdmits(m, ctx))) return { kind: 'lift', target: null }
  return { kind: 'none', target: null }
}
