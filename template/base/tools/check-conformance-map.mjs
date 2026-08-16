#!/usr/bin/env node
// tools/check-conformance-map.mjs — the conformance MAP's closure gate. Third script of the
// `docs-sync` chain step, beside check-docs-sync.mjs and check-essential-eight.mjs — the
// multi-script shape `boundaries` and `route-manifest` have shipped since 0.1.x.
//
// WHAT THIS GATE IS FOR. tools/conformance-map.json states, row by row, which live control
// in this tree bears on each requirement of OWASP ASVS 5.0.0, OWASP MASVS 2.1 and CRA
// Annex I, how much of it that control reaches, and what is left. The map is only worth
// having if its grades are trustworthy, so this gate judges the CLAIMS rather than the
// security: every claimed control is one something actually runs (a chain step, a shipped
// CI job, a gate script a lane invokes, or a write-guard rule id), every not-applicable
// carries a negative proof, every chain step is either mapped or carries a written reason
// why not, no sentence in the file claims a level, and the two generated documents are
// byte-identical to a fresh generation.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not red on `not-covered`. A hundred-odd rows
// are honestly unbuilt or the consumer's to build and say so; redding on them would create
// steady pressure to grade rows generously to get green, which is the exact failure the
// map exists to prevent. What reds is a MALFORMED or INFLATED claim.
//
// It also cannot tell you the application IS ASVS Level 1, 2 or 3, MASVS-verified, or
// CRA-conformant, and it never will: a verification level attaches to a verification of an
// application performed by an assessor, and CRA conformity is a manufacturer's legal act
// that no code tree performs. See the register's own header. Rows with `module` set are
// CONDITIONAL on that opt-in module and are judged for liveness only where it is installed.
// SOURCE: docs/compliance/controls-crosswalk.md
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { STOP_HOOK_STEPS, VALIDATE_STEPS } from './harness.config.mjs'
import {
  censusProblems,
  claimProblems,
  guardRuleIds,
  installedModules,
  rowProblems,
  summarise,
  unmappedControlProblems,
} from './lib/conformance-map.mjs'
import { failures, ok } from './lib/gate.mjs'
import { liveControls } from './lib/live-controls.mjs'

const GATE = 'conformance-map'
const ROOT = process.cwd()
const REGISTER = 'tools/conformance-map.json'
const MODULES = 'tools/modules.json'
const GUARD_RULES = '.claude/hooks/lib/guard-rules.mjs'
const GENERATOR = 'tools/gen-conformance-docs.mjs'

// --- the register --------------------------------------------------------------------
const path = join(ROOT, REGISTER)
if (!existsSync(path)) {
  failures(
    GATE,
    [
      `${REGISTER} is missing — it is the reviewed conformance map this gate judges. Pull the seeded exemplar with \`npx next-expo-supabase-agent-harness update --refresh-seeded ${REGISTER}\`.`,
    ],
    null,
  )
}

let register
try {
  register = JSON.parse(readFileSync(path, 'utf8'))
} catch (e) {
  failures(
    GATE,
    [`${REGISTER} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`],
    null,
  )
}

// Anti-vacuity, in the shape check-essential-eight.mjs uses: a register that judges nothing
// must FAIL, never pass quietly. An empty conformance map reads as "everything is fine" to
// exactly the reader it would mislead.
if (!Array.isArray(register.requirements) || register.requirements.length === 0) {
  failures(
    GATE,
    [
      `${REGISTER} declares no requirements. An empty conformance map is not a clean bill of health — it is a missing one.`,
    ],
    null,
  )
}

// --- what actually runs here ----------------------------------------------------------
const steps = [...VALIDATE_STEPS, ...STOP_HOOK_STEPS].map(([name]) => name)
const controls = liveControls({ steps, workflowDir: join(ROOT, '.github', 'workflows') })
// A write-guard rule is a live control too — it runs on every Edit/Write/Bash tool call —
// and four rows rest on one (dangerouslySetInnerHTML, the weak-crypto and key-material
// rules, the .env read ban). Read from the file the hooks read, so the set is THIS tree's.
const guardPath = join(ROOT, GUARD_RULES)
const guardRules = existsSync(guardPath) ? guardRuleIds(readFileSync(guardPath, 'utf8')) : null
for (const id of guardRules?.keys() ?? []) controls.live.add(id)

// --- the module universe, and which of it is installed here ---------------------------
let knownModules
try {
  knownModules = new Set(JSON.parse(readFileSync(join(ROOT, MODULES), 'utf8')).modules)
} catch (e) {
  failures(
    GATE,
    [
      `${MODULES} is missing or unparseable (${e instanceof Error ? e.message : String(e)}) — module rows are judged against it, and a map that cannot tell a real module from a typo cannot judge them.`,
    ],
    null,
  )
}
const installed = installedModules({ root: ROOT, modules: knownModules })

// --- the generated documents are what a fresh generation would write ------------------
// The crosswalk and the threat model are DERIVED from this register, the chain and the
// guard tables; a hand-edit to either is a claim nobody reviewed. The generator's --check
// mode exits non-zero naming the drifted file, and its output is quoted rather than
// paraphrased so the fix is the line it prints.
const regen = existsSync(join(ROOT, GENERATOR))
  ? spawnSync(process.execPath, [GENERATOR, '--check'], { cwd: ROOT, encoding: 'utf8' })
  : null
const regenProblems =
  regen === null
    ? [
        `${GENERATOR} is missing — the crosswalk and threat model cannot be regen-diffed; \`update\` restores it.`,
      ]
    : regen.status === 0
      ? []
      : [
          `generated documents drifted from the register: ${`${regen.stdout ?? ''}${regen.stderr ?? ''}`.trim().split('\n').join(' / ')}`,
        ]

// --- judge ------------------------------------------------------------------------------
const problems = [
  ...(guardRules === null
    ? [
        `${GUARD_RULES} is missing — the write-guard rule ids are live controls this map names, and without the table they resolve to nothing.`,
      ]
    : []),
  ...censusProblems(register),
  ...rowProblems(register, controls, { installedModules: installed, knownModules }),
  ...unmappedControlProblems(register, steps),
  ...claimProblems(register),
  ...regenProblems,
]

failures(
  GATE,
  problems,
  `Each finding is a CLAIM defect, not a security defect. Grade conservatively: 'covered' needs a live control whose subject IS the requirement and an artefact above documentation; 'partial' says which part the control reaches; absence of a surface is never coverage; and no sentence in the map claims a level. ${REGISTER} is git-clean-enforced by check-gate-integrity.mjs, so every regrade lands in a PR diff where somebody can see it. Regenerate the documents with \`node ${GENERATOR}\`.`,
)

const s = summarise(register)
ok(
  GATE,
  `${String(s.total)} requirement(s): ${String(s.covered)} covered, ${String(s.partial)} partial, ${String(s.notCovered)} not-covered, ${String(s.notApplicable)} not-applicable — ASVS 5.0.0 ${String(s.byStandard.asvs)} / MASVS 2.1 ${String(s.byStandard.masvs)} / CRA Annex I ${String(s.byStandard.cra)}; ${String(s.moduleConditional)} module-conditional (${String(installed.size)} module(s) installed here); this register does NOT claim a verification level — see ${REGISTER} header.`,
)
