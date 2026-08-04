#!/usr/bin/env node
// Gate: prompts — every instruction the models read is a hash-locked artifact. Two
// surfaces, locked for the same reason and judged with different strictness.
//
//   1. LLM PROMPTS (tools/prompts.lock.json) — versioned in the filename and hashed. A
//      changed prompt with no lock update silently changes model behaviour with no eval
//      trail; an unlocked prompt file is an unversioned production input.
//
//   2. THE AGENT SURFACE (tools/agents.lock.json) — `.claude/{agents,commands,skills}`,
//      hashed by tools/gen-agents-lock.mjs, plus each agent's pinned model. This is the
//      prose the CODING AGENT runs under: which reviewers exist, what they may touch,
//      what a slash command does. Before the lock, nothing in the chain noticed it
//      changing — `docs-sync` reads reviewer FRONTMATTER (tools, model, name) and never
//      the body, which is where the instructions actually are. An agent could soften
//      security-reviewer.md, widen a skill, or repoint a command, and stay green.
//
// THE ASYMMETRY ON SURFACE 2, and it is the whole design. "This file is not in the lock"
// is RAMPED: an install that predates the lock has files nobody has covered yet, and
// ambushing it on upgrade would be the harness breaking its own promise that projects
// grow into gates. "This file IS in the lock and its hash moved" is UNRAMPED at every
// vintage — a mismatch is not a vintage gap, it is an edit to instructions somebody
// already reviewed. The 0.2.0 installer migration writes the lock from the install's own
// current files, so in practice existing installs convert fully-locked with zero drift.
// SOURCE: docs/harness/README.md (prompt versioning) [corpus: llamacpp/json-schema]
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { AGENT_SURFACE } from './lib/agent-surface.mjs'
import { walkFiles } from './lib/fs-walk.mjs'
import { fail, failures, ok, rampNote } from './lib/gate.mjs'

const GATE = 'prompts'
const LOCK = 'tools/prompts.lock.json'
const AGENTS_LOCK = 'tools/agents.lock.json'
const AGENTS_RAMP = '0.2.0'

let lock = {}
if (existsSync(LOCK)) {
  try {
    lock = JSON.parse(readFileSync(LOCK, 'utf8'))
  } catch (e) {
    fail(GATE, `${LOCK} is not valid JSON: ${e.message}`)
  }
}

// Discover prompt files: packages/*/prompts/** and apps/*/prompts/**. Lock keys
// are POSIX paths by contract — the shared walker's output already is.
const promptFiles = []
for (const scope of ['packages', 'apps']) {
  if (!existsSync(scope)) continue
  for (const pkg of readdirSync(scope).sort()) {
    const root = `${scope}/${pkg}/prompts`
    promptFiles.push(...walkFiles(root).map((rel) => `${root}/${rel}`))
  }
}

const errs = []
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

for (const f of promptFiles) {
  if (!(f in lock)) {
    errs.push(`${f} is not in ${LOCK} — every prompt must be hash-locked (add it deliberately)`)
    continue
  }
  const actual = sha256(f)
  if (actual !== lock[f]) {
    errs.push(
      `${f} hash mismatch — the prompt changed without a lock update. Version the change (new .vN file), re-run the eval, then update the lock.`,
    )
  }
  if (!/\.v\d+\.[a-z]+$/.test(f)) {
    errs.push(`${f} must carry an explicit version in its filename (e.g. extract.v1.md)`)
  }
}
for (const locked of Object.keys(lock)) {
  if (!existsSync(locked)) errs.push(`${LOCK} references missing file ${locked}`)
}

// ---- 2. the agent surface ------------------------------------------------------
// Absent lock file + a live agent surface is the ADOPTION case, not tampering: report
// it as a ramped NOTE and let the installer migration plant the lock. A corrupt lock is
// tampering at any vintage — it is write-guard-protected, so it does not get malformed
// by accident.
let agentsLock = null
if (existsSync(AGENTS_LOCK)) {
  try {
    agentsLock = JSON.parse(readFileSync(AGENTS_LOCK, 'utf8'))
  } catch (e) {
    fail(
      GATE,
      `${AGENTS_LOCK} is not valid JSON (${e.message}) — it is write-guard-protected, so an unparseable agent lock is tampering; restore it from git history`,
    )
  }
  if (agentsLock.files === undefined || typeof agentsLock.files !== 'object') {
    fail(
      GATE,
      `${AGENTS_LOCK} has no "files" object — regenerate it with tools/gen-agents-lock.mjs`,
    )
  }
}

const surfaceFiles = []
for (const root of AGENT_SURFACE) {
  surfaceFiles.push(...walkFiles(root).map((rel) => `${root}/${rel}`))
}

// Coverage findings ramp; mismatches never do. Held in separate lists so the ramp cannot
// accidentally swallow the half that matters.
const coverageErrs = []
let agentsChecked = 0
if (surfaceFiles.length > 0) {
  const locked = agentsLock?.files ?? {}
  for (const f of surfaceFiles) {
    if (!(f in locked)) {
      coverageErrs.push(
        `${f} is not in ${AGENTS_LOCK} — every file the coding agent takes instructions from must be hash-locked. Regenerate deliberately: \`HARNESS_ALLOW_SELF_EDIT=1 node tools/gen-agents-lock.mjs --write\``,
      )
      continue
    }
    agentsChecked += 1
    if (sha256(f) !== locked[f]) {
      errs.push(
        `${f} hash mismatch — the instructions the coding agent runs under changed without a lock update. This is not a vintage gap: the file was already covered. Review the diff, then update the lock deliberately (\`HARNESS_ALLOW_SELF_EDIT=1 node tools/gen-agents-lock.mjs --write\`).`,
      )
    }
  }
  for (const f of Object.keys(locked)) {
    if (!existsSync(f)) {
      errs.push(
        `${AGENTS_LOCK} references missing file ${f} — a locked reviewer, command or skill was DELETED. Removing an agent is a reviewed act, not a cleanup.`,
      )
    }
  }
}

if (coverageErrs.length > 0) {
  if (
    rampNote(GATE, AGENTS_RAMP, 'agent-surface lock coverage (.claude/{agents,commands,skills})')
  ) {
    for (const e of coverageErrs) console.log(`${GATE}: NOTE — (ramp) ${e}`)
  } else {
    errs.push(...coverageErrs)
  }
}

failures(GATE, errs)
ok(
  GATE,
  `${String(promptFiles.length)} prompt(s) hash-locked and versioned; ${String(agentsChecked)}/${String(surfaceFiles.length)} agent-surface file(s) hash-locked`,
)
