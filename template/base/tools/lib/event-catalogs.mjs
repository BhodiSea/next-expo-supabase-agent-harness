// Which event catalogs tools/gen-event-catalog.mjs walks (1.1.0). Pure reads, split from
// the generator so the harness suite can test them without tsx or a workspace graph.
//
// A vertical opts in from its own code: its `./client` entry exports the catalog as
// EVENT_CATALOG. The generator is harness-owned and hash-pinned, so a list of imports
// inside it could only grow by forking an owned file, and a vertical left off that list
// dropped out of both the generated and the committed catalog without any diff. The name
// is searched for in the entry's CODE, with comments blanked first (lib/source-text.mjs):
// a name in prose must not opt a vertical in, because the generator then imports it and
// reads the export. A vertical that names it and exports no catalog fails closed in
// catalogOf.
//
// Each file is read once, with no existence check first. Only ENOENT and ENOTDIR count
// as absent; any other read error is thrown, as it is in hashInputs (lib/gate.mjs).
// SOURCE: docs/harness/README.md (contracts gate) [corpus: harness/doctrine]
import { readdirSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { blankComments } from './source-text.mjs'

/** The one export name the generator reads from a vertical's `./client` entry. */
export const CATALOG_EXPORT = 'EVENT_CATALOG'

const VERTICALS_ROOT = 'packages/verticals'
const DECLARES = new RegExp(`\\b${CATALOG_EXPORT}\\b`)

// The 1.0.x compatibility entry, removed when the example leaves the scaffold: the one
// import the 1.0.x generator hard-coded. An upgraded install keeps its seeded vertical,
// whose ./client exports the catalog under this name, so reading only the new export would
// drop its rows from a catalog nobody changed. See legacyApplies for when it is read.
export const LEGACY = {
  pkg: '@app/notes',
  specifier: '@app/notes/client',
  exportName: 'noteEvents',
}

const absent = (/** @type {any} */ e) => e?.code === 'ENOENT' || e?.code === 'ENOTDIR'

/** @param {string} path @returns {string | null} */
function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (e) {
    if (absent(e)) return null
    throw e
  }
}

/**
 * The `./client` entry of a package.json `exports` field: a string, or an object whose
 * `import` or `default` field is a string. Anything else is no entry.
 * @param {unknown} exportsField @returns {string | null}
 */
function clientEntry(exportsField) {
  if (exportsField === null || typeof exportsField !== 'object') return null
  const entry = exportsField['./client']
  if (typeof entry === 'string') return entry
  if (entry === null || typeof entry !== 'object') return null
  if (typeof entry.import === 'string') return entry.import
  if (typeof entry.default === 'string') return entry.default
  return null
}

/**
 * Every package under packages/verticals/, in plain .sort() order of its directory.
 *   pkg      — the manifest's `name`, or the directory name when it has none;
 *   file     — its `./client` entry as a POSIX path relative to `root`, or null;
 *   declares — true when that file's code (comments blanked) names EVENT_CATALOG.
 * A directory without a package.json is skipped; one whose package.json does not parse
 * throws an error naming it.
 * @param {string} [root] @returns {Array<{ pkg: string, file: string | null, declares: boolean }>}
 */
export function discoverVerticals(root = '.') {
  let dirs
  try {
    dirs = readdirSync(join(root, VERTICALS_ROOT))
  } catch (e) {
    if (absent(e)) return []
    throw e
  }
  const found = []
  for (const dir of dirs.sort()) {
    const manifestPath = `${VERTICALS_ROOT}/${dir}/package.json`
    const text = readOrNull(join(root, manifestPath))
    if (text === null) continue
    let manifest
    try {
      manifest = JSON.parse(text)
    } catch (e) {
      throw new Error(`${manifestPath} is not valid JSON (${e.message})`)
    }
    const entry = clientEntry(manifest?.exports)
    const file = entry === null ? null : posix.join(VERTICALS_ROOT, dir, entry)
    const source = file === null ? null : readOrNull(join(root, file))
    found.push({
      pkg: typeof manifest?.name === 'string' ? manifest.name : dir,
      file,
      declares: source !== null && DECLARES.test(blankComments(source)),
    })
  }
  return found
}

/**
 * `value` when it is an event catalog: a plain object whose every entry is
 * `{ name, version, description }`, `name` equal to its key, `version` a number and
 * `description` a string. Anything else throws an error naming `where`.
 * @param {unknown} value @param {string} where
 */
export function catalogOf(value, where) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    const got = value === null || Array.isArray(value) ? JSON.stringify(value) : typeof value
    throw new Error(
      `${where}: ${CATALOG_EXPORT} is not an event catalog (got ${got}) — export the vertical's defineEventCatalog(...) result under that name, or stop naming it`,
    )
  }
  for (const [key, definition] of Object.entries(value)) {
    const shaped =
      definition !== null &&
      typeof definition === 'object' &&
      definition.name === key &&
      typeof definition.version === 'number' &&
      typeof definition.description === 'string'
    if (!shaped) {
      throw new Error(
        `${where}: ${CATALOG_EXPORT}[${JSON.stringify(key)}] is not an event definition { name: ${JSON.stringify(key)}, version: <number>, description: <string> }`,
      )
    }
  }
  return value
}

/** The root package.json text, or null when there is none. @param {string} [root] */
export function readRootPackage(root = '.') {
  return readOrNull(join(root, 'package.json'))
}

/**
 * Whether the generator reads LEGACY: only while BOTH hold —
 *   - the root package.json lists LEGACY.pkg in `dependencies` or `devDependencies`, the
 *     condition under which the 1.0.x import resolved at all;
 *   - no discovered vertical named LEGACY.pkg declares EVENT_CATALOG, so the catalog is
 *     never walked twice.
 * No root package.json never applies; text that does not parse throws naming package.json.
 * @param {string | null} rootPackageText
 * @param {Array<{ pkg: string, declares: boolean }>} verticals
 */
export function legacyApplies(rootPackageText, verticals) {
  if (rootPackageText === null) return false
  let manifest
  try {
    manifest = JSON.parse(rootPackageText)
  } catch (e) {
    throw new Error(`package.json is not valid JSON (${e.message})`)
  }
  const listed = [manifest?.dependencies, manifest?.devDependencies].some(
    (deps) =>
      deps !== null &&
      typeof deps === 'object' &&
      !Array.isArray(deps) &&
      Object.hasOwn(deps, LEGACY.pkg),
  )
  if (!listed) return false
  return !verticals.some((v) => v.pkg === LEGACY.pkg && v.declares)
}
