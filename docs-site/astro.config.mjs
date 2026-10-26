// The documentation site (#171): Starlight over the docs that `init` installs, read in place
// from template/base/docs/ and template/modules/*/docs/. Nothing is copied into this folder.
// Build: `pnpm install --frozen-lockfile && pnpm run build` here; .github/workflows/pages.yml
// runs the same two commands and deploys dist/ to GitHub Pages from main.
import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { satteri } from '@astrojs/markdown-satteri'
import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'
import starlightLinksValidator from 'starlight-links-validator'
import starlightLlmsTxt from 'starlight-llms-txt'
import { DEFAULT_BRANCH, GITHUB_REPO, REPO_ROOT, SITE_DIR } from './src/harness-docs/corpus.mjs'
import { harnessHastPlugins, harnessMdastPlugins } from './src/harness-docs/markdown-plugins.mjs'
import { harnessSidebar, llmsPageIndex } from './src/harness-docs/site-index.mjs'

const site = 'https://bhodisea.github.io'
const base = '/next-expo-supabase-agent-harness'
const title = 'next-expo-supabase-agent-harness'
const description =
  'The doctrine, gates catalog, runbooks, decision records and module guides that the next-expo-supabase-agent-harness CLI writes into every project it scaffolds.'
// The og.png card (docs/media/social-preview.png) is text only; this is its text.
const OG_IMAGE_ALT =
  'next-expo-supabase-agent-harness: a CLI that scaffolds a pnpm monorepo with a Next.js web app and an Expo (React Native) mobile app on one Supabase backend, plus Claude Code hooks and CI gates.'

/**
 * og.png is the repository's social preview image, copied into the build output so the
 * site and the GitHub repository page share one image. The build fails without it.
 */
function socialPreview() {
  const source = join(REPO_ROOT, 'docs', 'media', 'social-preview.png')
  return {
    name: 'harness-social-preview',
    hooks: {
      'astro:config:setup': () => {
        if (!existsSync(source)) throw new Error('docs/media/social-preview.png is missing: the site copies it to og.png for og:image')
      },
      'astro:build:done': ({ dir }) => {
        copyFileSync(source, new URL('og.png', dir))
      },
    },
  }
}

export default defineConfig({
  site,
  base,
  trailingSlash: 'always',
  markdown: {
    // Sätteri is Astro 7's default processor; it is configured here to add the plugins.
    processor: satteri({
      // GitHub renders these files without smart punctuation, so the site does too: straight
      // quotes, and `--hard` stays two hyphens.
      features: { smartPunctuation: false },
      mdastPlugins: harnessMdastPlugins({ base: `${base}/` }),
      hastPlugins: harnessHastPlugins(),
    }),
  },
  integrations: [
    socialPreview(),
    starlight({
      title,
      description,
      social: [{ icon: 'github', label: 'GitHub', href: GITHUB_REPO }],
      // Corpus pages carry their own edit link (set by the loader); this covers the site's own pages.
      editLink: { baseUrl: `${GITHUB_REPO}/edit/${DEFAULT_BRANCH}/${SITE_DIR}/` },
      lastUpdated: true,
      // Starlight's own Markdown transforms (heading anchor links, asides) run only on
      // src/content/docs unless the folders read in place are listed here.
      markdown: { processedDirs: [join(REPO_ROOT, 'template/base/docs/'), join(REPO_ROOT, 'template/modules/')] },
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      sidebar: harnessSidebar(),
      routeMiddleware: './src/route-data.mjs',
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: `${site}${base}/og.png` } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: `${site}${base}/og.png` } },
        { tag: 'meta', attrs: { property: 'og:image:alt', content: OG_IMAGE_ALT } },
        { tag: 'meta', attrs: { name: 'twitter:image:alt', content: OG_IMAGE_ALT } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1280' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '640' } },
        {
          tag: 'script',
          attrs: { type: 'application/ld+json' },
          content: JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebSite', name: title, url: `${site}${base}/` }).replace(/</g, '\\u003c'),
        },
      ],
      plugins: [
        // Internal links and #anchors only; it never fetches an external URL.
        starlightLinksValidator({
          errorOnRelativeLinks: true,
          errorOnInvalidHashes: true,
          errorOnLocalLinks: true,
          sameSitePolicy: 'validate',
        }),
        starlightLlmsTxt({
          projectName: title,
          description,
          // llms.txt lists no pages by itself; this puts every page in it.
          details: `Every documentation page, with the repository file it is rendered from (the site's landing page, ${site}${base}/, links into them):\n\n${llmsPageIndex(`${site}${base}/`)}`,
          customSets: [
            { label: 'Harness doctrine and gates', paths: ['harness/**'], description: 'the doctrine, enforcement tiers and the gates catalog' },
            { label: 'Architecture decisions', paths: ['adr/**'] },
            { label: 'Runbooks', paths: ['runbooks/**'] },
            { label: 'Security and compliance', paths: ['security/**', 'compliance/**'] },
            { label: 'Modules', paths: ['modules/**', 'store/**'] },
          ],
          promote: ['index*', 'harness*'],
          // The release-by-release upgrade log is most of llms-small.txt's size.
          exclude: ['runbooks/harness-upgrade'],
          // Starlight's heading anchor links read as "Section titled …" noise in plain text.
          customSelectors: { all: ['.sl-anchor-link'] },
        }),
      ],
    }),
  ],
})
