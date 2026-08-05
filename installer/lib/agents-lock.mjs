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
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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

/**
 * Re-record the lock entries for agent-surface files THIS UPDATE rewrote — and only those.
 *
 * THE GAP THIS CLOSES, found by the upgrade lane rather than by reading the plan. The
 * `adopt` rule above is right about consumer edits and wrong about harness ones: when an
 * `update` overwrites an OWNED agent-surface file (the 0.3.0 doctrine repair rewrote ten
 * of them), the lock still describes the old bytes, so `prompts` reds on every consumer
 * for a change they did not make, cannot review, and can only clear by running the very
 * generator the guards exist to keep them from running.
 *
 * PER-ENTRY, never wholesale. A file is re-recorded only if `update` actually wrote it,
 * which it does only when the on-disk bytes matched the recorded sha — i.e. the consumer
 * had not touched it. A locally-modified agent file drifts, gets parked, is NOT in
 * `written`, and therefore keeps redding: that edit is exactly what the lock exists to
 * surface, and laundering it here would be the failure this whole control is about.
 *
 * @param {string} targetDir
 * @param {string[]} written install paths this update wrote
 * @param {{ notes: string[] }} report
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {number} how many entries were re-recorded
 */
export function refreshAgentsLockEntries(targetDir, written, report, { dryRun = false } = {}) {
  const lockPath = join(targetDir, AGENTS_LOCK)
  const touched = written.filter((p) => /^\.claude\/(agents|commands|skills)\//.test(p))
  if (dryRun || touched.length === 0 || !existsSync(lockPath)) return 0

  const lock = readLock(lockPath)
  if (lock === null) return 0

  let count = 0
  for (const rel of touched) {
    const abs = join(targetDir, rel)
    if (!existsSync(abs)) continue
    const bytes = readFileSync(abs)
    lock.files[rel] = createHash('sha256').update(bytes).digest('hex')
    // The model pin travels with the file: a roster entry repointed from a frontier model
    // to a cheap one leaves every byte of the instructions identical, which is why it is
    // locked alongside the hash rather than instead of it.
    recordModelPin(lock, rel, bytes)
    count += 1
  }
  if (count === 0) return 0

  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`)
  report.notes.push(
    `${AGENTS_LOCK}: re-recorded ${String(count)} entr${count === 1 ? 'y' : 'ies'} for agent-surface file(s) THIS update rewrote. Locally-modified agent files were parked, not re-recorded — their lock mismatch is the edit the lock exists to show you.`,
  )
  return count
}

/** The lock as an object with a usable `files` map, or null when it is unusable. */
function readLock(lockPath) {
  let lock
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch {
    // A corrupt lock is the `prompts` gate's finding to report, not this function's to fix.
    return null
  }
  return typeof lock?.files === 'object' && lock.files !== null ? lock : null
}

/** Update `lock.models[<agent>]` from a roster file's frontmatter, when both are present. */
function recordModelPin(lock, rel, bytes) {
  const agent = /^\.claude\/agents\/(.+)\.md$/.exec(rel)?.[1]
  if (agent === undefined || typeof lock.models !== 'object' || lock.models === null) return
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(bytes.toString('utf8'))?.[1]
  const model = frontmatter === undefined ? undefined : /^model:\s*(.+)$/m.exec(frontmatter)?.[1]
  if (model !== undefined) lock.models[agent] = model.trim()
}
