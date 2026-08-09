#!/usr/bin/env node
// check-corpus-fidelity — the pinned corpus is tamper-EVIDENT but self-certifying:
// each entry's sha256 hashes its own `text` against ITSELF, never against the authority it
// claims to summarise. So a corpus entry could cite a URL that 404s, or one that never
// existed, and every gate stayed green — the provenance chain would be grounded in nothing.
//
// What this checks (and what it deliberately does NOT):
//   ✓ every cited authority RESOLVES — an http(s) `url` answers 2xx, a repo-relative `url`
//     names a file that exists. A dead authority is a broken citation, full stop.
//   ✗ NOT "text is a verbatim substring of the page": corpus `text` is a distilled summary
//     BY DESIGN (that is what makes it usable mid-turn), so a substring assert would be
//     false for every entry. Whether a summary faithfully represents its source is a
//     judgement call — that is the `citation-verifier` subagent's job, not a regex's.
//
// NETWORK-DEPENDENT, so it is CI-only and scheduled (nightly), never in the agent-time
// chain: a flaky network must never red an agent's turn or a PR. The http half is only
// falsifiable there — but the OFFLINE half (a repo-relative url must name a file that
// exists) is falsifiable anywhere, which is what the [corpus-path] positional is for.
//   usage: node scripts/check-corpus-fidelity.mjs [corpus-path]
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const ARG = process.argv[2] ? resolve(process.argv[2]) : null
const CORPUS = ARG
  ? pathToFileURL(ARG)
  : new URL('../template/base/tools/mcp/corpus/index.json', import.meta.url)
// Where a repo-relative `url` may ground: the shipped template, then the repo root — or,
// for a fixture corpus, the directory beside the corpus file, so the offline half can be
// watched failing without network (tests/gates/check-corpus-fidelity.test.mjs).
const RELATIVE_ROOTS = ARG
  ? [new URL('./', CORPUS)]
  : [new URL('../template/base/', import.meta.url), new URL('../', import.meta.url)]
const corpus = JSON.parse(readFileSync(CORPUS, 'utf8'))

const TIMEOUT_MS = 15_000
// Some doc hosts reject HEAD or bot-ish agents; a browser-shaped UA avoids false 403s.
const HEADERS = {
  'user-agent':
    'Mozilla/5.0 (compatible; next-expo-supabase-agent-harness/corpus-fidelity; +https://github.com/BhodiSea/next-expo-supabase-agent-harness)',
}

async function resolves(url) {
  // GET (not HEAD): several documentation hosts 405 a HEAD but serve the GET fine.
  const res = await fetch(url, {
    headers: HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  return { ok: res.ok, status: res.status }
}

const problems = []
let httpChecked = 0
let pathChecked = 0

const results = await Promise.allSettled(
  corpus.map(async (entry) => {
    const { id, url } = entry
    if (typeof url !== 'string' || url.trim() === '') {
      problems.push(`corpus entry ${id}: missing url`)
      return
    }
    if (!/^https?:\/\//.test(url)) {
      // A repo-relative authority (the harness's own doctrine docs). It must exist in the
      // shipped template, or the citation grounds in nothing.
      pathChecked += 1
      if (!RELATIVE_ROOTS.some((base) => existsSync(new URL(url, base)))) {
        problems.push(`corpus entry ${id}: repo-relative url "${url}" names no file that exists`)
      }
      return
    }
    httpChecked += 1
    try {
      const { ok, status } = await resolves(url)
      if (!ok) {
        problems.push(`corpus entry ${id}: ${url} → HTTP ${String(status)} (the cited authority does not resolve)`)
      }
    } catch (e) {
      problems.push(`corpus entry ${id}: ${url} → ${e.name === 'TimeoutError' ? 'timed out' : String(e.message)}`)
    }
  }),
)
for (const r of results) {
  if (r.status === 'rejected') problems.push(`corpus check crashed: ${String(r.reason)}`)
}

if (problems.length > 0) {
  console.error(`CORPUS FIDELITY: ${String(problems.length)} problem(s):`)
  for (const p of problems) console.error(`  - ${p}`)
  console.error(
    '\nA citation that grounds in a dead authority grounds in nothing. Repin the entry (url + version + text + sha256) against a live source.',
  )
  process.exit(1)
}
console.log(
  `CORPUS FIDELITY: CLEAN (${String(corpus.length)} entries — ${String(httpChecked)} live URL(s) resolve, ${String(pathChecked)} repo-relative authority file(s) exist)`,
)
