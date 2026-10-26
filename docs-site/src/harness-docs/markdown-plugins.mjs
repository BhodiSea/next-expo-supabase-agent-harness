// Sätteri plugins for the in-place corpus (Sätteri is Astro 7's default Markdown processor).
//
// astro.config.mjs passes them to satteri({ mdastPlugins, hastPlugins }), so they run BEFORE
// the plugins Starlight and starlight-links-validator push onto the same processor later.
// That order is what makes the gate ids below the ids that the heading anchor links, the
// table of contents, Pagefind's sub-results and the link validator all see.
import { existsSync, statSync } from 'node:fs'
import { dirname, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { slug as githubSlug } from 'github-slugger'
import { DEFAULT_BRANCH, GITHUB_REPO, loadCorpus, repoRelative } from './corpus.mjs'

const corpusPage = (fileURL) => (fileURL ? loadCorpus().byAbsPath.get(fileURLToPath(fileURL)) : undefined)

// Block-level containers: raw HTML directly inside one of these is a block, not inline text.
const FLOW_PARENTS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition'])

/**
 * Raw HTML in the corpus is shown as text. GitHub's tag filter displays `<tenant column>` or
 * `<feature-name>` literally; a browser would read them as tags, and a `<Title>` would start
 * a <title> element that swallows the rest of the page. HTML comments (cspell directives,
 * the GENERATED banners) stay comments.
 */
function rawHtmlAsText() {
  return {
    name: 'harness-raw-html-as-text',
    html(node, ctx) {
      const value = node.value.trim()
      if (value.startsWith('<!--') && value.endsWith('-->')) return
      const text = { type: 'text', value: node.value }
      ctx.replaceNode(node, FLOW_PARENTS.has(ctx.parent(node)?.type) ? { type: 'paragraph', children: [text] } : text)
    },
  }
}

/**
 * Title from the first top-level `# ` heading, which is then removed so that Starlight's own
 * <h1>, rendered from `title`, is the only one. The meta description is the first paragraph,
 * top-level or the opening of a top-level blockquote (the generated pages lead with a quoted
 * note), that says what the page is about, as plain text cut at a word boundary.
 */
function titleFromFirstH1() {
  let taken = false
  let described = false
  return {
    name: 'harness-title-from-first-h1',
    heading(node, ctx) {
      const fm = ctx.data.astro?.frontmatter
      if (taken || !fm || fm.title !== undefined || node.depth !== 1) return
      if (ctx.parent(node)?.type !== 'root') return
      taken = true
      fm.title = ctx.textContent(node).trim()
      ctx.removeNode(node)
    },
    paragraph(node, ctx) {
      const fm = ctx.data.astro?.frontmatter
      if (described || !fm || fm.description !== undefined) return
      const parent = ctx.parent(node)
      const inTopQuote = parent?.type === 'blockquote' && ctx.parent(parent)?.type === 'root'
      if (parent?.type !== 'root' && !inTopQuote) return
      const text = ctx
        .textContent(node)
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^Generated document\.\s*/, '')
        .replace(/^SOURCE: \S+ \([^)]*\)\.\s*/, '')
      // A status line, a citation alone or a lead-in to a list does not describe the page.
      if (text === '' || text.startsWith('Status:') || text.endsWith(':')) return
      described = true
      const cut = text.lastIndexOf(' ', 157)
      const head = text.slice(0, cut > 0 ? cut : 157).replace(/[\s,;:.–—-]+$/, '')
      fm.description = text.length <= 160 ? text : `${head}…`
    },
  }
}

/**
 * Relative links. A link to another corpus page becomes that page's route; it is resolved
 * against the path both files have in an installed project's docs/, so a module page can
 * link into the base docs exactly as it does after `init`. A link to any other file in the
 * repository becomes its GitHub page. A link to nothing fails the build.
 */
function rewriteRelativeLinks(page, base) {
  const { byInstallPath } = loadCorpus()
  const rewrite = (url) => {
    if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('#') || url.startsWith('/')) return undefined
    const [pathPart, hash] = url.split('#', 2)
    const suffix = hash ? `#${hash}` : ''
    const installed = posix.normalize(posix.join(posix.dirname(page.installPath), decodeURI(pathPart)))
    const hit = byInstallPath.get(installed) ?? byInstallPath.get(posix.join(installed, 'README.md'))
    if (hit) return `${base}${hit.route}/${suffix}`
    const target = resolve(dirname(page.absPath), decodeURI(pathPart))
    const repoPath = repoRelative(target)
    if (repoPath.startsWith('..')) throw new Error(`${page.repoPath}: relative link "${url}" leaves the repository`)
    if (!existsSync(target)) throw new Error(`${page.repoPath}: relative link "${url}" resolves to ${repoPath}, which does not exist`)
    const kind = statSync(target).isDirectory() ? 'tree' : 'blob'
    return `${GITHUB_REPO}/${kind}/${DEFAULT_BRANCH}/${repoPath}${suffix}`
  }
  const visit = (node, ctx) => {
    const next = rewrite(node.url)
    if (next !== undefined) ctx.setProperty(node, 'url', next)
  }
  return { name: 'harness-rewrite-relative-links', link: visit, definition: visit }
}

/** Text of the nearest preceding top-level <h2>, for a node whose parent is the root. */
function sectionOf(topLevel, ctx) {
  const root = ctx.parent(topLevel)
  for (let i = (ctx.indexOf(topLevel) ?? 0) - 1; i >= 0; i -= 1) {
    const sibling = root.children[i]
    if (sibling.type === 'element' && sibling.tagName === 'h2') return ctx.textContent(sibling)
  }
  return ''
}

/**
 * Stable gate anchors on the gates catalog: `#gate-<name>` on each gate heading and on each
 * CI-only lane bullet. A gate heading is an h3 in the grammar check-docs-sync.mjs enforces:
 * an optional step number, the gate's name, then a dash and its command. GitHub's anchors
 * carry the number and the command, so they move when the chain is renumbered; the GitHub
 * anchor stays reachable as an alias, so links copied from github.com still land. A
 * duplicate anchor, or a catalog that yields none, fails the build.
 */
function gateAnchors() {
  // `<n>. <name> <em dash> ...` or `<name> <em dash> ...`, as the catalog writes them.
  const GATE_HEADING = /^(?:\d+[a-z]?\.\s+)?([a-z0-9][a-z0-9-]*)\s+—/
  const seen = new Set()
  let headings = 0
  let lanes = 0
  const claim = (id, where) => {
    if (seen.has(id)) throw new Error(`gates-catalog: two entries claim the anchor #${id} (${where})`)
    seen.add(id)
  }
  return {
    name: 'harness-gate-anchors',
    element: [
      {
        filter: ['h3'],
        visit(node, ctx) {
          const text = ctx.textContent(node)
          const m = GATE_HEADING.exec(text)
          if (!m) return
          claim(`gate-${m[1]}`, text)
          headings += 1
          ctx.setProperty(node, 'id', `gate-${m[1]}`)
          // Pagefind weighs h3 text at 5 by default; a gate's name is what people search for.
          ctx.setProperty(node, 'data-pagefind-weight', '10')
          ctx.insertBefore(node, { type: 'element', tagName: 'span', properties: { id: githubSlug(text) }, children: [] })
        },
      },
      {
        filter: ['li'],
        visit(node, ctx) {
          // CI-only lanes are top-level bullets that open with a bold name: `- **db-perf** (...)`.
          const list = ctx.parent(node)
          if (ctx.parent(list)?.type !== 'root' || !sectionOf(list, ctx).startsWith('CI-only lanes')) return
          const first = node.children.find((c) => c.type === 'element')
          const lead = first?.tagName === 'p' ? first.children.find((c) => c.type === 'element') : first
          if (lead?.tagName !== 'strong') return
          const name = ctx.textContent(lead)
          claim(`gate-${githubSlug(name)}`, name)
          lanes += 1
          ctx.setProperty(node, 'id', `gate-${githubSlug(name)}`)
          ctx.setProperty(lead, 'data-pagefind-weight', '10')
        },
      },
    ],
    after() {
      if (headings === 0) throw new Error('gates-catalog: no h3 matched the gate heading grammar check-docs-sync.mjs enforces, so no gate has a stable anchor')
      if (lanes === 0) throw new Error('gates-catalog: no bullet under "CI-only lanes" opened with a bold lane name, so no lane has a stable anchor')
    },
  }
}

/** @param {{ base: string }} opts `base` is Astro's base with a trailing slash. */
export function harnessMdastPlugins({ base }) {
  return [
    ({ fileURL }) => (corpusPage(fileURL) ? rawHtmlAsText() : undefined),
    ({ fileURL }) => (corpusPage(fileURL) ? titleFromFirstH1() : undefined),
    ({ fileURL }) => {
      const page = corpusPage(fileURL)
      return page ? rewriteRelativeLinks(page, base) : undefined
    },
  ]
}

export function harnessHastPlugins() {
  return [({ fileURL }) => (corpusPage(fileURL)?.repoPath === 'template/base/docs/harness/gates-catalog.md' ? gateAnchors() : undefined)]
}
