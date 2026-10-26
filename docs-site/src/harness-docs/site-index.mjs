// Config-time views of the corpus: the sidebar and the llms.txt page index. Both come from
// the same listing the loader renders, so a new page appears everywhere at once.
//
// The sidebar is built from `slug` items rather than `autogenerate`: Starlight's autogenerate
// groups pages by their file path under src/content/docs, which a file read in place never
// has. A `slug` item takes its label from the page title.
import { readFileSync } from 'node:fs'
import { loadCorpus } from './corpus.mjs'

const GROUP_LABELS = {
  harness: 'Harness',
  adr: 'Architecture decisions',
  runbooks: 'Runbooks',
  security: 'Security',
  compliance: 'Compliance',
  reviews: 'Review records',
  modules: 'Modules',
  store: 'Store metadata',
}
const GROUP_ORDER = Object.keys(GROUP_LABELS)

const labelFor = (dir) => GROUP_LABELS[dir] ?? dir.charAt(0).toUpperCase() + dir.slice(1)
const rank = (dir) => (GROUP_ORDER.includes(dir) ? GROUP_ORDER.indexOf(dir) : GROUP_ORDER.length)
// A folder's README (route === dir) first, then alphabetical.
const byRoute = (dir) => (a, b) => (a.route === dir ? -1 : b.route === dir ? 1 : a.route.localeCompare(b.route))

/** Pages grouped by a key, in first-seen order. */
function groupBy(pages, keyOf) {
  const groups = new Map()
  for (const page of pages) {
    const key = keyOf(page)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(page)
  }
  return groups
}

export function harnessSidebar() {
  const groups = groupBy(loadCorpus().pages, (p) => p.route.split('/')[0])
  return [...groups.keys()]
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((dir) => {
      const pages = groups.get(dir)
      if (dir !== 'modules') return { label: labelFor(dir), items: pages.sort(byRoute(dir)).map((p) => ({ slug: p.route })) }
      // modules/<name>/... becomes one collapsed group per module.
      const perModule = groupBy(pages, (p) => p.route.split('/')[1])
      return {
        label: labelFor(dir),
        collapsed: true,
        items: [...perModule.keys()].sort().map((name) => ({
          label: name,
          items: perModule.get(name).sort(byRoute(`modules/${name}`)).map((p) => ({ slug: p.route })),
        })),
      }
    })
}

/** Plain-text title of the first `# ` heading outside code fences (for llms.txt labels only). */
function firstH1(source) {
  let fence = null
  for (const line of source.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1][0]
    if (marker) {
      if (fence === null) fence = marker
      else if (fence === marker) fence = null
      continue
    }
    const heading = fence === null ? /^ {0,3}#[ \t]+(.*)$/.exec(line) : null
    if (heading) {
      // An ATX heading may close with `#`s; inline code and emphasis keep their text.
      const text = heading[1].replace(/[ \t]#+[ \t]*$/, '').trim()
      return text.replace(/`([^`]*)`/g, '$1').replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1')
    }
  }
  return undefined
}

/** A Markdown list of every corpus page, for starlight-llms-txt's `details`. */
export function llmsPageIndex(siteWithBase) {
  return loadCorpus()
    .pages.map((p) => `- [${firstH1(readFileSync(p.absPath, 'utf8')) ?? p.route}](${siteWithBase}${p.route}/): \`${p.repoPath}\``)
    .join('\n')
}
