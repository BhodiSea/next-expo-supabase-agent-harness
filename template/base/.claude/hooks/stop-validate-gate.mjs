#!/usr/bin/env node
// Stop hook — the unbreakable gate. Runs the full validate gate and exits 2 with errors
// on stderr until green, so the turn cannot end on a red build. Loop-guarded by
// stop_hook_active; bounded by CLAUDE_CODE_STOP_HOOK_BLOCK_CAP (settings env).
// SOURCE: docs/harness/README.md (stop-validate-gate)
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { readHookInput } from './lib/hookio.mjs'
import { TURN_LOG, capHitBlockEligible, recordTurnOutcome } from './lib/turn-outcomes.mjs'

export const HARNESS_HOOK_VERSION = '1.0.1'

const input = await readHookInput()
const looping = input?.stop_hook_active === true

// ---- BOUNDED OUTPUT WITH SPILL-TO-FILE (0.10.0) ----------------------------------------
//
// WHAT WAS LOST, AND WHEN IT MATTERED MOST. Each failure was reported as `out.slice(-4000)`
// — the TAIL. For most gates that is the right 4000 characters, because the summary is last.
// For the ones that enumerate (a type error list, a lint run, a chain that fails several
// steps) the HEAD is the finding and the tail is the count, so the agent read "42 problems"
// and never saw the first one. Nothing recovered it: the child's output existed only inside
// this catch, and the turn ended.
//
// It becomes acute in exactly this release. An install upgrading to 0.10.0 can meet SIX
// expired ramps at once, and `validate.mjs` is fail-fast, so a human meets them one per run
// — but the Stop chain runs its steps to completion and an agent driving it sees the flood
// in a single block, six tails deep, with the block budget draining.
//
// So the full output is written to a per-run file and the message carries a bounded tail
// PLUS the path. `.harness/` is already gitignored and is already how every gate, the ramp
// reader and the reviewer ledger reach run state; the filename is per (run, gate) so six
// simultaneous failures produce six readable files rather than one interleaved one.
//
// FAILS SOFT, DELIBERATELY. If the spill cannot be written — a read-only checkout, a full
// disk — the tail is still returned and the turn still blocks. Bookkeeping never decides a
// turn, and a hook that threw while reporting a failure would convert a red gate into a
// crashed hook, which is strictly worse than the truncation it replaced.
const SPILL_DIR = '.harness/stop-output'
const TAIL = 2000
const HEAD = 1000
/** @param {string} name @param {string} out @returns {string} */
function spill(name, out) {
  if (out.length <= HEAD + TAIL) return out
  const slug = name.replace(/[^a-z0-9-]/gi, '-')
  const path = `${SPILL_DIR}/${slug}.log`
  let written = false
  try {
    mkdirSync(SPILL_DIR, { recursive: true })
    writeFileSync(path, out)
    written = true
  } catch {
    // fall through: the tail below is still the message
  }
  const omitted = out.length - HEAD - TAIL
  return written
    ? `${out.slice(0, HEAD)}\n\n… ${String(omitted)} characters omitted — FULL OUTPUT: ${path} …\n\n${out.slice(-TAIL)}`
    : `${out.slice(0, HEAD)}\n\n… ${String(omitted)} characters omitted (the spill file could not be written) …\n\n${out.slice(-TAIL)}`
}

// Gate steps live in the project's harness config (tools/harness.config.mjs exports
// STOP_HOOK_STEPS: Array<[name, command]>), so projects extend the gate — e.g. add a
// perf-budget check — without editing this hook (which is itself a harness-protected
// file). Resolved relative to this hook: ../../ is the project root.
//
// If the config cannot be loaded, the fallback is the HARDCODED direct-invocation
// list — NEVER `pnpm validate`: package.json is not write-guard-protected, so a
// script-name fallback would be exactly the script-indirection tamper hole the
// config documents. A broken config additionally BLOCKS the turn even when the
// fallback chain is green — the config is write-guard-protected, so a human must
// restore it; an agent must not keep working on top of a mangled gate.
// SOURCE: docs/harness/README.md (stop-validate-gate; tamper evidence)
const FALLBACK_STEPS = [
  ['validate', 'node tools/validate.mjs --report-all'],
  ['rls-isolation', 'node tests/rls/run-rls.mjs'],
  ['unit', 'pnpm exec vitest run --coverage --silent'],
  ['mobile-unit', 'pnpm --filter mobile exec jest --coverage --silent'],
]
let STEPS = FALLBACK_STEPS
let configBroken = null
try {
  const { STOP_HOOK_STEPS } = await import(
    new URL('../../tools/harness.config.mjs', import.meta.url).href
  )
  if (Array.isArray(STOP_HOOK_STEPS) && STOP_HOOK_STEPS.length > 0) {
    STEPS = STOP_HOOK_STEPS
  } else {
    configBroken = 'tools/harness.config.mjs did not export a non-empty STOP_HOOK_STEPS array'
  }
} catch (e) {
  configBroken = `could not load tools/harness.config.mjs (${e?.message ?? e})`
}

// ---- THE FROZEN FLOOR (0.3.0): the chain is a UNION, not a copy ----------------
// harness.config.mjs is manifest mode `config` and check-gate-integrity skips non-`owned`
// entries, so until 0.3.0 NOTHING hashed STOP_HOOK_STEPS: deleting `test-quality` or
// `diff-coverage` from the array mid-turn ended the turn green, with gate-integrity
// reporting OK because a `config` file is human-tunable by design.
//
// tools/stop.floor.json is the frozen snapshot. A step in the floor but missing from the
// config STILL RUNS. Projects may APPEND (a project-specific check is legitimate and this
// preserves it); they may not subtract.
//
// A missing or corrupt floor is a loud NOTE on stderr and the config chain runs alone —
// NOT a blocked turn. That is the deliberate trade: a corrupt floor bricking every turn on
// the machine is a worse failure than a turn whose floor could not be read, and the file
// is inside gate-integrity's hashed surface and the write-guard table, so the tamper is
// evidenced on the very next validate rather than depending on this hook to notice.
let floorNote = null
let injected = []
try {
  // ONE implementation of the union (0.7.0): the same lib `validate --stop-chain`
  // resolves with, so a runner outside a live turn can never disagree with this hook
  // about what the chain is. Imported dynamically so a missing or mangled lib degrades
  // exactly like an unreadable floor — a loud NOTE and the config chain alone, never a
  // bricked turn. The lib lives under tools/lib, inside gate-integrity's hashed surface
  // and the write-guard table like the floor itself, so the tamper is evidenced on the
  // very next validate rather than depending on this hook to notice.
  const { loadStopChain } = await import(
    new URL('../../tools/lib/stop-chain.mjs', import.meta.url).href
  )
  const union = loadStopChain(STEPS, new URL('../../tools/stop.floor.json', import.meta.url))
  // Floor order first, then the config's own steps: a floor step that a weakened config
  // dropped must run where the floor puts it, and appended project steps stay last.
  STEPS = union.steps
  injected = union.injected
  floorNote = union.floorNote
} catch (e) {
  floorNote = `could not load tools/lib/stop-chain.mjs (${e?.message ?? e}) — the floor union could not be computed`
}

const failures = []
const failedGates = []
const skips = []
for (const [name, cmd] of STEPS) {
  try {
    // 64 MB: bundler export output + tsc diagnostics + docker compose logs can
    // exceed the 1 MB default and make execSync throw ENOBUFS on an otherwise-green
    // step (false FAIL). HARNESS_STOP_GATE=1 tells fail-closed-capable runners
    // (tests/rls/run-rls.mjs) that THIS run is the proof — a skip is not acceptable.
    const out = execSync(cmd, {
      // THE TURN'S IDENTITY, passed down (0.6.0). tools/check-reviewer-verdicts.mjs narrows
      // the reviewer ledger to THIS turn, and without the prompt_id an earlier turn's PASS
      // would satisfy an obligation raised by this one — the one failure mode that would
      // make that whole control decorative. `session_id` and `prompt_id` are observed fields
      // of the Stop payload; see design/CONTROL-PLANE-FACTS.md.
      env: {
        ...process.env,
        HARNESS_STOP_GATE: '1',
        ...(typeof input?.session_id === 'string' ? { HARNESS_SESSION_ID: input.session_id } : {}),
        ...(typeof input?.prompt_id === 'string' ? { HARNESS_PROMPT_ID: input.prompt_id } : {}),
      },
      maxBuffer: 64 * 1024 * 1024,
      stdio: 'pipe',
    })
    for (const line of out.toString().split('\n')) {
      if (/\bSKIPPED\b/.test(line)) skips.push(`[${name}] ${line.trim()}`)
    }
  } catch (e) {
    const out = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '')
    failures.push(`### ${name} FAILED (${cmd})\n${spill(name, out)}`)
    failedGates.push(name)
  }
}

if (configBroken) {
  failures.push(
    `### gate-config BROKEN\n${configBroken}\nThe fallback chain ran (direct invocation), but the turn is blocked until tools/harness.config.mjs is restored — it is write-guard-protected, so restore it from git (a human sets HARNESS_ALLOW_SELF_EDIT=1 if needed).`,
  )
}

// Floor evidence, on every run: a chain that had to be topped up from the floor, or a
// floor that could not be read, is a fact about THIS turn and belongs in the transcript
// whether the turn is green or red.
const notes = []
if (injected.length > 0) {
  notes.push(
    `stop-validate-gate: ${String(injected.length)} floor step(s) were MISSING from tools/harness.config.mjs and were run from tools/stop.floor.json anyway: ${injected.map(([n]) => n).join(', ')}. Restore them in the config — the floor is not a place to park a deleted check.`,
  )
}
if (floorNote) {
  notes.push(
    `stop-validate-gate: ${floorNote} — the config chain ran alone this turn. The floor is write-guard-protected and inside gate-integrity's hashed surface, so restore it from git; the next validate will red on it regardless.`,
  )
}
// ---- THE TURN LEDGER (0.6.0): the one documented way a turn CAN end red ----------
// `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` (default 8) is the safety valve that stops a red gate
// looping forever — after N CONSECUTIVE blocks Claude Code ends the turn anyway. It is the
// right valve and it stays; a hook that can block forever is a bricked machine. What was
// missing is the MARK. Through 0.5.0 a turn that ran out of blocks and ended with the gate red
// left exactly the trace a green turn leaves: none. The harness's headline claim is "a turn
// cannot end on a red build", and this is the one documented way it can.
//
// So: every outcome is appended to .harness/turn-outcomes.jsonl, the LAST block a turn is
// allowed says so while the transcript can still act on it, and the next turn's gate reports a
// predecessor that ended at the cap even when the tree is green again by then.
// SOURCE: https://code.claude.com/docs/en/env-vars (CLAUDE_CODE_STOP_HOOK_BLOCK_CAP)
//
// The ledger path is CWD-RELATIVE, unlike the config and floor above, and the split is a rule
// rather than an oversight: harness CODE is resolved from this hook's own location (a hook must
// not let a stray cwd pick which gate config it enforces), while everything under `.harness/`
// is cwd-relative because that is how every gate, `gate.mjs`'s ramp reader, and the sibling
// reviewer ledger already reach it. One exception here would be the inconsistency.
const turn = recordTurnOutcome({
  blocked: failures.length > 0,
  gates: failedGates,
  input,
  ledgerPath: TURN_LOG,
})

// ---- THE ONE-TIME BLOCK (0.7.0): the cap-ended mark costs the next green turn one block --
// 0.6.0 recorded the one documented way a turn CAN end red; the record surfaced as a NOTE,
// and a note on a green run is exactly the line nobody acts on. So a mark carrying `v` —
// written by a 0.7.0+ hook; 0.6.0-written state has none and stays a NOTE, which is why this
// tightening ships rampless — converts the note into ONE exit 2 when the chain is otherwise
// green: the agent must state which gates the previous turn abandoned red before this turn
// may end. Exactly once, by construction: this run's own ledger append has already moved the
// tail, so the next Stop passes — the append IS the acknowledgment, the same no-second-state
// trick priorCapHit itself documents. A RED chain is unchanged (the reds already block; the
// mark stays a note so the message stays about them). A ledger that could not be READ
// degrades to no-mark upstream, and one that could not be WRITTEN (turn.error) must not
// block either — the tail never moved, so the block would repeat every Stop, and bookkeeping
// never decides a turn.
const capBlock =
  failures.length === 0 && turn.error === null && capHitBlockEligible(turn.priorCapHit)
if (turn.priorCapHit !== null && !capBlock) {
  const prior = turn.priorCapHit
  notes.push(
    `stop-validate-gate: THE PREVIOUS TURN ENDED RED. It was blocked ${String(prior.blocks)} time(s) — its CLAUDE_CODE_STOP_HOOK_BLOCK_CAP — so Claude Code ended it anyway with ${prior.gates?.length > 0 ? prior.gates.join(', ') : 'the gate'} still failing. That is the documented safety valve working, not a bug; it does mean work stopped on a red build, so treat those gates as outstanding rather than as history.`,
  )
}
if (turn.capSource === 'unparseable') {
  notes.push(
    `stop-validate-gate: CLAUDE_CODE_STOP_HOOK_BLOCK_CAP is set to an unusable value (${String(process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP)}), so Claude Code's default of 8 applies. A typo'd cap that silently reverts is exactly the kind of quiet posture change this harness exists to make loud — fix the value or remove the key.`,
  )
}
if (turn.error !== null) {
  notes.push(
    `stop-validate-gate: ${turn.error}. The gate result below stands — bookkeeping never decides a turn — but a turn that ends at the block cap will leave no record until this is fixed.`,
  )
}
// The advisory turn lock (0.9.0): two live sessions in one working tree is a state worth
// naming out loud — their diffs interleave and their gate verdicts judge each other's
// half-finished edits — and never a reason to block a turn. The ledger itself is
// session-scoped, so cap arithmetic stays correct either way; `installer update` is the
// one consumer that refuses to run while the lock is fresh.
if (turn.concurrentSession !== null) {
  notes.push(
    `stop-validate-gate: ${turn.concurrentSession} — another live session appears to share this working tree. Advisory only: finish one session before the other, or expect the two to judge each other's half-finished edits.`,
  )
}

if (notes.length > 0) process.stderr.write(`${notes.join('\n')}\n`)

if (failures.length === 0) {
  if (capBlock) {
    const prior = turn.priorCapHit
    const gates = prior.gates?.length > 0 ? prior.gates.join(', ') : 'the gate'
    process.stderr.write(
      `stop-validate-gate: THE PREVIOUS TURN ENDED RED. It was blocked ${String(prior.blocks)} time(s) — its CLAUDE_CODE_STOP_HOOK_BLOCK_CAP — so Claude Code ended it anyway with ${gates} still failing. The chain is green NOW, which is exactly when that fact would otherwise vanish. ONE-TIME BLOCK: state plainly in the transcript which gates that turn abandoned red (${gates}) and whether this turn's green chain settles them or work is still outstanding, then end the turn again. This run's own ledger append has already moved the mark, so the next Stop passes.\n`,
    )
    process.exit(2)
  }
  // Green — but never let a loud skip masquerade as silence: surface any
  // skipped layers so the transcript records what did NOT run.
  if (skips.length > 0) {
    process.stderr.write(`stop-validate-gate: green with skipped layers:\n${skips.join('\n')}\n`)
  }
  process.exit(0)
}

// THE LAST BLOCK GETS ITS OWN HEADER. `capReached` means Claude Code will not honour another
// one: the next Stop ends the turn whatever this gate says. Saying so here is the only moment
// anything can still act on it — after that the turn is over and only the ledger remembers.
const header = turn.capReached
  ? `LAST CHANCE — this is block ${String(turn.blocks)} of ${String(turn.cap)} (CLAUDE_CODE_STOP_HOOK_BLOCK_CAP). Claude Code will NOT block again: the next time this turn tries to end, it ends, red build and all. Fix the failures below now, or stop and say plainly that the gate is still red and which gates — an unannounced red turn is the one failure this harness cannot see.\n\n`
  : looping
    ? `The validate gate is STILL red after a prior continuation (block ${String(turn.blocks)}${turn.cap === null ? '' : ` of ${String(turn.cap)}`}). Fix the root cause below; do not stop until \`pnpm validate\` is green.\n\n`
    : 'Done means GREEN GATE. The turn cannot end with a red build. Fix every failure below, then the gate re-runs automatically.\n\n'
const skipNote = skips.length > 0 ? `\n\nSkipped layers (did NOT run):\n${skips.join('\n')}\n` : ''
process.stderr.write(header + failures.join('\n\n') + skipNote)
process.exit(2)
