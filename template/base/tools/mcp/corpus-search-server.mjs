#!/usr/bin/env node
// corpus_search MCP server — grounding/citation lookup over a version-pinned
// standards corpus. Keyword match for now; swap for embeddings later behind the same
// tool contract. Used by the citation-verifier subagent and slice authors to ground a
// // SOURCE: citation. Returns NO_MATCH honestly rather than fabricating.
// It serves both corpus files through tools/lib/corpus.mjs (1.0.4), the reader the
// provenance gate uses: tools/mcp/corpus/index.json (the harness's pinned authorities)
// and tools/mcp/corpus/project.json (the project's own). On an id both pin, the index
// wins; a malformed project.json is ignored, so its ids answer NO_MATCH until it parses.
// SOURCE: docs/harness/README.md (writing tools for agents; corpus grounding) [corpus: harness/doctrine]
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { corpusById, loadCorpus } from '../lib/corpus.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// The install root: this file lives at tools/mcp/.
const ROOT = join(here, '..', '..')

function loadIndex() {
  const url = process.env['CORPUS_INDEX_URL']
  // Ignore an UNEXPANDED `${CORPUS_INDEX_URL}` placeholder: when the env var is unset, some MCP
  // hosts pass the .mcp.json template string through literally — treating it as a path made every
  // lookup silently NO_MATCH against an empty index (a corpus-pin gap found during a real
  // citation-verification pass).
  // SOURCE: .mcp.json (env template)
  const usable = url && !/^https?:/.test(url) && !url.includes('${')
  // The override replaces the UPSTREAM index only; project.json is always read from the
  // install. A relative override resolves against the server's cwd, as it always has.
  let corpus = loadCorpus({
    root: ROOT,
    upstreamPath: usable ? resolve(url.replace(/^file:\/\//, '')) : undefined,
  })
  // An override that points nowhere must not silently blank the corpus — fall back to local.
  if (usable && corpus.upstream !== 'ok') corpus = loadCorpus({ root: ROOT })
  return [...corpusById(corpus.entries).values()].map((e) => e.entry)
}

const server = new Server(
  { name: 'corpus_search', version: '0.1.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      description:
        'Search the version-pinned standards corpus for an authoritative source. Returns high-signal {id, version, url, snippet, sha256} entries, or NO_MATCH. Use to ground a // SOURCE: citation; do not invent sources.',
      inputSchema: {
        properties: {
          k: { description: 'max results (default 3)', type: 'number' },
          query: { description: 'keywords to match against corpus titles/text', type: 'string' },
        },
        required: ['query'],
        type: 'object',
      },
      name: 'corpus_search',
    },
    {
      description:
        'Resolve a corpus id to its pinned {id, version, url, sha256} entry for existence/hash verification of a // SOURCE: [corpus: <id>] reference.',
      inputSchema: { properties: { id: { type: 'string' } }, required: ['id'], type: 'object' },
      name: 'corpus_resolve',
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const index = loadIndex()
  const { name, arguments: args = {} } = req.params
  if (name === 'corpus_resolve') {
    const hit = index.find((e) => e.id === args.id)
    const text = hit
      ? JSON.stringify(hit, null, 2)
      : `NO_MATCH: no corpus entry with id ${JSON.stringify(args.id)}`
    return { content: [{ text, type: 'text' }] }
  }
  if (name === 'corpus_search') {
    const terms = String(args.query ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
    const hits = index
      .map((e) => ({
        e,
        score: terms.filter((t) => `${e.title ?? ''} ${e.text ?? ''}`.toLowerCase().includes(t))
          .length,
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Number(args.k ?? 3))
      .map(({ e }) => ({
        id: e.id,
        sha256: e.sha256,
        snippet: String(e.text ?? '').slice(0, 280),
        url: e.url,
        version: e.version,
      }))
    return {
      content: [{ text: hits.length ? JSON.stringify(hits, null, 2) : 'NO_MATCH', type: 'text' }],
    }
  }
  return { content: [{ text: `unknown tool: ${name}`, type: 'text' }], isError: true }
})

await server.connect(new StdioServerTransport())
