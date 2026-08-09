// The ONE implementation of the Stop-chain union (0.7.0).
//
// tools/stop.floor.json is the frozen snapshot of the canonical STOP_HOOK_STEPS; the live
// chain is the UNION of that floor and the config's own array — a step in the floor but
// missing from the config STILL RUNS, so a project may APPEND a step and may never
// subtract one (see the floor file's own header, and the 0.3.0 story it records).
//
// Until 0.7.0 that union existed only inline in .claude/hooks/stop-validate-gate.mjs,
// which meant nothing could resolve the Stop chain OUTSIDE a live turn: no runner, no CI
// baseline, no budget judge could ask "what would the hook run?" without re-implementing
// the answer. This module is the extraction — the hook imports it, and so does
// `node tools/validate.mjs --stop-chain` — so the two callers can never disagree about
// what the union IS.
//
// POSTURE IS THE CALLER'S, deliberately. `loadStopChain` never throws: a missing or
// corrupt floor comes back as `floorNote` with the config steps untouched, because the
// Stop hook's documented trade is fail-open-with-NOTE (a corrupt floor bricking every
// turn on the machine is a worse failure than a turn whose floor could not be read — the
// file is inside gate-integrity's hashed surface and the write-guard table, so the tamper
// is evidenced on the very next validate). `validate --stop-chain` reads the same result
// and FAILS CLOSED instead: a runner asked to PROVE the chain must never quietly prove a
// weakened one. Same facts, opposite consequences, one implementation.
// SOURCE: docs/harness/README.md (the CI floor; tamper evidence) [corpus: harness/doctrine]
import { readFileSync } from 'node:fs'

/**
 * Floor-first union of the frozen floor and the live config — the exact semantics the
 * Stop hook has applied since 0.3.0, byte for byte:
 *   - `injected` is every floor step the config no longer names;
 *   - with nothing injected the CONFIG ARRAY IS RETURNED AS IS (identity, no reorder) —
 *     a correct config runs untouched, in its own order;
 *   - with injections the floor runs first, in floor order (a step a weakened config
 *     dropped must run where the floor puts it), and appended project steps stay last.
 * @param {string[][]} configSteps the live STOP_HOOK_STEPS
 * @param {string[][]} floorSteps  the frozen floor's steps
 * @returns {{ steps: string[][], injected: string[][] }}
 */
export function unionSteps(configSteps, floorSteps) {
  const present = new Set(configSteps.map(([name]) => name))
  const injected = floorSteps.filter(([name]) => !present.has(name))
  if (injected.length === 0) return { steps: configSteps, injected }
  return {
    steps: [...floorSteps, ...configSteps.filter(([n]) => !floorSteps.some(([f]) => f === n))],
    injected,
  }
}

/**
 * Read the floor at `floorUrl`, validate its shape, and union it with `configSteps`.
 * Never throws — an unreadable or malformed floor degrades to the config steps plus a
 * `floorNote` naming what went wrong, and the caller chooses the consequence (the hook
 * notes it and runs on; `validate --stop-chain` fails closed).
 * @param {string[][]} configSteps the live STOP_HOOK_STEPS
 * @param {URL | string} floorUrl          where tools/stop.floor.json lives for this caller
 * @returns {{ steps: string[][], injected: string[][], floorNote: string | null }}
 */
export function loadStopChain(configSteps, floorUrl) {
  try {
    const floor = JSON.parse(readFileSync(floorUrl, 'utf8'))?.steps
    const wellFormed =
      Array.isArray(floor) &&
      floor.length > 0 &&
      floor.every((s) => Array.isArray(s) && typeof s[0] === 'string' && typeof s[1] === 'string')
    if (!wellFormed) {
      return {
        steps: configSteps,
        injected: [],
        floorNote: 'tools/stop.floor.json has no well-formed `steps` array',
      }
    }
    return { ...unionSteps(configSteps, floor), floorNote: null }
  } catch (e) {
    return {
      steps: configSteps,
      injected: [],
      floorNote: `could not read tools/stop.floor.json (${e?.message ?? e})`,
    }
  }
}
