// EVERY PLACE THAT TELLS SOMEONE HOW TO BRING A FRESH SCAFFOLD UP PUTS `git init` FIRST.
//
// The scaffold's root `prepare` script is `lefthook install`, which needs a repository, and
// `wiring` reds a `.git/hooks` with no lefthook in it; the 0.9.0 ramp that softens that red
// never applies to a fresh scaffold. So `pnpm install` before `git init` cannot end green.
// init's closing steps and the README said so, while CONTRIBUTING's zero-edit recipe (the
// check that "matters most") ran the install first, and the two issue forms either never ran
// `git init` or defined a green scaffold without it. Nothing read those texts against each
// other, and check-ci-preconditions only asks init's steps to name pnpm-lock.yaml.
//
// This test reads the files and never imports them: installer/commands/init.mjs is text here
// exactly as scripts/lib/ci-preconditions.mjs reads it, and anchored on the same
// `nextSteps` function. Each slice is anchored narrowly: CONTRIBUTING's Local
// development list names `pnpm install` long before the recipe, and the recipe's own comment
// names `git init`, so the slice starts at the `node installer/cli.mjs init --dir` line.
// SOURCE: installer/commands/init.mjs · CONTRIBUTING.md · README.md · .github/ISSUE_TEMPLATE/ ·
// template/base/docs/runbooks/first-run.md
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')

/**
 * The lines from the first one matching `start` up to, not including, the next one matching
 * `end`. Empty when either anchor is missing, so a moved anchor reds instead of passing on
 * an empty or runaway slice.
 * @param {string} text
 * @param {RegExp} start
 * @param {RegExp} end
 */
function between(text, start, end) {
  const lines = text.split(/\r?\n/)
  const from = lines.findIndex((line) => start.test(line))
  const to = from === -1 ? -1 : lines.findIndex((line, i) => i > from && end.test(line))
  return to === -1 ? '' : lines.slice(from, to).join('\n')
}

/** @typedef {{ where: string, text: () => string }} Text */

/** @type {Text} */
const INIT_STEPS = {
  where: "installer/commands/init.mjs: init's next steps",
  text: () => between(read('installer/commands/init.mjs'), /^\s*function nextSteps\(/, /^\s*\}$/),
}

/** @type {Text} */
const README_BLOCK = {
  where: 'README.md: the fenced sh block that runs `pnpm install`',
  text: () =>
    [...read('README.md').matchAll(/^```sh\r?\n([\s\S]*?)^```\r?$/gm)]
      .map((block) => block[1])
      .find((body) => body.includes('pnpm install')) ?? '',
}

/** @type {Text[]} */
const TEXTS = [
  INIT_STEPS,
  {
    where: "CONTRIBUTING.md: the zero-edit scaffold recipe (from `node installer/cli.mjs init --dir` to the closing fence)",
    text: () => between(read('CONTRIBUTING.md'), /^node installer\/cli\.mjs init --dir/, /^```$/),
  },
  README_BLOCK,
  {
    where: '.github/ISSUE_TEMPLATE/bug-report.yml: the reproduction field (`id: repro`)',
    text: () => between(read('.github/ISSUE_TEMPLATE/bug-report.yml'), /^\s*id: repro\s*$/, /^\s*- type:/),
  },
  {
    where: '.github/ISSUE_TEMPLATE/gate-proposal.yml: the "Green on a fresh scaffold" bar',
    text: () => between(read('.github/ISSUE_TEMPLATE/gate-proposal.yml'), /\*\*Green on a fresh scaffold\*\*/, /^\s*- type:/),
  },
]

for (const { where, text } of TEXTS) {
  test(`${where} puts \`git init\` before \`pnpm install\``, () => {
    const body = text()
    assert.ok(body.trim() !== '', `${where}: the text was not found, or is empty; its anchor moved, so this check would be vacuous`)
    const missing = ['git init', 'pnpm install'].filter((command) => !body.includes(command))
    assert.deepEqual(missing, [], `${where}: must name both \`git init\` and \`pnpm install\`, and names no ${missing.map((command) => `\`${command}\``).join(' and no ')}:\n${body}`)
    const git = body.indexOf('git init')
    const install = body.indexOf('pnpm install')
    assert.ok(
      git < install,
      `${where}: \`pnpm install\` comes before \`git init\`. The scaffold's prepare script (lefthook install) needs a repository, and \`wiring\` reds a .git/hooks with no lefthook in it, so git init must come first:\n${body}`,
    )
  })
}

// THE FIRST RUN ENDS AT A GREEN CLAUDE CODE TURN, AND THREE TEXTS GIVE ITS STEPS: init's
// closing steps, the README's block and docs/runbooks/first-run.md. That turn's Stop hook runs
// the RLS suites, which fail closed with no local stack once supabase/migrations exists
// (tests/rls/run-rls.mjs), while `pnpm validate` does not run them. Through 2.0.5 init and the
// README stopped at `pnpm validate`, so the first turn met a stack nobody had been told to
// start. Each text is held to the same order, each step found by its first mention, so a step
// moved, dropped or added out of order in any one of them reds here.
const FIRST_RUN = ['git init', 'pnpm install', 'pnpm-lock.yaml', 'pnpm db:up', 'pnpm validate', 'Claude Code']

/** @type {Text[]} */
const FIRST_RUN_TEXTS = [
  INIT_STEPS,
  README_BLOCK,
  {
    where: 'template/base/docs/runbooks/first-run.md: the "## The steps" section',
    text: () => between(read('template/base/docs/runbooks/first-run.md'), /^## The steps$/, /^## /),
  },
]

for (const { where, text } of FIRST_RUN_TEXTS) {
  test(`${where} names the first run's steps in order: ${FIRST_RUN.map((s) => `\`${s}\``).join(', ')}`, () => {
    const body = text()
    assert.ok(body.trim() !== '', `${where}: the text was not found, or is empty; its anchor moved, so this check would be vacuous`)
    const at = FIRST_RUN.map((step) => [step, body.indexOf(step)])
    const missing = at.filter(([, i]) => i === -1).map(([step]) => `\`${step}\``)
    assert.deepEqual(missing, [], `${where}: names no ${missing.join(' and no ')}:\n${body}`)
    const order = [...at].sort((a, b) => Number(a[1]) - Number(b[1])).map(([step]) => step)
    assert.deepEqual(order, FIRST_RUN, `${where}: the steps are out of order. The stack must be up before the first Claude Code turn, whose Stop hook runs the RLS suites:\n${body}`)
  })
}
