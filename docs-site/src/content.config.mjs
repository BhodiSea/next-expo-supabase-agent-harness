import { defineCollection } from 'astro:content'
import { docsSchema } from '@astrojs/starlight/schema'
import { harnessDocsLoader } from './harness-docs/loader.mjs'

export const collections = {
  docs: defineCollection({ loader: harnessDocsLoader(), schema: docsSchema() }),
}
