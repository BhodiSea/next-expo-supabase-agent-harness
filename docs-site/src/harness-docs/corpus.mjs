// The documentation corpus, read IN PLACE from the repository: no copies, no symlinks.
//
// A page's route is the path its file has under an installed project's docs/ folder:
// template/base/docs/<rel> and template/modules/<module>/docs/<rel> both install to
// docs/<rel>. So a relative link that works in an installed project works on the site, and
// a route claimed by two trees is a real install-path collision, which fails the build.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, posix, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const GITHUB_REPO = 'https://github.com/BhodiSea/next-expo-supabase-agent-harness'
export const DEFAULT_BRANCH = 'main'

/** The repository root: docs-site/src/harness-docs/ is three levels below it. */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
if (!existsSync(join(REPO_ROOT, 'template', 'base', 'docs'))) {
  throw new Error(`no template/base/docs under ${REPO_ROOT}: the site renders that tree in place`)
}
/** This site's own directory, repo-relative (`docs-site`), for the edit links of its own pages. */
export const SITE_DIR = relative(REPO_ROOT, fileURLToPath(new URL('../../', import.meta.url))).split(sep).join('/')

/**
 * Files under the corpus globs that are templates for files a project writes itself, not
 * documentation. They stay off the site; a link to one goes to its GitHub page instead.
 */
const EXCLUDED = new Map([
  ['template/base/docs/adr/0000-adr-template.md', 'the skeleton `/adr` copies for a new decision record'],
  ['template/modules/store-metadata/docs/store/app-review-notes.md', 'a fill-in template for the App Review notes'],
])

/** Sorted, recursive listing of `.md` files (readdir order is the filesystem's). */
function markdownFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((rel) => rel.endsWith('.md') && statSync(join(dir, rel)).isFile())
    .sort()
}

/** `harness/README.md` -> `harness`; `x/mobile-sentry.patch.md` -> `x/mobile-sentry-patch`. */
export function routeFor(docsRel) {
  const segments = docsRel.replace(/\.md$/, '').split('/')
  if (segments.at(-1) === 'README') segments.pop()
  return segments.map((s) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')).join('/')
}

/** Repo-relative docs folders: the base tree's, then every module's. Modules are discovered, never listed. */
function corpusRoots() {
  const roots = ['template/base/docs']
  const modulesDir = join(REPO_ROOT, 'template', 'modules')
  for (const name of readdirSync(modulesDir).sort()) {
    if (existsSync(join(modulesDir, name, 'docs'))) roots.push(`template/modules/${name}/docs`)
  }
  return roots
}

/** Every `.md` file under the corpus roots, as [root, path relative to the root's docs/]. */
function corpusFiles() {
  return corpusRoots().flatMap((root) => markdownFiles(join(REPO_ROOT, root)).map((f) => [root, f.split(sep).join('/')]))
}

/**
 * @typedef {{ repoPath: string, installPath: string, absPath: string, fileURL: URL, route: string }} CorpusPage
 * @type {{ pages: CorpusPage[], byAbsPath: Map<string, CorpusPage>, byInstallPath: Map<string, CorpusPage> } | undefined}
 */
let cached
export function loadCorpus() {
  if (cached) return cached
  const pages = []
  const byRoute = new Map()
  const files = corpusFiles()
  // A stale exclusion would hide nothing and say something false, so it fails instead.
  for (const repoPath of EXCLUDED.keys()) {
    if (!files.some(([root, rel]) => posix.join(root, rel) === repoPath)) {
      throw new Error(`corpus.mjs excludes ${repoPath}, which no longer exists: remove the entry`)
    }
  }
  for (const [root, rel] of files) {
    const repoPath = posix.join(root, rel)
    if (EXCLUDED.has(repoPath)) continue
    const route = routeFor(rel)
    if (route === '') throw new Error(`${repoPath}: a corpus page cannot claim the site root`)
    const clash = byRoute.get(route)
    if (clash) throw new Error(`route "${route}" is claimed by both ${clash} and ${repoPath}`)
    byRoute.set(route, repoPath)
    const absPath = join(REPO_ROOT, repoPath)
    pages.push({ repoPath, installPath: `docs/${rel}`, absPath, fileURL: pathToFileURL(absPath), route })
  }
  if (pages.length === 0) throw new Error('the docs corpus is empty: a site over nothing is a false green')
  cached = {
    pages,
    byAbsPath: new Map(pages.map((p) => [p.absPath, p])),
    byInstallPath: new Map(pages.map((p) => [p.installPath, p])),
  }
  return cached
}

/** Repo-relative POSIX path for an absolute path. */
export function repoRelative(absPath) {
  return relative(REPO_ROOT, absPath).split(sep).join('/')
}
