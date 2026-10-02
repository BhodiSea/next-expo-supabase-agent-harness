#!/usr/bin/env node
// check-escape-registry — the runner. Every rule lives in scripts/lib/escape-registry.mjs,
// which is pure so tests can inject inputs; this file owns the fs reads and the exit code.
// The split follows scripts/lib/ramp-sites.mjs, and it is not cosmetic: with the logic and
// the `process.exit(1)` in one module, importing the check to test it would EXIT THE TEST
// RUNNER the moment the real tree had a finding — the failure would look like a crash
// rather than a report.
// SOURCE: template/base/tools/lib/enforcement-surface.mjs (the drift-is-invisible header)
import {
  KINDS,
  NOT_PROPOSABLE,
  OUT_OF_POPULATION,
  TOLERATED_ABSENT,
  deriveRegistry,
  reconcileProposable,
} from './lib/escape-registry.mjs'

// URL hrefs, never fileURLToPath output: a Windows drive path is an invalid ESM
// specifier (ERR_UNSUPPORTED_ESM_URL_SCHEME) — the class that crashed
// check-chain-budget on windows-latest, written identically here.
const HERE = (p) => new URL(p, import.meta.url).href

const { SEEDED_FILES } = await import(HERE('../installer/lib/layout.mjs'))
const { ESCAPE_LISTS } = await import(HERE('../template/base/tools/lib/enforcement-surface.mjs'))
const { WRITE_PROTECTED } = await import(
  HERE('../template/base/.claude/hooks/lib/guard-rules.mjs')
)
// The fourth list (1.1.0, #65): the registers `apply-proposal` may write.
const { PROPOSABLE } = await import(HERE('../installer/lib/proposals.mjs'))

const { population, problems } = deriveRegistry({
  seeded: SEEDED_FILES,
  escapes: ESCAPE_LISTS,
  guards: WRITE_PROTECTED,
})

problems.push(...reconcileProposable({ escapes: ESCAPE_LISTS, proposable: PROPOSABLE }))
// The flow exists because the agent cannot write the register itself, so a proposable path
// with no write-guard rule would be a hole, not a flow.
for (const file of PROPOSABLE) {
  if (!WRITE_PROTECTED.some((r) => r.re.test(file))) {
    problems.push(`${file} is in installer/lib/proposals.mjs#PROPOSABLE but no write-guard rule covers it`)
  }
}

// Every KINDS / TOLERATED_ABSENT / OUT_OF_POPULATION entry must name a file that is
// actually in one of the three lists. A stale exemption is how a registry quietly stops
// describing the tree — the same rule tools/migrations-allow.json is held to.
const known = new Set([...population, ...OUT_OF_POPULATION.keys()])
for (const [file, label] of [
  ...[...KINDS.keys()].map((f) => [f, 'KINDS']),
  ...[...TOLERATED_ABSENT].map((f) => [f, 'TOLERATED_ABSENT']),
  ...[...OUT_OF_POPULATION.keys()].map((f) => [f, 'OUT_OF_POPULATION']),
]) {
  if (!known.has(file)) {
    problems.push(
      `${label} names ${file}, which is in none of the three lists — a stale entry. Remove it, or restore the file to the list it belongs in.`,
    )
  }
}

// check-canary-coverage.mjs keys RULE_CANARIES by rule id, so a duplicate id silently
// shares one canary and the second rule ships unproven.
const guardIds = new Set(WRITE_PROTECTED.map((r) => r.id))
if (guardIds.size !== WRITE_PROTECTED.length) {
  problems.push(
    'WRITE_PROTECTED has duplicate rule ids — check-canary-coverage.mjs keys RULE_CANARIES by id, so a duplicate silently shares one canary',
  )
}

if (problems.length > 0) {
  console.error(`ESCAPE REGISTRY: ${String(problems.length)} problem(s):`)
  for (const p of problems) console.error(`  - ${p}`)
  console.error(
    '\nThese four lists are the harness\'s own escape-hatch bookkeeping. enforcement-surface.mjs\'s header promised that a second hand-maintained copy "would drift, and the drift would be invisible" — this script is what makes it visible.',
  )
  process.exit(1)
}

console.log(
  `ESCAPE REGISTRY: CLEAN (${String(population.length)} member(s) across SEEDED ∩ tools/** ∪ ESCAPE_LISTS; ${String(KINDS.size)} declared non-escape kind(s), ${String(TOLERATED_ABSENT.size)} tolerated-absent, ${String(WRITE_PROTECTED.length)} write-guard rule(s); ${String(PROPOSABLE.length)} proposable, ${String(NOT_PROPOSABLE.size)} not)`,
)
