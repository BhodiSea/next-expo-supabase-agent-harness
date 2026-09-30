// THE DOCTRINE'S LIST OF WHAT `HARNESS_ALLOW_SELF_EDIT=1` RELAXES IS A CLAIM ABOUT CODE
// (1.1.0, #80). The flag's reach is spread over two hooks, a generator and a gate, and until
// 1.1.0 no document stated it: the doctrine's Stop-hook section even told a human the flag
// let them comment floored steps out, which three checks refuse. So the section in
// template/base/docs/harness/README.md is closed over the code, in the doc-to-code shape of
// cli-docs-sync.test.mjs:
//
//   (a) the bash-guard rule ids it names are exactly the BASH_RULES ids that carry an
//       `allowWhen` — a rule that gains or loses the escape reds until the list follows;
//   (b) every shipped .mjs that reads the flag from `process.env` is named by its install
//       path — a new reader reds until the section says what it relaxes;
//   (c) that scan finds at least the four readers the section was written from, so an empty
//       or broken scan cannot pass (b) vacuously.
//
// The Stop-hook cost section and the pointers to the new section (the catalog, docs/cli.md,
// SECURITY.md, CONTRIBUTING.md) are pinned too, since each was a place the flag was stated
// wrongly or not at all.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { walkTemplate } from '../../installer/lib/copy.mjs'
import { templateTrees } from '../../scripts/lib/released-shas.mjs'
import * as guardRules from '../../template/base/.claude/hooks/lib/guard-rules.mjs'

const abs = (rel) => fileURLToPath(new URL(`../../${rel}`, import.meta.url))
const read = (rel) => readFileSync(abs(rel), 'utf8')

const DOCTRINE = 'template/base/docs/harness/README.md'
const HEADING = '### What `HARNESS_ALLOW_SELF_EDIT=1` relaxes'
// The same regex the issue states: a dotted or bracketed read of the variable, so prose and
// deny messages that merely NAME the flag (there are many) are not readers.
const READS_FLAG =
  /process\.env(?:\.HARNESS_ALLOW_SELF_EDIT\b|\[\s*['"]HARNESS_ALLOW_SELF_EDIT['"]\s*\])/
// The readers the section was written from. A floor for (c), not the list (b) checks.
const KNOWN_READERS = [
  '.claude/hooks/pretool-write-guard.mjs',
  '.claude/hooks/pretool-bash-guard.mjs',
  'tools/gen-agents-lock.mjs',
  'tools/check-gate-integrity.mjs',
]

/**
 * The lines from `heading` up to (not including) the next markdown heading of any level.
 * Split on /\r?\n/: tests/gates also runs on Windows, where a checkout may carry CRLF.
 * @param {string} text @param {string} heading @returns {string | null}
 */
function sectionOf(text, heading) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === heading)
  if (start === -1) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^#{1,6}\s/.test(line))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

/** @param {string} text @returns {Set<string>} every `backticked` token in the text */
const backticked = (text) => new Set([...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]))

const doctrine = read(DOCTRINE)
const section = sectionOf(doctrine, HEADING)

/** Install path of every shipped .mjs that reads the flag, across every template tree. */
function flagReaders() {
  const out = []
  for (const tree of templateTrees(abs('template'))) {
    for (const { installPath, sourcePath } of walkTemplate(tree)) {
      if (!installPath.endsWith('.mjs')) continue
      if (READS_FLAG.test(readFileSync(sourcePath, 'utf8'))) out.push(installPath)
    }
  }
  return [...new Set(out)].sort()
}

test(`${DOCTRINE} has a section headed ${HEADING}`, () => {
  assert.ok(section !== null, `no line reading exactly ${JSON.stringify(HEADING)} in ${DOCTRINE}`)
  assert.ok(section.trim().length > 0, 'the section is empty')
})

test('(a) the bash-guard rules the section names are exactly the rules with an allowWhen', () => {
  assert.ok(section !== null, `no ${HEADING} section`)
  const ids = guardRules.BASH_RULES.map((r) => r.id)
  const escapable = guardRules.BASH_RULES.filter((r) => typeof r.allowWhen === 'function').map(
    (r) => r.id,
  )
  assert.ok(escapable.length > 0, 'no BASH_RULES entry carries an allowWhen: the parse is vacuous')
  const named = [...backticked(section)].filter((t) => ids.includes(t))
  assert.deepEqual(
    [...named].sort(),
    [...escapable].sort(),
    'the section must name, as `backticked` ids, every bash-guard rule whose allowWhen lets the flag through and no other rule',
  )
})

test('(b) every shipped .mjs that reads the flag is named in the section by its install path', () => {
  assert.ok(section !== null, `no ${HEADING} section`)
  const tokens = backticked(section)
  const missing = flagReaders().filter((p) => !tokens.has(p))
  assert.deepEqual(
    missing,
    [],
    `these shipped files read HARNESS_ALLOW_SELF_EDIT but the doctrine's section does not name them: ${missing.join(', ')}`,
  )
})

test('(c) the reader scan is not vacuous: it finds the four readers the section was written from', () => {
  const found = flagReaders()
  for (const known of KNOWN_READERS) {
    assert.ok(found.includes(known), `the scan missed ${known} (found: ${found.join(', ')})`)
  }
})

test('the section keeps the layers the flag does NOT lift', () => {
  assert.ok(section !== null, `no ${HEADING} section`)
  // The permission denies (layer 1) and the append-only migrations deny are the two a reader
  // is most likely to assume the flag lifts. CODEOWNERS is where a flagged change is judged.
  for (const phrase of ['permission denies', 'append-only migrations deny', 'CODEOWNERS']) {
    assert.ok(section.includes(phrase), `the section never mentions the ${phrase}`)
  }
})

test('the Stop-hook cost section no longer tells a human the flag trims floored steps', () => {
  const cost = sectionOf(doctrine, '## Stop-hook cost')
  assert.ok(cost !== null, `no "## Stop-hook cost" section in ${DOCTRINE}`)
  assert.ok(!/comment steps out/.test(cost), cost)
  assert.ok(cost.includes('`HARNESS_ALLOW_SELF_EDIT=1` relaxes none of these checks'), cost)
  for (const floor of ['tools/validate.floor.json', 'tools/stop.floor.json']) {
    assert.ok(cost.includes(floor), `the section must name ${floor}, the floor that keeps the step`)
  }
})

test('the catalog, the CLI page, SECURITY.md and CONTRIBUTING.md point at the section', () => {
  const pointer = 'What `HARNESS_ALLOW_SELF_EDIT=1` relaxes'
  const catalog = read('template/base/docs/harness/gates-catalog.md')
  const gi = sectionOf(catalog, '### 2. gate-integrity — `node tools/check-gate-integrity.mjs`')
  assert.ok(gi !== null, 'no gate-integrity section in the catalog')
  assert.ok(gi.includes(pointer), 'the catalog gate-integrity section must point at the doctrine section')
  assert.ok(gi.includes('switches off only the last of these'), gi)

  const cliRow = read('docs/cli.md')
    .split(/\r?\n/)
    .find((line) => line.startsWith('| `HARNESS_ALLOW_SELF_EDIT=1` |'))
  assert.ok(cliRow?.includes(pointer), `docs/cli.md's HARNESS_ALLOW_SELF_EDIT row: ${cliRow}`)
  assert.ok(cliRow?.includes('../template/base/docs/harness/README.md'), String(cliRow))

  assert.ok(
    read('SECURITY.md').includes(
      'What the flag relaxes, and what it does not, is listed in [template/base/docs/harness/README.md](template/base/docs/harness/README.md).',
    ),
    'SECURITY.md must link the escape hatch it calls documented',
  )

  const contributing = read('CONTRIBUTING.md')
  const at = contributing.indexOf('**Editing the machinery.**')
  assert.ok(at !== -1, 'CONTRIBUTING.md has no "Editing the machinery" paragraph')
  assert.ok(at < contributing.indexOf('## Coding standards'), 'the paragraph must precede Coding standards')
  for (const script of ['scripts/ci/upgrade-lane.sh', 'scripts/ci/consumer-ci-static.sh', 'scripts/ci/run-stop-chain.mjs']) {
    assert.ok(contributing.slice(at).includes(script), `the paragraph must name ${script}`)
    // The claim is that each one REMOVES the flag before it runs; hold it to its source.
    assert.ok(
      /^\s*(?:unset HARNESS_ALLOW_SELF_EDIT\b|delete \w+\.HARNESS_ALLOW_SELF_EDIT\b)/m.test(read(script)),
      `${script} no longer removes HARNESS_ALLOW_SELF_EDIT, which CONTRIBUTING.md says it does`,
    )
  }
})
