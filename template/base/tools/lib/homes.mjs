// tools/lib/homes.mjs — home(class): where one copy of a class of equal bodies can live
// (2.1.0, #186). One total function of the members' files and the rule files the gates
// already enforce, so a home it prints is one the tree's own laws admit:
//   - the `forbidden` rules of .dependency-cruiser.cjs (the `architecture` step) that the
//     step fails on (severity `error`; a missing severity is `warn`), loaded in-process and
//     judged for the one new edge a move adds, a static value import: `path`/`pathNot` on
//     the resolved paths (`$1` back-references included), `circular` by whether the
//     imported module already reaches the importing file in importers.mjs's module graph,
//     and `dependencyTypes`/`dependencyTypesNot` by the types such an import has or never
//     has. A rule with any condition not judged here forbids once its paths match (closed);
//   - the vertical-anatomy laws (lib/vertical-anatomy.mjs anatomyRefuses: domain purity,
//     events purity, no client reach);
//   - the workspace walls (lib/workspace-tiers.mjs mayDepend, over the census).
//
// The four homes, tried in order:
//   1. IMPORT — some member's module is already value-importable from every other member's
//      file: the member is exported (under any name importers.mjs records for its binding:
//      its own, an alias, `default`), every other member's workspace either IS its workspace
//      or already declares a runtime dependency on its package and reaches it through an
//      `exports` subpath, and no law forbids the import. Only when the members' literals are
//      equal too: importing one copy where another said something different is the silent
//      behaviour change the literal-parameter count exists to prevent. The target is the
//      member with the most importers (under all its export names); ties break by path,
//      then line.
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
 * The `forbidden` rules of the project's .dependency-cruiser.cjs that fail the
 * `architecture` step: severity `error` only (dependency-cruiser reads a missing severity as
 * `warn` and drops `ignore`; neither fails it). [] when the file is absent or does not load
 * (the step is then not judging them either).
 * @returns {any[]}
 */
export function loadForbidden() {
  if (!existsSync(DEPCRUISE)) return []
  try {
    const abs = resolve(DEPCRUISE)
    const config = createRequire(pathToFileURL(abs))(abs)
    const rules = Array.isArray(config?.forbidden) ? config.forbidden : []
    return rules.filter((rule) => rule?.severity === 'error')
  } catch {
    return []
  }
}

/** A dependency-cruiser path condition: a string or an array of alternatives. */
const pattern = (p) => (Array.isArray(p) ? p.join('|') : p)
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A new edge: an import from `from` to `to` (resolved, repo-relative POSIX paths), `local`
 * when its specifier is relative, and `cycle()` whether it would close a cycle.
 * @typedef {{ from: string, to: string, local: boolean, cycle: () => boolean }} Edge
 */

const JUDGED_FROM = new Set(['path', 'pathNot'])
const JUDGED_TO = new Set(['path', 'pathNot', 'circular', 'dependencyTypes', 'dependencyTypesNot'])
// dependency-cruiser's types a static value import (`import { f } from '…'`) never has.
const NEVER_A_VALUE_IMPORT = new Set([
  'type-only',
  'type-import',
  'pre-compilation-only',
  'dynamic-import',
  'require',
  'export',
  'core',
])

/** Do a rule's path conditions match the edge, `$1` back-references included? */
function pathsMatch(f, t, edge) {
  const fm = f.path === undefined ? [edge.from] : new RegExp(pattern(f.path)).exec(edge.from)
  if (fm === null) return false
  if (f.pathNot !== undefined && new RegExp(pattern(f.pathNot)).test(edge.from)) return false
  const sub = (re) => pattern(re).replace(/\$(\d)/g, (_m, n) => escape(fm[Number(n)] ?? ''))
  if (t.path !== undefined && !new RegExp(sub(t.path)).test(edge.to)) return false
  return t.pathNot === undefined || !new RegExp(sub(t.pathNot)).test(edge.to)
}

/**
 * Do a rule's dependency-type conditions hold for the edge? The edge surely has `import`
 * (and `local` when relative) and surely lacks NEVER_A_VALUE_IMPORT; any other type is not
 * known, and a condition that turns on one holds (closed).
 * @param {any} t @param {Edge} edge
 */
function typesHold(t, edge) {
  /** @param {string} type @returns {boolean | undefined} undefined: not known */
  const has = (type) => {
    if (type === 'import' || (type === 'local' && edge.local)) return true
    return NEVER_A_VALUE_IMPORT.has(type) ? false : undefined
  }
  const types = Array.isArray(t.dependencyTypes) ? t.dependencyTypes : null
  if (types !== null && types.every((type) => has(type) === false)) return false
  const not = Array.isArray(t.dependencyTypesNot) ? t.dependencyTypesNot : []
  return !not.some((type) => has(type) === true)
}

/**
 * Does one forbidden rule forbid a new edge? A rule with a condition this function does not
 * judge forbids once its paths match: a home must never be one the architecture step reds.
 * @param {any} rule @param {Edge} edge
 */
function ruleForbids(rule, edge) {
  const f = rule?.from ?? {}
  const t = rule?.to ?? {}
  if (!pathsMatch(f, t, edge)) return false
  if (Object.keys(f).some((k) => !JUDGED_FROM.has(k))) return true
  if (Object.keys(t).some((k) => !JUDGED_TO.has(k))) return true
  if (!typesHold(t, edge)) return false
  return t.circular === undefined || t.circular === edge.cycle()
}

/** The path relative to a vertical's src/, or null outside one. */
function verticalRel(path) {
  const m = /^packages\/verticals\/[^/]+\/src\/(.+)$/.exec(path)
  return m === null ? null : m[1]
}

/**
 * Whether a file may newly value-import `spec` resolving to `to`: no forbidden rule on that
 * edge and no anatomy law on the importing file. The edge closes a cycle when the module
 * `spec` resolves to (a package entry, for an `@app/*` one) already reaches the file.
 * @param {string} from @param {string} spec @param {string} to @param {HomeContext} ctx
 */
function lawsAdmit(from, spec, to, ctx) {
  const { importers, forbidden } = ctx
  const entry = importers.resolve(from, spec) ?? to
  const cycle = () => importers.reaches(entry, from)
  const edge = { from, to, local: spec.startsWith('.'), cycle }
  if (forbidden.some((rule) => ruleForbids(rule, edge))) return false
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
 * The names a callable is exported by, as importers.mjs reads its module: its own, an
 * alias, `default`, or several. [] for a callable nothing outside its module can import.
 * @param {Callable} m @param {Importers} importers
 */
function exportNames(m, importers) {
  return m.kind === 'function' && m.scope === '' ? importers.exportedAs(m.path, m.name) : []
}

/** Can `other`'s file import `target` (exported as `names`) as it stands today? */
function canImport(other, target, names, ctx) {
  if (other.path === target.path) return true
  const { importers, census } = ctx
  if (other.workspace.dir === target.workspace.dir) {
    return lawsAdmit(other.path, relativeSpec(other.path, target.path), target.path, ctx)
  }
  const fromWs = importers.workspaceOf(other.path)
  if (fromWs === null || !fromWs.deps.has(target.workspace.name)) return false
  const from = { name: fromWs.name, kind: workspaceKind(fromWs.dir) }
  const to = { name: target.workspace.name, tier: workspaceKind(target.workspace.dir) }
  if (mayDepend(from, to, census) !== null) return false
  return names
    .flatMap((name) => importers.exposedVia(target.path, name))
    .some((via) => lawsAdmit(other.path, via.spec, target.path, ctx))
}

/** The importer count of a member, under every name it is exported by (0 when none). */
function importerCount(m, importers) {
  return exportNames(m, importers).length === 0
    ? 0
    : importers.importersOfLocal(m.path, m.name).length
}

/** IMPORT's target: the importable member with the most importers, or null. */
function importTarget(members, ctx) {
  const ranked = members
    .map((m) => ({ m, n: importerCount(m, ctx.importers) }))
    .sort((a, b) => b.n - a.n || cmp(a.m.path, b.m.path) || a.m.line - b.m.line)
  for (const { m } of ranked) {
    const names = exportNames(m, ctx.importers)
    if (names.length === 0) continue
    if (members.every((o) => o === m || canImport(o, m, names, ctx))) return m
  }
  return null
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/** Is a new packages/shared package legal for one member? */
function liftAdmits(m, ctx) {
  const ws = ctx.importers.workspaceOf(m.path)
  const kind = workspaceKind(ws?.dir ?? m.workspace.dir)
  if (mayDepend({ name: m.workspace.name, kind }, LIFT_PACKAGE, ctx.census) !== null) return false
  return lawsAdmit(m.path, LIFT_PACKAGE.name, LIFT_PROBE, ctx)
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
