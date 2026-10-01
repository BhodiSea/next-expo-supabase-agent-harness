#!/usr/bin/env node
// Skill-reference generator/checker for the harness repo (1.1.0, N09).
//
// The authoring-vertical-slice skill's references say they were copied from the worked
// example (`references/dal-dto.md`, `references/migration-rls.md`), and until this script
// nothing held them to it: `prompts` compares each file with its own locked hash, and
// `docs-sync` reads skill bodies only for commands and a closed map of retired tokens. The
// example could change shape and the references keep teaching the old one with every gate
// green, which is how 0.3.0 found ten authoring surfaces teaching a tRPC symbol the code no
// longer exported.
//
// So the code-bearing parts of the references are REGIONS, cut verbatim from marked spans of
// the example's source (the grammar is in scripts/lib/skill-regions.mjs):
//   create-procedure  packages/api/src/routers/notes.ts   -> references/dal-dto.md
//   org-policies      supabase/schemas/20_notes.sql        -> references/migration-rls.md
// The prose around a region stays hand-written, and so does any taught line the example does
// not carry: only code that compiles and is tested upstream is generated. An install
// receives markdown; nothing here reaches a consumer's chain.
//
//   --check (default): regenerate in memory, exit 1 naming each drifted file and region id.
//   --write:           rewrite each drifted region's body. It refuses, and writes nothing,
//                      while any marker is unknown, duplicated, unbalanced, orphaned,
//                      malformed or carries a placeholder, or while there are no regions.
//   usage: node scripts/generate-skill-references.mjs [--check | --write]
//
// Deterministic: the walk is sorted, the output is LF, every path is POSIX, no date is read.
// The repository root comes from this file's own location, so a copy inside a mirror judges
// only the mirror (tests/gates/skill-references.test.mjs).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { walkFiles } from '../installer/lib/fs-walk.mjs'
import { templateCandidates } from '../installer/lib/layout.mjs'
import { planRegions, sourceLang } from './lib/skill-regions.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

// The closed set of region ids. A region is registered here in the change that adds its
// markers, so an id both sides agree on still reds when nobody meant it to exist.
const REGION_IDS = ['create-procedure', 'org-policies']

// Where an install-relative source= path may resolve, in this order: the demo tree first,
// because the worked example lives there since 2.0.0 (#85) and its copy of a shared file is
// the example's; then the stack tree, then the base tree (check-seeded-migrations resolves a
// record's paths the same way).
const TREES = ['template/demo', 'template/stack', 'template/base']

const USAGE = 'usage: node scripts/generate-skill-references.mjs [--check | --write]'
const args = process.argv.slice(2)
if (args.length > 1 || args.some((a) => a !== '--check' && a !== '--write')) {
  console.error(USAGE)
  process.exit(1)
}
const mode = args[0] === '--write' ? '--write' : '--check'

const files = walkFiles(join(ROOT, 'template')).map((rel) => `template/${rel}`)
const read = (file) => ({ file, text: readFileSync(join(ROOT, file), 'utf8') })
const plan = planRegions({
  references: files.filter((f) => f.endsWith('.md')).map(read),
  sources: files.filter((f) => sourceLang(f) !== undefined).map(read),
  resolveSource: (installRel) =>
    TREES.flatMap((t) => templateCandidates(installRel).map((c) => `${t}/${c}`)).find((p) =>
      existsSync(join(ROOT, p)),
    ) ?? null,
  knownIds: REGION_IDS,
})

const driftLines = plan.drift.map(
  (d) => `  ${d.file}:${String(d.line)}: region '${d.id}' differs from its source, ${d.source}`,
)

if (plan.problems.length > 0) {
  console.error(`generate-skill-references ${mode}: FAILED`)
  for (const p of plan.problems) console.error(`  ${p}`)
  for (const d of driftLines) console.error(d)
  console.error('  fix the markers by hand: --write regenerates a region body, never a marker')
  process.exit(1)
}

if (mode === '--write') {
  for (const { file, text } of plan.rewrites) {
    writeFileSync(join(ROOT, file), text)
    console.log(`generate-skill-references --write: rewrote ${file}`)
  }
  if (plan.rewrites.length === 0) {
    console.log(`generate-skill-references --write: all ${String(plan.regions)} regions already match their sources`)
  }
  process.exit(0)
}

if (driftLines.length > 0) {
  console.error('generate-skill-references --check: FAILED')
  for (const d of driftLines) console.error(d)
  console.error('  fix: node scripts/generate-skill-references.mjs --write')
  process.exit(1)
}

console.log(
  `generate-skill-references --check: OK (${String(plan.regions)} regions in ${String(plan.referenceFiles)} references match their sources)`,
)
