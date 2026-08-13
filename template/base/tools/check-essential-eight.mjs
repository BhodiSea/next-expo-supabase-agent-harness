#!/usr/bin/env node
// tools/check-essential-eight.mjs — the ASD Essential Eight conformance register's
// closure gate. Second script of the `docs-sync` chain step, the shape `boundaries` and
// `route-manifest` have shipped since 0.1.x.
//
// WHAT THIS GATE IS FOR. tools/essential-eight.json claims, row by row, how a generated
// application stands against the 149 cumulative requirements of Maturity Level Three. The
// register is only worth having if its grades are trustworthy, so this gate judges the
// CLAIMS rather than the security: every claimed control is one something actually runs,
// every not-applicable carries a negative proof, every unbuilt row names the obligation
// that owns it, and no artefact is counted twice.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not red on `not-implemented`. Thirty-two rows
// are honestly unbuilt and say so; redding on them would create steady pressure to grade
// rows generously to get green, which is the exact failure the register exists to prevent.
// What reds is a MALFORMED or INFLATED claim — a control nobody runs, a shared artefact
// claimed twice, a top-tier evidence claim with no proof behind it.
//
// It also cannot tell you the application IS Maturity Level Three. Nothing can: maturity
// attaches to an organisation's system, ASD certifies no products, and 46 of the 149
// requirements are unreachable by any repository. See the register's own header.
// SOURCE: docs/compliance/essential-eight.md
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { STOP_HOOK_STEPS, VALIDATE_STEPS } from './harness.config.mjs'
import {
  censusProblems,
  negativeProofProblems,
  rowProblems,
  sharedClauseProblems,
  summarise,
  supersessionProblems,
} from './lib/essential-eight.mjs'
import { walkFiles } from './lib/fs-walk.mjs'
import { failures, ok } from './lib/gate.mjs'
import { liveControls } from './lib/live-controls.mjs'

const GATE = 'essential-eight'
const ROOT = process.cwd()
const REGISTER = 'tools/essential-eight.json'

// --- the register --------------------------------------------------------------------
const path = join(ROOT, REGISTER)
if (!existsSync(path)) {
  failures(
    GATE,
    [
      `${REGISTER} is missing — it is the reviewed conformance register this gate judges. Pull the seeded exemplar with \`npx next-expo-supabase-agent-harness update --refresh-seeded ${REGISTER}\`.`,
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

// Anti-vacuity, in the shape check-secrets.mjs and check-obligations.mjs already use: a
// register that scans nothing must FAIL, never pass quietly. An empty conformance map
// reads as "everything is fine" to exactly the reader it would mislead.
if (!Array.isArray(register.requirements) || register.requirements.length === 0) {
  failures(
    GATE,
    [
      `${REGISTER} declares no requirements. An empty conformance register is not a clean bill of health — it is a missing one.`,
    ],
    null,
  )
}

// --- what actually runs here ----------------------------------------------------------
const controls = liveControls({
  steps: [...VALIDATE_STEPS, ...STOP_HOOK_STEPS].map(([name]) => name),
  workflowDir: join(ROOT, '.github', 'workflows'),
})

// --- the negative-proof evidence the tree can decide ------------------------------------
const configPath = join(ROOT, 'supabase', 'config.toml')
const configToml = existsSync(configPath) ? readFileSync(configPath, 'utf8') : ''

// A route handler or Server Action that accepts multipart/form-data or reads a File is the
// shape of an upload surface. Deliberately narrow: the macro rows rest on there being NO
// document-parsing surface, and a false positive here would push eleven honest grades into
// churn. The reviewer owns the rest.
// BOTH surfaces, deliberately. The eleven `Restrict Microsoft Office macros` rows are
// graded not-applicable on the ground that this system has no document-parsing surface,
// and a MOBILE file-picker upload invalidates that claim exactly as a web route handler
// would. Scanning only the web half would have made the negative proof true of half the
// product and asserted of all of it — the shape docs/harness/enforcement-tiers.md exists
// to stop, and the reason this gate owes no tier row.
const UPLOAD_RE =
  /multipart\/form-data|\.formData\(\)[\s\S]{0,200}\bFile\b|new\s+Blob\(|createReadStream\(|DocumentPicker|expo-document-picker/
const uploadRoutes = []
for (const dir of [
  'apps/web/app',
  'apps/mobile/src',
  'apps/mobile/app',
  'packages/api/src',
  'supabase/functions',
]) {
  const abs = join(ROOT, dir)
  if (!existsSync(abs)) continue
  const files = walkFiles(abs, {
    excludeDirs: new Set(['node_modules', '.next', 'dist', 'generated']),
    filter: (p) => /\.tsx?$/.test(p) && !/\.(test|spec)\.tsx?$/.test(p),
  })
  for (const rel of files) {
    if (UPLOAD_RE.test(readFileSync(join(abs, rel), 'utf8'))) uploadRoutes.push(`${dir}/${rel}`)
  }
}

// --- judge ------------------------------------------------------------------------------
const problems = [
  ...censusProblems(register),
  ...supersessionProblems(register),
  ...rowProblems(register, controls),
  ...sharedClauseProblems(register),
  ...negativeProofProblems({ configToml, uploadRoutes }),
]

failures(
  GATE,
  problems,
  `Each finding is a CLAIM defect, not a security defect. Grade conservatively: 'effective' needs a live control whose subject IS the requirement, absence of a surface is never a control, and an artefact already claimed by another row is not claimed again. ${REGISTER} is git-clean-enforced by check-gate-integrity.mjs, so every regrade lands in a PR diff where somebody can see it.`,
)

const s = summarise(register)
ok(
  GATE,
  `${String(s.total)} ML3 requirement(s): ${String(s.effective)} effective, ${String(s.alternateControl)} alternate-control, ${String(s.notImplemented)} not-implemented (${String(s.obligations.length)} obligation(s)), ${String(s.notApplicable)} not-applicable, ${String(s.organisation)} organisation-boundary; ${String(s.sharedClauses)} shared clause(s), each artefact claimed once. This register does NOT claim the application is Maturity Level Three — see ${REGISTER} header.`,
)
