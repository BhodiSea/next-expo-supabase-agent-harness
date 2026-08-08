// tools/lib/web-routes.mjs — the App Router's file→URL rules, and the rendering of the
// committed web route registry, as ONE definition shared by the generator
// (tools/gen-web-routes.mjs) and the gate (tools/check-web-routes.mjs).
//
// WHY IT IS SHARED RATHER THAN WRITTEN TWICE. The gate's job includes "the committed
// registry matches what the file tree implies", which it can only decide by re-deriving the
// registry. Two copies of the derivation would let the generator and the gate disagree about
// what a route group does to a URL — and the failure mode of that disagreement is a green
// gate over a stale artifact, which is the exact inversion this file exists to prevent. It is
// the same reason tools/lib/live-controls.mjs is shared between two controls, and the same
// reason tools/lib/inventory.mjs holds renderActions() rather than gen-action-inventory.mjs.
//
// WHY NOT REUSE check-route-manifest.mjs's deriveRoutePath. Because the two routers do not
// agree. expo-router maps a trailing `index` file to its parent path; the App Router has no
// `index` convention at all — the directory IS the path and `page` is the marker. expo-router
// has no route groups spelled `(name)` that also serve as layout scopes, no parallel routes,
// no intercepting routes, and no private `_folder` exclusion. One parser serving both would
// have to branch on surface at every rule, which is two parsers with extra steps.
// SOURCE: https://nextjs.org/docs/app/api-reference/file-conventions/page (page.js defines a
// route; the folder path is the URL)
// SOURCE: https://nextjs.org/docs/app/api-reference/file-conventions/route-groups ((folder)
// is excluded from the URL path)
// SOURCE: https://nextjs.org/docs/app/api-reference/file-conventions/dynamic-routes ([id],
// [...slug], [[...slug]])
import { existsSync, readFileSync } from 'node:fs'
import { walkFiles } from './fs-walk.mjs'

/** `page.tsx` / `page.ts` / `page.jsx` / `page.js` — the App Router's route marker. */
const PAGE_FILE_RE = /(?:^|\/)page\.[jt]sx?$/
/** The authored sidecar this module pairs with a page. */
export const META_FILE = 'page.meta.ts'
export const STATE_KEYS = ['loading', 'empty', 'error']

// A dynamic segment's NAME is a JavaScript property on the `params` object the App Router
// hands the page, so it is an identifier and camelCase is idiomatic — this tree ships
// `[orgSlug]`, `[token]` and `[trpc]`. A LITERAL segment is a piece of URL a human reads and
// types, so it stays lowercase kebab. The two are deliberately different alphabets; a single
// lowercase-only rule (which is what the mobile gate uses, correctly, for expo-router's
// kebab-cased routes) would reject `[orgSlug]` on the surface that actually has one.
const PARAM_NAME = String.raw`[A-Za-z][A-Za-z0-9_]*`
const LITERAL_SEG_RE = /^[a-z0-9-]+$/

/**
 * The URL the App Router serves a page at, from the directory that holds it.
 *
 * Returns `{ path }` or `{ error }` — never a guess. An unsupported convention (a parallel
 * `@slot`, an intercepting `(.)`/`(..)`/`(...)` prefix) is REPORTED rather than derived,
 * because deriving one wrong yields a registry that is confidently incorrect about where a
 * page lives, which is worse than a registry that says it cannot tell.
 *
 * @param {string} dirKey app/-relative directory, `''` for app/ itself
 * @returns {{ path: string } | { error: string }}
 */
export function deriveRoutePath(dirKey) {
  const segments = []
  for (const raw of dirKey === '' ? [] : dirKey.split('/')) {
    const seg = classifySegment(raw)
    if (seg.error !== undefined) return { error: seg.error }
    if (seg.url !== undefined) segments.push(seg.url)
  }
  return { path: segments.length === 0 ? '/' : `/${segments.join('/')}` }
}

/**
 * ONE App Router directory segment → what it contributes to the URL.
 *
 * Split out of deriveRoutePath because the harness holds every consumer to a cognitive
 * complexity of 15 and the combined loop scored 18 — the factory's own ratchet
 * (scripts/check-complexity-ratchet.mjs) reds on a harness function that exempts itself from
 * the bar it enforces. The split is also the honest decomposition: the loop's job is
 * accumulating a path, and this function's job is reading one convention.
 *
 * @param {string} raw
 * @returns {{ url?: string, error?: string }} `{}` for a segment that contributes nothing
 */
function classifySegment(raw) {
  // Intercepting routes are spelled as a parenthesised MARKER glued to a real segment
  // (`(.)photo`, `(..)(..)feed`). They look like route groups to a naive `^\(.*\)$` test on
  // the first token, so they are matched FIRST and refused by name.
  if (/^\(\.{1,3}\)/.test(raw)) {
    return {
      error: `segment ${JSON.stringify(raw)} is an INTERCEPTING route ((.) / (..) / (...)), which this registry does not model — an intercepted route renders at two URLs and the manifest can only name one. Move the page out of the intercepting segment, or allowlist it as chrome with a reason.`,
    }
  }
  // Parallel-route slots render INTO a layout; they are not URL segments and a `page.tsx`
  // inside one is reached at the parent's URL, not at `/@slot/...`.
  if (raw.startsWith('@')) {
    return {
      error: `segment ${JSON.stringify(raw)} is a PARALLEL route slot, which contributes no URL segment — a page inside a slot is not independently addressable. Allowlist it as chrome with a reason, or move it.`,
    }
  }
  // Route groups organise the tree and the LAYOUT scope, and contribute nothing to the URL.
  if (raw.startsWith('(') && raw.endsWith(')')) return {}
  // `[[...slug]]` (optional catch-all) and `[...slug]` both match one-or-more segments at this
  // position; the optional form ALSO matches the parent path. Both render as `*slug` and the
  // difference is recorded here rather than silently flattened.
  const catchAll = new RegExp(String.raw`^\[\[?\.\.\.(${PARAM_NAME})\]?\]$`).exec(raw)
  if (catchAll !== null) return { url: `*${catchAll[1]}` }
  const param = new RegExp(String.raw`^\[(${PARAM_NAME})\]$`).exec(raw)
  if (param !== null) return { url: `:${param[1]}` }
  if (raw.startsWith('[')) {
    return {
      error: `segment ${JSON.stringify(raw)} looks like a dynamic segment but is not one this registry recognises — use [param], [...param] or [[...param]] with an identifier name.`,
    }
  }
  if (!LITERAL_SEG_RE.test(raw)) {
    return {
      error: `segment ${JSON.stringify(raw)} is not a canonical URL segment — a literal path segment is lowercase [a-z0-9-] (it is what a human reads and types; a capital letter in a URL is one case-sensitivity bug away from a dead link).`,
    }
  }
  return { url: raw }
}

/**
 * Every routable page under `appDir`, as `{ dirKey, file, metaPath, path?, error? }`.
 *
 * A `_private` folder is excluded ENTIRELY (the App Router does not route through one), and
 * so is everything beneath it — which is why the exclusion is by path prefix and not by the
 * page's own directory name.
 * SOURCE: https://nextjs.org/docs/app/getting-started/project-structure (private folders:
 * an underscore prefix opts a folder and all its children out of routing)
 *
 * @param {string} appDir
 * @returns {Array<{ dirKey: string, file: string, metaPath: string, path?: string, error?: string }>}
 */
export function discoverPages(appDir) {
  const pages = walkFiles(appDir, {
    filter: (rel) => PAGE_FILE_RE.test(rel) && !rel.split('/').some((s) => s.startsWith('_')),
  })
  return pages
    .map((rel) => {
      const dirKey = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
      const derived = deriveRoutePath(dirKey)
      return {
        dirKey,
        file: rel.replace(/\.[jt]sx?$/, ''),
        metaPath: dirKey === '' ? `${appDir}/${META_FILE}` : `${appDir}/${dirKey}/${META_FILE}`,
        ...derived,
      }
    })
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
}

/**
 * The reviewed chrome allowlist, parsed LOUD.
 *
 * Shape mirrors tools/route-allowlist.json exactly — `allow` names shell surfaces with no
 * canonical data states, `unreachableStates` documents a state a registered route provably
 * cannot enter. Two surfaces of one product should not need two shapes for the same escape.
 *
 * A parse failure returns it as an ERROR rather than an empty allowlist. An empty allowlist
 * reads as "no page is chrome", which reds every chrome surface and looks like a project
 * problem; the actual problem is a broken escape hatch, and those must never fail open OR
 * fail confusingly.
 *
 * @param {string} path
 * @returns {{ allow: Set<string>, allowReasons: Map<string, string>, unreachable: Map<string, string>, errors: string[] }}
 */
export function readAllowlist(path) {
  const allow = new Set()
  const allowReasons = new Map()
  const unreachable = new Map()
  const errors = []
  if (!existsSync(path)) return { allow, allowReasons, unreachable, errors }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    return {
      allow,
      allowReasons,
      unreachable,
      errors: [`${path} is not valid JSON (${e.message}) — the allowlist must be reviewable data`],
    }
  }
  if (!Array.isArray(parsed.allow)) {
    errors.push(
      `${path} must carry an "allow" ARRAY of {name, reason} entries — got ${JSON.stringify(Object.keys(parsed))}`,
    )
    return { allow, allowReasons, unreachable, errors }
  }
  for (const entry of parsed.allow) {
    const okShape =
      entry !== null &&
      typeof entry === 'object' &&
      typeof entry.name === 'string' &&
      typeof entry.reason === 'string' &&
      entry.reason.trim().length > 0
    if (!okShape) {
      errors.push(
        `${path}: every allow entry must be {"name": <app/-relative page DIRECTORY, '' for the root route>, "reason": non-empty string} — got ${JSON.stringify(entry)}`,
      )
      continue
    }
    allow.add(entry.name)
    allowReasons.set(entry.name, entry.reason)
  }
  for (const entry of parsed.unreachableStates ?? []) {
    const okShape =
      entry !== null &&
      typeof entry === 'object' &&
      typeof entry.route === 'string' &&
      STATE_KEYS.includes(entry.state) &&
      typeof entry.reason === 'string' &&
      entry.reason.trim().length > 0
    if (!okShape) {
      errors.push(
        `${path}: every unreachableStates entry must be {"route": id, "state": loading|empty|error, "reason": non-empty string} — got ${JSON.stringify(entry)}`,
      )
      continue
    }
    unreachable.set(`${entry.route}.${entry.state}`, entry.reason)
  }
  return { allow, allowReasons, unreachable, errors }
}

/**
 * Read each page's colocated `page.meta.ts` into a registry entry.
 *
 * Field extraction is entry-level regex over comment-stripped source, the same technique
 * check-route-manifest.mjs uses on the mobile manifest and for the same reason: these files
 * are a closed, gate-enforced shape (`export const meta = { … } as const satisfies
 * WebRouteMeta`), and a parser is decidable over that shape without an install, a TypeScript
 * program, or a runtime import of a module that pulls the React tree behind it.
 *
 * `problems` lists pages that cannot become entries. A page whose DIRECTORY is allowlisted is
 * skipped silently — that is what the allowlist is for. Everything else is reported.
 *
 * @param {ReturnType<typeof discoverPages>} pages
 * @param {Set<string>} allow app/-relative page directories reviewed as chrome
 * @returns {{ entries: Array<object>, problems: string[] }}
 */
export function readMetas(pages, allow = new Set()) {
  const entries = []
  const problems = []
  for (const page of pages) {
    if (allow.has(page.dirKey)) continue
    const read = readOneMeta(page)
    if (read.problem !== undefined) problems.push(read.problem)
    else entries.push({ ...page, ...read.meta })
  }
  return { entries, problems }
}

/**
 * ONE page's meta, or the reason it cannot become a registry entry.
 *
 * Split out of readMetas for the reason classifySegment was split out of deriveRoutePath: the
 * combined function scored 23 against a bar of 15 that this harness enforces on every consumer,
 * and scripts/check-complexity-ratchet.mjs exists precisely so the harness cannot exempt itself.
 * The seam is real rather than cosmetic — the loop owns "which pages are in scope", this owns
 * "what does one meta file say".
 *
 * @param {{ dirKey: string, file: string, metaPath: string, path?: string, error?: string }} page
 * @returns {{ meta?: object, problem?: string }}
 */
function readOneMeta(page) {
  if (page.error !== undefined) return { problem: `${page.file}: ${page.error}` }
  if (!existsSync(page.metaPath)) {
    return {
      problem: `${page.file}: no ${page.metaPath} — the page ships with no id, no title key and no declared loading/empty/error states (the App Router serves it at ${JSON.stringify(page.path)})`,
    }
  }
  const src = readFileSync(page.metaPath, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n')
  const body = /export const meta\s*=\s*\{([\s\S]*)\}\s*as const/.exec(src)
  if (body === null) {
    return {
      problem: `${page.metaPath}: must export \`const meta = { … } as const satisfies WebRouteMeta\` — the registry generator reads this shape and found none`,
    }
  }
  const id = /\bid:\s*'([a-z0-9-]+)'/.exec(body[1])?.[1]
  const titleKey = /\btitleKey:\s*'([^']+)'/.exec(body[1])?.[1]
  const statesBody = /\bstates:\s*\{([\s\S]*?)\}/.exec(body[1])?.[1]
  const missing = [
    id === undefined && '`id` (a lowercase [a-z0-9-] string literal)',
    titleKey === undefined && '`titleKey` (a key in apps/web/lib/i18n/catalog.ts)',
    statesBody === undefined && '`states` ({loading, empty, error})',
  ].filter(Boolean)
  if (missing.length > 0) {
    return { problem: `${page.metaPath}: missing ${missing.join(', ')}` }
  }
  const states = {}
  for (const key of STATE_KEYS) {
    const m = new RegExp(`\\b${key}:\\s*(null|'[^']*')`).exec(statesBody)
    states[key] = m === null ? undefined : m[1] === 'null' ? null : m[1].slice(1, -1).trim()
  }
  return { meta: { id, titleKey, states } }
}

/** `(protected)/o/[orgSlug]/notes` -> `notesMeta`-safe binding derived from the route id. */
const bindingFor = (id) => `${id.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())}Meta`

/**
 * The committed registry's exact bytes.
 *
 * Import order and entry order are BOTH sorted by `path`, so the artifact is a function of the
 * file tree alone: two machines that walked the same tree produce the same file, and a diff in
 * it means a route moved rather than that someone's filesystem enumerated differently.
 *
 * @param {Array<{ id: string, path: string, file: string }>} entries
 * @returns {string}
 */
export function renderRegistry(entries) {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  // Imports sort by SPECIFIER, entries by PATH, and the two orders differ on purpose. The
  // entry list is read by humans as a route table, where URL order is the useful one; the
  // import list is read by nobody and only needs to be a deterministic function of the file
  // tree. Sorting the type import into the same list (rather than pinning it first) is what
  // keeps that true — one rule, no special case.
  const imports = [
    `import type { WebRouteEntry } from './routes'`,
    ...sorted.map((e) => {
      // `slice(0, -1)` on a root-level `page` would yield `pag` — the root route's file key
      // carries no slash, so the no-directory case is tested rather than arithmetic'd.
      const at = e.file.lastIndexOf('/')
      const dir = at === -1 ? '' : e.file.slice(0, at)
      const spec = dir === '' ? `../app/${META_FILE}` : `../app/${dir}/${META_FILE}`
      return `import { meta as ${bindingFor(e.id)} } from '${spec.replace(/\.ts$/, '')}'`
    }),
  ]
    .sort((a, b) => {
      const sa = /from '([^']+)'/.exec(a)?.[1] ?? ''
      const sb = /from '([^']+)'/.exec(b)?.[1] ?? ''
      return sa < sb ? -1 : sa > sb ? 1 : 0
    })
    .join('\n')
  const rows = sorted
    .map(
      (e) =>
        `  {\n    ...${bindingFor(e.id)},\n    file: '${e.file}',\n    path: '${e.path}',\n  },`,
    )
    .join('\n')
  return `// GENERATED by tools/gen-web-routes.mjs — DO NOT EDIT. Run \`pnpm gen\` and commit the diff.
//
// Every user-reachable page under apps/web/app registers here. \`path\` and \`file\` are DERIVED
// from the App Router's file tree, so this registry cannot lie about where a page lives; the
// id, the title key and the three data-state test ids come from the \`${META_FILE}\` beside each
// \`page.tsx\`. The \`route-manifest\` gate closes the loop both ways — a page with no meta and no
// reviewed chrome entry in tools/web-route-allowlist.json fails validate, and a meta naming a
// page that no longer exists fails too.
${imports}

export const WEB_ROUTES = [
${rows}
] as const satisfies readonly WebRouteEntry[]
`
}
