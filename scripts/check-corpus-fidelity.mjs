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
// chain: a flaky network must never red an agent's turn or a PR.
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'

const CORPUS = new URL('../template/base/tools/mcp/corpus/index.json', import.meta.url)
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
      const inTemplate = new URL(`../template/base/${url}`, import.meta.url)
      if (!existsSync(inTemplate) && !existsSync(new URL(`../${url}`, import.meta.url))) {
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
