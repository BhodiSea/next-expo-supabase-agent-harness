#!/usr/bin/env node
// Gate: eval-disjoint — exemplar/holdout contamination check (eval-live module).
// The holdout set only measures generalization if the model has never seen its
// items as exemplars. This gate fails if any holdout input appears — whole or as
// a significant prefix — inside any exemplar source: the versioned prompt files
// (few-shot exemplars live there) or an optional fixtures/exemplars.json.
// Deterministic and dependency-free: runs locally, in the eval-live workflow,
// and is cheap enough to add to the validate chain if contamination ever bites.
// SOURCE: docs/harness/gates-catalog.md (eval-live module) [corpus: harness/doctrine]
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fail, failures, ok } from './lib/gate.mjs'

const GATE = 'eval-disjoint'
const HOLDOUT = 'packages/eval/fixtures/holdout.json'
const PROMPTS_DIR = 'packages/eval/prompts'
const EXEMPLARS = 'packages/eval/fixtures/exemplars.json'
// Long enough that a match means copied text, short enough to catch trimmed copies.
const PREFIX_CHARS = 60

if (!existsSync(HOLDOUT)) fail(GATE, `${HOLDOUT} not found — the holdout set is gone`)

const normalize = (text) => text.toLowerCase().replace(/\s+/g, ' ').trim()

const holdout = JSON.parse(readFileSync(HOLDOUT, 'utf8'))
const items = (holdout.items ?? []).map((item) => ({
  id: item.id ?? '<no id>',
  needle: normalize(item.input ?? '').slice(0, PREFIX_CHARS),
}))
if (items.length === 0)
  fail(GATE, `${HOLDOUT} has no items — a disjointness gate over nothing is vacuous`)

// Exemplar sources: every versioned prompt file + the optional exemplar fixture.
const sources = []
if (existsSync(PROMPTS_DIR)) {
  for (const f of readdirSync(PROMPTS_DIR).filter((f) => f.endsWith('.md'))) {
    const p = join(PROMPTS_DIR, f)
    sources.push([p, normalize(readFileSync(p, 'utf8'))])
  }
}
if (existsSync(EXEMPLARS)) {
  sources.push([EXEMPLARS, normalize(readFileSync(EXEMPLARS, 'utf8'))])
}
if (sources.length === 0) {
  fail(
    GATE,
    `no exemplar sources found (${PROMPTS_DIR}/*.md or ${EXEMPLARS}) — nothing to check against`,
  )
}

const errs = []
for (const { id, needle } of items) {
  if (needle.length === 0) {
    errs.push(`holdout item ${id} has an empty input`)
    continue
  }
  for (const [source, haystack] of sources) {
    if (haystack.includes(needle)) {
      errs.push(
        `holdout item ${id} leaks into ${source} — its text appears among the exemplars; the holdout no longer measures generalization. Remove it from one side.`,
      )
    }
  }
}

failures(GATE, errs)
ok(GATE, `${items.length} holdout item(s) disjoint from ${sources.length} exemplar source(s)`)
