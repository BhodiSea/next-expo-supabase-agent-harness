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
// SOURCE: installer/commands/init.mjs · CONTRIBUTING.md · README.md · .github/ISSUE_TEMPLATE/
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

/** @type {Array<{ where: string, text: () => string }>} */
const TEXTS = [
  {
    where: "installer/commands/init.mjs: init's next steps",
    text: () => between(read('installer/commands/init.mjs'), /^\s*function nextSteps\(/, /^\s*\}$/),
  },
  {
    where: "CONTRIBUTING.md: the zero-edit scaffold recipe (from `node installer/cli.mjs init --dir` to the closing fence)",
    text: () => between(read('CONTRIBUTING.md'), /^node installer\/cli\.mjs init --dir/, /^```$/),
  },
  {
    where: 'README.md: the fenced sh block that runs `pnpm install`',
    text: () =>
      [...read('README.md').matchAll(/^```sh\r?\n([\s\S]*?)^```\r?$/gm)]
        .map((block) => block[1])
        .find((body) => body.includes('pnpm install')) ?? '',
  },
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
