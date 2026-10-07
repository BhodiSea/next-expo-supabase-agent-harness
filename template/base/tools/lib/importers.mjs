// tools/lib/importers.mjs — who imports what (2.1.0, #186): for each export of each module, the
// set of non-test files that import it, and their workspaces. One textual count, read the way
// lib/vertical-anatomy.mjs reads import specifiers (comment-blanked source, no compiler), so it
// needs no parser and agrees with the anatomy laws on what an import is.
//
// What counts as importing an export:
//   - a named import (aliased or not), and a default import (the export `default`);
//   - `import type` and `import { type X }`: a type is a `single-consumer` subject too;
//   - a namespace import (`import * as ns`) imports EVERY export of the module;
//   - a dynamic `import('<literal>')` or `require('<literal>')`, likewise every export;
//   - through barrels: `export { a as b } from`, `export * from` and `export * as ns from` are
//     followed to the module that DEFINES the name, and the importer is counted there. A
//     barrel re-exporting a name is not itself an importer of it.
// Resolution: a relative specifier from the importing file (`.js` written for a `.ts`
// source, a directory's index); an `@app/*` specifier through the target workspace's
// package.json `exports` map (a conditional entry resolves `types`, then `import`, then
// `default`). Anything else is a third-party module and is not counted.
// Excluded as importers: `*.test.ts(x)`, `__tests__/` and `e2e/`.
// LIMITS, stated: a computed specifier (`import(name)`), a `require` of a computed name, an
// export spelled through `export =`, and a destructured `export const { a } = …` are not seen,
// so the count can only be LOW for them — a fact that undercounts a single-consumer subject's
// importers says "1 importer" where the truth is more, never the reverse for a seen import.
// Consumers: homes.mjs (IMPORT's target), complexity.mjs (single-consumer, call sites), and
// later the packet order (#187) and the rule of two (#191).
// SOURCE: docs/harness/gates-catalog.md (duplication gate) [corpus: harness/doctrine]
import { readFileSync } from 'node:fs'
import { walkFiles } from './fs-walk.mjs'
import { blankComments } from './source-text.mjs'

const EXCLUDE_DIRS = new Set(['node_modules', 'dist', 'coverage', '.next', '.expo', '.turbo'])
const SOURCE = /\.(ts|tsx|mts|cts)$/
const DECL = /\.d\.ts$/

/** @param {string} path */
const isTestPath = (path) =>
  /\.test\.tsx?$/.test(path) || /(^|\/)__tests__\//.test(path) || /(^|\/)e2e\//.test(path)

/**
 * @typedef {{ name: string, from: string, imported: string }} Reexport
 * @typedef {{
 *   path: string, local: Set<string>, reexports: Map<string, { spec: string, name: string }>,
 *   stars: string[], namespaces: Map<string, string>, barrel: boolean, defaultName: string | null,
 *   imports: { spec: string, names: { imported: string, local: string }[], all: boolean }[],
 * }} ModuleText
 */

/** Every non-declaration source file under apps/ and packages/, sorted. */
function sourceFiles() {
  const out = []
  for (const scope of ['apps', 'packages']) {
    for (const rel of walkFiles(scope, { excludeDirs: EXCLUDE_DIRS })) {
      if (SOURCE.test(rel) && !DECL.test(rel)) out.push(`${scope}/${rel}`)
    }
  }
  return out.sort()
}

// ---- reading one module -----------------------------------------------------------------

const LOCAL_DECL =
  /\bexport\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(function\s*\*?|class|interface|type|enum|const\s+enum|const|let|var)\s+([A-Za-z_$][\w$]*)/g

/** The names of an `{ a, b as c, type d }` list: [imported, exported-or-local] pairs. */
function listNames(list) {
  const out = []
  for (const part of list.split(',')) {
    const m = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(part)
    if (m !== null) out.push({ imported: m[1], local: m[2] ?? m[1] })
  }
  return out
}

/** @param {string} path @param {string} text comment-blanked @returns {ModuleText} */
function readModule(path, text) {
  /** @type {ModuleText} */
  const mod = {
    path,
    local: new Set(),
    reexports: new Map(),
    stars: [],
    namespaces: new Map(),
    barrel: false,
    imports: [],
    defaultName: null,
  }
  for (const m of text.matchAll(LOCAL_DECL)) mod.local.add(m[2])
  const def =
    /\bexport\s+default\s+(?:async\s+)?(?:(?:function\s*\*?|class)\s+)?([A-Za-z_$][\w$]*)/.exec(
      text,
    )
  if (/\bexport\s+default\b/.test(text)) mod.local.add('default')
  if (def !== null && !['function', 'class', 'async'].includes(def[1])) mod.defaultName = def[1]
  readExportLists(text, mod)
  readImports(text, mod)
  mod.barrel = isBarrelText(text)
  return mod
}

function readExportLists(text, mod) {
  const re = /\bexport\s+(?:type\s+)?\{([^}]*)\}\s*(?:from\s*(['"])([^'"]+)\2)?/g
  for (const m of text.matchAll(re)) {
    for (const { imported, local } of listNames(m[1])) {
      if (m[3] === undefined) mod.local.add(local)
      else mod.reexports.set(local, { spec: m[3], name: imported })
    }
  }
  for (const m of text.matchAll(
    /\bexport\s*\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s+)?from\s*(['"])([^'"]+)\2/g,
  )) {
    if (m[1] === undefined) mod.stars.push(m[3])
    else mod.namespaces.set(m[1], m[3])
  }
}

function readImports(text, mod) {
  const re = /\bimport\s+(?:type\s+)?([^'"`;]*?)\s*from\s*(['"])([^'"]+)\2/g
  for (const m of text.matchAll(re)) mod.imports.push(importClause(m[1], m[3]))
  for (const re2 of [
    /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
    /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
  ]) {
    for (const m of text.matchAll(re2)) mod.imports.push({ spec: m[2], names: [], all: true })
  }
}

/** `X`, `X, { a }`, `{ a, b as c }`, `* as ns`, `X, * as ns`. */
function importClause(clause, spec) {
  const names = []
  let all = false
  const brace = /\{([^}]*)\}/.exec(clause)
  if (brace !== null) names.push(...listNames(brace[1]))
  const ns = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(clause)
  if (ns !== null) {
    all = true
    names.push({ imported: '*', local: ns[1] })
  }
  const def = /^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause)
  if (def !== null && def[1] !== 'type') names.push({ imported: 'default', local: def[1] })
  return { spec, names, all }
}

/** A pure barrel: nothing but export-from statements once they are removed. */
function isBarrelText(text) {
  const stripped = text
    .replace(/\bexport\s*\*\s*(?:as\s+[\w$]+\s+)?from\s*['"][^'"]+['"]\s*;?/g, '')
    .replace(/\bexport\s+(?:type\s+)?\{[^}]*\}\s*from\s*['"][^'"]+['"]\s*;?/g, '')
  return stripped.trim() === '' && text.trim() !== ''
}

// ---- workspaces and resolution ----------------------------------------------------------

/**
 * @typedef {{ dir: string, name: string, exports: Map<string, string>,
 *   deps: Set<string> }} Workspace
 */

/** Every workspace manifest under apps/ and packages/. @returns {Workspace[]} */
function readWorkspaces() {
  const out = []
  for (const scope of ['apps', 'packages']) {
    for (const rel of walkFiles(scope, {
      excludeDirs: EXCLUDE_DIRS,
      filter: (p) => /(^|\/)package\.json$/.test(p),
    })) {
      const dir = `${scope}/${rel}`.replace(/\/package\.json$/, '')
      const ws = readWorkspace(dir)
      if (ws !== null) out.push(ws)
    }
  }
  return out
}

function readWorkspace(dir) {
  let pkg
  try {
    pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'))
  } catch {
    return null
  }
  if (typeof pkg?.name !== 'string') return null
  const exports = new Map()
  const map = pkg.exports
  if (typeof map === 'string') exports.set('.', map)
  else if (map !== null && typeof map === 'object') {
    for (const [key, value] of Object.entries(map)) {
      const target = exportTarget(value)
      if (target !== null) exports.set(key, target)
    }
  }
  return { dir, name: pkg.name, exports, deps: new Set(Object.keys(pkg.dependencies ?? {})) }
}

/** A conditional export entry's file: `types`, then `import`, then `default`. */
function exportTarget(value) {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object') return null
  for (const key of ['types', 'import', 'default']) {
    const t = exportTarget(value[key])
    if (t !== null) return t
  }
  return null
}

/** POSIX join-and-normalise; null when it climbs above the root. */
function normalise(path) {
  const out = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length === 0) return null
      out.pop()
    } else out.push(part)
  }
  return out.join('/')
}

const CANDIDATES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']

/** The file a module path names, trying the TS spellings. */
function fileFor(base, files) {
  if (base === null) return null
  const stems = [base, base.replace(/\.(m|c)?js$/, '')]
  for (const stem of stems) {
    for (const ext of CANDIDATES) if (files.has(`${stem}${ext}`)) return `${stem}${ext}`
  }
  return null
}

// ---- the index ----------------------------------------------------------------------------

/**
 * Build the importer index over the tree (cwd is the project root).
 */
export function buildImporters() {
  const paths = sourceFiles()
  const files = new Set(paths)
  const workspaces = readWorkspaces()
  const modules = new Map()
  for (const path of paths) {
    modules.set(path, readModule(path, blankComments(readFileSync(path, 'utf8'))))
  }
  return new ImporterIndex(modules, files, workspaces)
}

class ImporterIndex {
  /**
   * @param {Map<string, ModuleText>} modules @param {Set<string>} files
   * @param {Workspace[]} workspaces
   */
  constructor(modules, files, workspaces) {
    this.modules = modules
    this.files = files
    this.workspaces = [...workspaces].sort((a, b) => b.dir.length - a.dir.length)
    /** @type {Map<string, Map<string, Set<string>>>} `${path}#${name}` -> file -> local names */
    this.importers = new Map()
    for (const mod of modules.values()) {
      if (!isTestPath(mod.path)) this.#count(mod)
    }
  }

  /** The workspace a file is in (the deepest workspace directory above it), or null. */
  workspaceOf(path) {
    return this.workspaces.find((w) => path.startsWith(`${w.dir}/`)) ?? null
  }

  /** The file a specifier resolves to from `from`, or null (third party, or unresolved). */
  resolve(from, spec) {
    if (spec.startsWith('.')) {
      const dir = from.split('/').slice(0, -1).join('/')
      return fileFor(normalise(`${dir}/${spec}`), this.files)
    }
    const ws = this.workspaces.find((w) => spec === w.name || spec.startsWith(`${w.name}/`))
    if (ws === undefined) return null
    const sub = spec === ws.name ? '.' : `.${spec.slice(ws.name.length)}`
    const target = ws.exports.get(sub)
    if (target === undefined) return null
    return fileFor(normalise(`${ws.dir}/${target}`), this.files)
  }

  /**
   * The (module, name) pairs that DEFINE `name` as `path` exports it, following re-exports.
   * @returns {{ path: string, name: string }[]}
   */
  definitionsOf(path, name, seen = new Set()) {
    const key = `${path}#${name}`
    const mod = this.modules.get(path)
    if (mod === undefined || seen.has(key)) return []
    seen.add(key)
    if (mod.local.has(name)) return [{ path, name }]
    const re = mod.reexports.get(name)
    if (re !== undefined) {
      const target = this.resolve(path, re.spec)
      return target === null ? [] : this.definitionsOf(target, re.name, seen)
    }
    if (mod.namespaces.has(name))
      return this.everyDefinition(this.resolve(path, mod.namespaces.get(name)), seen)
    if (name === 'default') return []
    for (const spec of mod.stars) {
      const target = this.resolve(path, spec)
      const found = target === null ? [] : this.definitionsOf(target, name, seen)
      if (found.length > 0) return found
    }
    return []
  }

  /** Every name a module exports: its own, its re-exports, and its stars' (not `default`). */
  exportNames(path, seen = new Set()) {
    const mod = this.modules.get(path)
    if (mod === undefined || seen.has(path)) return []
    seen.add(path)
    const names = new Set([...mod.local, ...mod.reexports.keys(), ...mod.namespaces.keys()])
    for (const spec of mod.stars) {
      const target = this.resolve(path, spec)
      if (target === null) continue
      for (const n of this.exportNames(target, seen)) if (n !== 'default') names.add(n)
    }
    return [...names].sort()
  }

  /** The definitions of every export of a module (a namespace import's reach). */
  everyDefinition(path, seen = new Set()) {
    if (path === null) return []
    return this.exportNames(path).flatMap((n) => this.definitionsOf(path, n, new Set(seen)))
  }

  /** Is the module a pure barrel (nothing but re-exports)? */
  isBarrel(path) {
    return this.modules.get(path)?.barrel === true
  }

  #count(mod) {
    for (const imp of mod.imports) {
      const target = this.resolve(mod.path, imp.spec)
      if (target === null) continue
      if (imp.all) this.#countNamespace(mod.path, imp, target)
      for (const { imported, local } of imp.names) {
        if (imported === '*') continue
        for (const def of this.definitionsOf(target, imported)) this.#add(def, mod.path, local)
      }
    }
  }

  /** A namespace import (or a bare `import()`) imports every export, as `ns.name`. */
  #countNamespace(file, imp, target) {
    const ns = imp.names.find((n) => n.imported === '*')?.local
    for (const def of this.everyDefinition(target)) {
      this.#add(def, file, ns === undefined ? def.name : `${ns}.${def.name}`)
    }
  }

  #add(def, file, local) {
    const key = `${def.path}#${def.name}`
    if (!this.importers.has(key)) this.importers.set(key, new Map())
    const byFile = this.importers.get(key)
    if (!byFile.has(file)) byFile.set(file, new Set())
    byFile.get(file).add(local)
  }

  /**
   * The non-test files importing the export `name` that `path` defines, sorted, each with
   * its workspace and the local names it binds.
   * @returns {{ file: string, workspace: string | null, locals: string[] }[]}
   */
  importersOf(path, name) {
    const byFile = this.importers.get(`${path}#${name}`)
    if (byFile === undefined) return []
    return [...byFile.keys()].sort().map((file) => ({
      file,
      workspace: this.workspaceOf(file)?.name ?? null,
      locals: [...byFile.get(file)].sort(),
    }))
  }

  /**
   * The package subpaths through which a defined export is reachable from outside its
   * workspace: every `exports` entry of the defining workspace whose module exports it.
   * @returns {{ pkg: string, spec: string, name: string }[]}
   */
  exposedVia(path, name) {
    const ws = this.workspaceOf(path)
    if (ws === null) return []
    const out = []
    for (const [sub, target] of [...ws.exports].sort()) {
      const file = fileFor(normalise(`${ws.dir}/${target}`), this.files)
      if (file === null) continue
      const spec = sub === '.' ? ws.name : `${ws.name}${sub.slice(1)}`
      for (const n of this.exportNames(file)) {
        if (this.definitionsOf(file, n).some((d) => d.path === path && d.name === name)) {
          out.push({ pkg: ws.name, spec, name: n })
        }
      }
    }
    return out
  }

  /** The local name a module's `export default` binds, or null. */
  defaultName(path) {
    return this.modules.get(path)?.defaultName ?? null
  }
}
