// `apply-proposal [<id>] [--dir .] [--dry-run]` (1.1.0, #65): a human applies, in one
// reviewed action, the whole-file register edit an agent staged under harness-proposals/.
//
// With no id it lists the pending proposals. With an id it validates the proposal, prints its
// reason and a `git diff --no-index` of the current file against the proposed one, asks the
// human to type the target path, writes the file, deletes the proposal and prints
// `commit <target>`. `--dry-run` prints the same and writes nothing. There is no `--yes`.
//
// Two layers keep it human-only, and both are tripwires in the guard's own sense: stdin and
// stdout must be terminals, and the bash guard's `apply-proposal-invocation` rule denies an
// agent the invocation. What makes a stale or clobbering apply impossible is not a tripwire:
// `base` must equal `git rev-parse HEAD:<target>` and the target must be clean, checked
// before the diff and again after the prompt, so replacing the whole file cannot silently
// revert a row committed after the proposal was staged. The written register is left
// uncommitted, so gate-integrity's commit-not-dirty rule reds until a human commits it.
// SOURCE: docs/harness/README.md (tamper evidence; proposing a register edit)
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import readline from 'node:readline/promises'
import {
  PROPOSABLE,
  PROPOSAL_ID,
  PROPOSALS_DIR,
  isInside,
  landingPath,
  parseProposal,
  proposalLines,
  readText,
  unsafeForTerminal,
} from '../lib/proposals.mjs'
import { writeInstallFile } from '../lib/write-file.mjs'

// A refusal is an expected outcome with its own message and exit 1, never a crash.
class Refusal extends Error {}
/** @param {string} message @returns {never} */
function refuse(message) {
  throw new Refusal(message)
}

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error) refuse(`git could not run (${r.error.message}), and base and the uncommitted-changes check need it`)
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** @param {string} dir */
function list(dir) {
  const lines = proposalLines(dir)
  if (lines.length === 0) {
    console.log(`apply-proposal: no pending proposals in ${PROPOSALS_DIR}/`)
    return 0
  }
  console.log(`apply-proposal: pending proposals in ${PROPOSALS_DIR}/:`)
  for (const line of lines) console.log(`  ${line}`)
  return 0
}

/** @param {{ stdin: boolean, stdout: boolean }} tty */
function requireTerminal(tty) {
  const how = 'applying a proposal is a human act: run the command yourself, in a terminal, and type the target path when asked'
  if (!tty.stdin) refuse(`stdin is not a terminal, and ${how}`)
  if (!tty.stdout) refuse(`stdout is not a terminal, and ${how}`)
}

/** @param {string} dir @param {string} id */
function locate(dir, id) {
  const bare = id.endsWith('.json') ? id.slice(0, -'.json'.length) : id
  const root = resolve(dir, PROPOSALS_DIR)
  const file = resolve(root, `${bare}.json`)
  const outside = `proposal id ${JSON.stringify(id)} resolves outside --dir (${dir})`
  if (!isInside(dir, file)) refuse(outside)
  if (resolve(file, '..') !== root || !PROPOSAL_ID.test(bare)) {
    refuse(`${JSON.stringify(id)} is not a proposal id: an id is the name of a file in ${PROPOSALS_DIR}/ without .json (letters, digits, ".", "_" and "-")`)
  }
  if (!isInside(landingPath(dir), landingPath(file))) refuse(`${outside} through a symlink`)
  return { id: bare, file, rel: `${PROPOSALS_DIR}/${bare}.json` }
}

/** @param {{ file: string, rel: string }} loc */
function loadProposal(loc) {
  const text = readText(loc.file)
  if (text === null) refuse(`no proposal ${loc.rel} (run apply-proposal with no id to list the pending ones)`)
  const parsed = parseProposal(text)
  if ('problem' in parsed) refuse(`${loc.rel} ${parsed.problem}`)
  const { proposal } = parsed
  if ([proposal.target, proposal.reason, proposal.content].some(unsafeForTerminal)) {
    refuse(`${loc.rel} carries a control or bidirectional-format character in its target, reason or content, which can make the diff shown here differ from the bytes written`)
  }
  if (!PROPOSABLE.includes(proposal.target)) {
    refuse(`${proposal.target} is outside the proposable set: a proposal may target only a reviewed register under tools/ that the write guard protects (docs/harness/README.md, "Proposing a register edit")`)
  }
  try {
    JSON.parse(proposal.content)
  } catch (err) {
    refuse(`content is not JSON (${err instanceof Error ? err.message : String(err)}); content is the whole text of ${proposal.target}`)
  }
  return proposal
}

/** Where the write would land must be inside --dir: nothing is written through a link out. @param {string} dir @param {string} target */
function checkLanding(dir, target) {
  const dest = resolve(dir, target)
  if (!isInside(landingPath(dir), landingPath(dest))) refuse(`${target} resolves outside --dir (${dir}) through a symlink`)
  return dest
}

/** @param {string} dir @param {string} target */
function gitState(dir, target) {
  const inside = git(dir, ['rev-parse', '--is-inside-work-tree'])
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
    refuse(`${dir} is not inside a git work tree, and base and the uncommitted-changes check need one`)
  }
  // `HEAD:./<path>` is relative to the working directory, so an install below the repository
  // root reads the same blob an agent at the install root reads with `HEAD:<path>`.
  const head = git(dir, ['rev-parse', '--verify', '--quiet', `HEAD:./${target}`])
  const status = git(dir, ['status', '--porcelain', '--untracked-files=all', '--', `./${target}`])
  if (status.status !== 0) refuse(`git status failed (${status.stderr.trim()})`)
  return { blob: head.status === 0 ? head.stdout.trim() : null, dirty: status.stdout.trim() !== '' }
}

/**
 * @param {{ target: string, base: string | null }} proposal
 * @param {{ blob: string | null, dirty: boolean }} state
 */
function checkTree(proposal, state) {
  const { target, base } = proposal
  if (state.blob === null && base !== null) {
    refuse(`${target} is not in HEAD, so base must be null (it is ${base}): the proposal was staged against another tree`)
  }
  if (state.blob !== null && base === null) {
    refuse(`base is null, but ${target} is in HEAD as ${state.blob}: stage the proposal again against the committed file`)
  }
  if (base !== state.blob) {
    refuse(`base ${base} does not match HEAD:${target} (${state.blob}): the register changed after the proposal was staged, and replacing the whole file would revert that change. Stage it again`)
  }
  if (state.dirty) {
    refuse(`${target} has uncommitted changes: commit or discard them first, so the file the diff shows is the file that is replaced`)
  }
}

/**
 * The diff a human reviews, from copies in a scratch directory so its headers read
 * `current/<target>` and `proposed/<target>`. `git diff --no-index` exits 1 when the files
 * differ, which is the expected case here, not an error.
 * @param {string} target @param {string | null} current @param {string} content
 */
function renderDiff(target, current, content) {
  const scratch = mkdtempSync(join(tmpdir(), 'harness-proposal-'))
  try {
    if (current !== null) writeInstallFile(join(scratch, 'current', target), current)
    writeInstallFile(join(scratch, 'proposed', target), content)
    const from = current === null ? '/dev/null' : `current/${target}`
    const args = ['--no-pager', 'diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '--', from, `proposed/${target}`]
    const r = git(scratch, args)
    if (r.status !== 1) refuse(`git diff --no-index exited ${String(r.status)} (${r.stderr.trim()})`)
    return r.stdout
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** @param {string} dir @param {string} id */
function prepare(dir, id) {
  const loc = locate(dir, id)
  const proposal = loadProposal(loc)
  const dest = checkLanding(dir, proposal.target)
  checkTree(proposal, gitState(dir, proposal.target))
  const current = readText(dest)
  if (current === proposal.content) {
    refuse(`the proposal changes nothing: ${proposal.target} already holds its content. Delete ${loc.rel}`)
  }
  return { ...loc, dir, proposal, target: proposal.target, dest, diff: renderDiff(proposal.target, current, proposal.content) }
}

/**
 * @param {ReturnType<typeof prepare>} plan
 * @param {(question: string) => Promise<string>} ask
 * @param {(dest: string, content: string) => void} writeFile
 */
async function confirmAndWrite(plan, ask, writeFile) {
  const answer = await ask(`Type ${plan.target} to write it (anything else writes nothing): `)
  if (answer.trim() !== plan.target) {
    console.error(`apply-proposal: not applied — the answer was not ${plan.target}. Nothing was written, and ${plan.rel} is kept.`)
    return 1
  }
  // Again, after the wait: an edit or a commit made while the prompt was open must not be
  // overwritten. The bytes written are the ones the diff showed, held since the first read.
  checkLanding(plan.dir, plan.target)
  checkTree(plan.proposal, gitState(plan.dir, plan.target))
  writeFile(plan.dest, plan.proposal.content)
  rmSync(plan.file, { force: true })
  console.log(`apply-proposal: wrote ${plan.target} and deleted ${plan.rel}. Review and commit the change:`)
  console.log(`commit ${plan.target}`)
  console.log('gate-integrity fails on an escape list left uncommitted, and the commit carries the change into your pull request.')
  return 0
}

/** @param {string} question */
async function askLine(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await rl.question(question)
  } finally {
    rl.close()
  }
}

/**
 * @param {{ dir: string, dryRun?: boolean, yes?: boolean, force?: boolean }} opts
 * @param {string | undefined} id
 * @param {{ tty?: { stdin: boolean, stdout: boolean },
 *           ask?: (question: string) => Promise<string>,
 *           writeFile?: (dest: string, content: string) => void }} [deps]
 *   Injected by the tests, the way `update` takes its writer: whether stdin and stdout are
 *   terminals, the prompt, and the one install-write primitive.
 */
export async function applyProposal(
  opts,
  id,
  {
    tty = { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true },
    ask = askLine,
    writeFile = writeInstallFile,
  } = {},
) {
  try {
    if (opts.yes || opts.force) refuse('there is no --yes and no --force: a human reads the diff and types the target path')
    if (id === undefined) return list(opts.dir)
    requireTerminal(tty)
    const plan = prepare(opts.dir, id)
    console.log(`apply-proposal: ${plan.rel} proposes this change to ${plan.target}`)
    console.log(`reason: ${plan.proposal.reason}`)
    console.log(plan.diff.trimEnd())
    if (opts.dryRun) {
      console.log(`apply-proposal: dry run — nothing written, and ${plan.rel} is kept`)
      return 0
    }
    return await confirmAndWrite(plan, ask, writeFile)
  } catch (err) {
    if (!(err instanceof Refusal)) throw err
    console.error(`apply-proposal: refused — ${err.message}`)
    return 1
  }
}
