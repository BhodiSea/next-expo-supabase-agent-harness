// Writing tools/agents.lock.json at install time, from the INSTALL's own rendered files.
//
// WHY IT CANNOT SHIP IN THE TEMPLATE. Two roster files carry `{{...}}` placeholders, so
// the bytes on disk in an install are not the bytes in template/. A lock generated in the
// template would therefore mismatch in every scaffold on the very first `validate` — the
// gate would red on a tree nobody had touched, which is the worst possible first
// impression for a control whose entire message is "a mismatch means somebody edited your
// instructions".
//
// WHY IT CANNOT BE LEFT TO THE CONSUMER EITHER. A fresh scaffold's manifest records the
// release it was built from, so the coverage ramp is NOT active on it (the ramp protects
// pre-existing content from a new check; a fresh install has no legacy). Shipping no lock
// would hard-fail `prompts` on a clean scaffold. The install is the only moment at which
// the correct lock is both computable and unambiguous.
//
// It runs the SHIPPED generator as a subprocess rather than reimplementing the hash here.
// A second implementation of "what the lock should contain" is a second thing to keep in
// step, and the day they disagree the gate is judging one and the human is reading the
// other. This also means `init` exercises the generator on every run.
// SOURCE: docs/harness/README.md (prompt/agent lock discipline) [corpus: harness/doctrine]
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const AGENTS_LOCK = 'tools/agents.lock.json'
const GENERATOR = 'tools/gen-agents-lock.mjs'

/**
 * Write (or refresh) the agent-surface lock in `targetDir`.
 *
 * `mode: 'always'` (init) writes unconditionally. `mode: 'adopt'` (update) writes ONLY
 * when the install has no lock yet — that is the 0.2.0 adoption path, and it is what lets
 * an existing install convert to fully-locked with zero drift and no ramp at all. An
 * update must never REWRITE an existing lock: doing so would launder every edit made
 * since the last one, which is the exact act the lock exists to make visible.
 *
 * Returns true when a lock was written. A dry run always returns false and writes nothing.
 */
export function writeAgentsLock(targetDir, report, mode, { dryRun = false } = {}) {
  const generator = join(targetDir, GENERATOR)
  const lock = join(targetDir, AGENTS_LOCK)
  // The dry-run gate lives HERE rather than at the two call sites: init() and update()
  // are both on the complexity ratchet, and a one-line `if` at each of them is a real
  // (if small) growth in the two functions the harness holds itself hardest to.
  if (dryRun || !existsSync(generator)) return false
  if (mode === 'adopt' && existsSync(lock)) return false

  const run = spawnSync(process.execPath, [GENERATOR, '--write'], {
    cwd: targetDir,
    encoding: 'utf8',
    // The generator refuses to write without this: updating a hash of the files it
    // protects is a human-in-the-loop act everywhere EXCEPT here, where the human is
    // the person running the installer and the files were just planted by it.
    env: { ...process.env, HARNESS_ALLOW_SELF_EDIT: '1' },
  })
  if (run.status !== 0) {
    report.notes.push(
      `${AGENTS_LOCK}: could not be generated (${(run.stderr ?? '').trim() || 'unknown error'}) — run \`HARNESS_ALLOW_SELF_EDIT=1 node ${GENERATOR} --write\` before the first validate`,
    )
    return false
  }
  report.notes.push(
    `${AGENTS_LOCK}: written from this install's own .claude/{agents,commands,skills} — the \`prompts\` gate now reds on any later edit to them`,
  )
  return true
}
