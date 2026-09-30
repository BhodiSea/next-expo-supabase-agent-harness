// Unit proofs for the severity contract and the round budget (1.1.0, #71): the pure helpers
// the docs-sync gate, the SubagentStop hook and the reviewer-verdicts Stop step share.
//
//   - tools/lib/agent-roster.mjs: severityContract() reads a reviewer body's `Severities:` and
//     `Blocking:` lines, and severityContractProblems() is the docs-sync judgement over them.
//   - tools/lib/reviewer-verdicts.mjs: blockingFindings() reads the finding lines of a reply at
//     a blocking severity, reviewRounds() and roundOf() count review rounds per reviewer, and
//     judgeRoundBudget() is the Stop step's finding for a spent budget.
//
// This file lives under tests/gates/ because that directory is what the tools/lib coverage
// floor runs (selftest.yml). Both libs are reached through NAMESPACE imports, the way the hook
// and the step reach them, so a missing export fails ITS case with a TypeError and every other
// case still runs.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as roster from '../../template/base/tools/lib/agent-roster.mjs'
import * as verdicts from '../../template/base/tools/lib/reviewer-verdicts.mjs'

const AGENTS = fileURLToPath(new URL('../../template/base/.claude/agents', import.meta.url))

const FRONT = '---\nname: x-reviewer\ndescription: x\ntools: Read\ndisallowedTools: Write, Edit\nmodel: sonnet\n---\n'
const WHOLE = `${FRONT}\nReview it.\n\nSeverities: CRITICAL, HIGH, MEDIUM, LOW\nBlocking: CRITICAL, HIGH\n\nEnd with exactly one final line: \`VERDICT: PASS\` or \`VERDICT: BLOCK\`.\n`

// ── the contract parser ──────────────────────────────────────────────────────────────

test('severityContract: both lines read from the BODY, upper-cased, trimmed, in order', () => {
  assert.deepEqual(roster.severityContract(WHOLE), {
    severities: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'],
    blocking: ['CRITICAL', 'HIGH'],
    repeated: [],
  })
  const loose = `${FRONT}Severities:critical ,  High,medium, low\r\nBlocking:  critical,high  \r\n`
  assert.deepEqual(roster.severityContract(loose).blocking, ['CRITICAL', 'HIGH'])
  assert.deepEqual(roster.severityContract(loose).severities, ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'])
})

test('severityContract: no line is null, never an empty list — "no contract" is a state of its own', () => {
  assert.deepEqual(roster.severityContract(`${FRONT}Body with no contract.\n`), {
    severities: null,
    blocking: null,
    repeated: [],
  })
  // An empty line IS a contract, one that blocks on nothing: docs-sync reds it on the floor.
  assert.deepEqual(roster.severityContract(`${FRONT}Blocking:\n`).blocking, [])
  assert.equal(roster.severityContract(undefined).blocking, null)
})

test('severityContract: line-anchored, and a frontmatter key of the same name is not a contract', () => {
  // A sentence that mentions the line does not state it, and neither does an indented one.
  const mention = `${FRONT}The body's Blocking: CRITICAL line is read by the hook.\n  Blocking: LOW\n`
  assert.equal(roster.severityContract(mention).blocking, null)
  const inFront = '---\nname: x\nBlocking: LOW\n---\nBody.\n'
  assert.equal(roster.severityContract(inFront).blocking, null)
  // No frontmatter at all: the whole text is the body.
  assert.deepEqual(roster.severityContract('Blocking: CRITICAL\n').blocking, ['CRITICAL'])
  // An unterminated frontmatter has no body to read.
  assert.equal(roster.severityContract('---\nname: x\nBlocking: CRITICAL\n').blocking, null)
})

test('severityContract: a repeated line is the UNION, and is named — the strict reading for the hook', () => {
  const twice = `${FRONT}Blocking: CRITICAL\nSeverities: CRITICAL, HIGH\nBlocking: HIGH, CRITICAL\n`
  const c = roster.severityContract(twice)
  assert.deepEqual(c.blocking, ['CRITICAL', 'HIGH'])
  assert.deepEqual(c.repeated, ['Blocking'])
})

const PROBLEMS = /** @type {Array<[string, string, RegExp[]]>} */ ([
  ['whole', WHOLE, []],
  ['a wider Blocking line', WHOLE.replace('Blocking: CRITICAL, HIGH', 'Blocking: CRITICAL, HIGH, MEDIUM'), []],
  ['no Blocking line', WHOLE.replace('Blocking: CRITICAL, HIGH\n', ''), [/no `Blocking:` line/]],
  ['no Severities line', WHOLE.replace('Severities: CRITICAL, HIGH, MEDIUM, LOW\n', ''), [/no `Severities:` line/]],
  ['neither line', `${FRONT}Body.\n`, [/no `Severities:` line/, /no `Blocking:` line/]],
  ['Blocking omits CRITICAL', WHOLE.replace('Blocking: CRITICAL, HIGH', 'Blocking: HIGH'), [/omits CRITICAL/]],
  ['Blocking omits HIGH', WHOLE.replace('Blocking: CRITICAL, HIGH', 'Blocking: CRITICAL'), [/omits HIGH/]],
  ['an empty Blocking line', WHOLE.replace('Blocking: CRITICAL, HIGH', 'Blocking:'), [/omits CRITICAL, HIGH/]],
  [
    'Blocking not a subset of Severities',
    WHOLE.replace('Blocking: CRITICAL, HIGH', 'Blocking: CRITICAL, HIGH, SEVERE'),
    [/names SEVERE, which `Severities:` does not list/],
  ],
  ['a repeated line', WHOLE.replace('Blocking: CRITICAL, HIGH', 'Blocking: CRITICAL, HIGH\nBlocking: CRITICAL, HIGH'), [/`Blocking:` is stated more than once/]],
])

test('severityContractProblems: every rule, one sentence per problem, [] when whole', () => {
  for (const [label, text, expected] of PROBLEMS) {
    const problems = roster.severityContractProblems(text)
    assert.equal(problems.length, expected.length, `${label}: ${JSON.stringify(problems)}`)
    for (const [i, re] of expected.entries()) assert.match(problems[i], re, label)
  }
  assert.deepEqual(roster.BLOCKING_FLOOR, ['CRITICAL', 'HIGH'])
})

test('every shipped reviewer body states the contract, and its verdict paragraph stays LAST', () => {
  for (const agent of roster.REVIEWER_AGENTS) {
    const body = readFileSync(join(AGENTS, `${agent}.md`), 'utf8')
    assert.deepEqual(roster.severityContractProblems(body), [], agent)
    assert.deepEqual(roster.severityContract(body).blocking, ['CRITICAL', 'HIGH'], agent)
    const paragraphs = body.trimEnd().split(/\n\s*\n/)
    assert.match(paragraphs.at(-1) ?? '', /^End with exactly one final line/, `${agent}: verdict paragraph last`)
    // The contract sits in the paragraph right before it, with the finding format.
    assert.match(paragraphs.at(-3) ?? '', /^Severities: .*\nBlocking: /, `${agent}: contract lines`)
    assert.match(paragraphs.at(-2) ?? '', /`- \[SEVERITY\] /, `${agent}: finding format`)
  }
})

// ── the finding grammar ──────────────────────────────────────────────────────────────

test('blockingFindings: line-anchored severity tags at a blocking severity, capped, in order', () => {
  const reply = [
    'Reviewed the migration.',
    '- [HIGH] supabase/migrations/x.sql:3 — the policy has no WITH CHECK',
    '- [LOW] supabase/migrations/x.sql:9 — a comment typo',
    '* **[critical]** apps/web/app/page.tsx:1 — service role in the web process',
    '> 1. [High] packages/api/src/x.ts:2 — raw row on the wire',
    '## [HIGH] a heading-shaped finding',
    'Nothing here rose to [HIGH]; the sentence only mentions it.',
    '`[HIGH]` quoted in backticks at the start of a line counts: the strict direction',
    `- [HIGH] ${'y'.repeat(400)}`,
    '',
    'VERDICT: PASS',
  ].join('\n')
  const found = verdicts.blockingFindings(reply, ['CRITICAL', 'HIGH'])
  assert.deepEqual(found.slice(0, 5), [
    '- [HIGH] supabase/migrations/x.sql:3 — the policy has no WITH CHECK',
    '* **[critical]** apps/web/app/page.tsx:1 — service role in the web process',
    '> 1. [High] packages/api/src/x.ts:2 — raw row on the wire',
    '## [HIGH] a heading-shaped finding',
    '`[HIGH]` quoted in backticks at the start of a line counts: the strict direction',
  ])
  assert.equal(found.length, 6)
  assert.equal(found[5].length, 200, 'each recorded line is capped like the bounce record')
  assert.deepEqual(verdicts.blockingFindings(reply, ['CRITICAL']), [
    '* **[critical]** apps/web/app/page.tsx:1 — service role in the web process',
  ])
  assert.deepEqual(verdicts.blockingFindings(reply, []), [])
  assert.deepEqual(verdicts.blockingFindings(undefined, ['HIGH']), [])
  // CRLF replies read the same.
  assert.deepEqual(verdicts.blockingFindings('- [HIGH] a.ts:1 — x\r\nVERDICT: BLOCK\r\n', ['HIGH']), [
    '- [HIGH] a.ts:1 — x',
  ])
})

// ── the round count ──────────────────────────────────────────────────────────────────

const D = 'd'.repeat(64)
/** A ledger entry the 1.1.0 hook wrote for a review of an unmoving tree. */
const e = (verdict, agent_id = 'a1', over = {}) => ({
  session_id: 's1',
  prompt_id: 'p1',
  agent_type: 'security-reviewer',
  agent_id,
  verdict,
  path_state_start: D,
  path_state_stop: D,
  ...over,
})

test('reviewRounds: a PASS with no loop open is round 1; a BLOCK opens a loop and its rounds count up', () => {
  assert.deepEqual(verdicts.reviewRounds([e('PASS'), e('PASS'), e('PASS'), e('PASS')], 3), {
    rounds: [1, 1, 1, 1],
    spent: null,
  })
  const { rounds, spent } = verdicts.reviewRounds([e('BLOCK'), e('BLOCK'), e('PASS'), e('PASS')], 3)
  assert.deepEqual(rounds, [1, 2, 3, 1], 'the same agent_id passing at an unmoving tree closes the loop')
  assert.equal(spent, null)
  assert.equal(verdicts.ROUND_BUDGET, 3)
})

test('reviewRounds: a loop still open at the budget is SPENT, and a PASS past it closes nothing', () => {
  const blocks = [e('BLOCK', 'a1', { blocking: ['- [HIGH] x.sql:3 — y'] }), e('BLOCK'), e('BLOCK')]
  const at = verdicts.reviewRounds(blocks, 3)
  assert.deepEqual(at.rounds, [1, 2, 3])
  assert.equal(at.spent?.length, 3)
  const past = verdicts.reviewRounds([...blocks, e('PASS'), e('PASS')], 3)
  assert.deepEqual(past.rounds, [1, 2, 3, 4, 5])
  assert.equal(past.spent?.length, 3, 'a PASS recorded after the budget is spent never clears it')
  // One round short of the budget is not spent: the reviewer still has a round to clear it.
  assert.equal(verdicts.reviewRounds(blocks.slice(0, 2), 3).spent, null)
})

test('reviewRounds: what does NOT close a loop — another agent_id, a moving tree, a legacy entry', () => {
  const cases = /** @type {Array<[string, object]>} */ ([
    ['a PASS from another run (a second opinion)', e('PASS', 'a2')],
    ['a PASS over a moving tree', e('PASS', 'a1', { path_state_start: 'f'.repeat(64) })],
    ['a PASS with no start record', e('PASS', 'a1', { path_state_start: null })],
    ['a PASS an earlier hook wrote (no digests, no round)', { ...e('PASS'), path_state_start: undefined, path_state_stop: undefined }],
  ])
  for (const [label, pass] of cases) {
    const r = verdicts.reviewRounds([e('BLOCK'), pass, e('BLOCK', 'a3')], 3)
    assert.deepEqual(r.rounds, [1, 2, 3], label)
    assert.equal(r.spent?.length, 2, `${label}: both BLOCKs stand`)
  }
  // A BLOCK with no agent_id can never be cleared — v2's rule, and the budget's.
  const anonymous = { agent_id: undefined }
  assert.equal(
    verdicts.reviewRounds([e('BLOCK', 'a1', anonymous), e('PASS', 'a1', anonymous), e('PASS', 'a1', anonymous)], 3)
      .spent?.length,
    1,
  )
  // Every BLOCK in the loop must be cleared by its OWN run before the loop closes.
  const two = verdicts.reviewRounds([e('BLOCK', 'a1'), e('BLOCK', 'a2'), e('PASS', 'a1'), e('PASS', 'a2')], 3)
  assert.deepEqual(two.rounds, [1, 2, 3, 4])
  assert.deepEqual(two.spent?.map((b) => b.agent_id), ['a2'])
})

test('reviewRounds: legacy entries count ONE round each, with no recorded findings', () => {
  // An entry a pre-1.1.0 or parked hook wrote has no `round` and no `blocking`. The count is
  // positional, so it is one round, whatever its fields say.
  const legacy = { session_id: 's1', prompt_id: 'p0', agent_type: 'security-reviewer', verdict: 'BLOCK' }
  const r = verdicts.reviewRounds([legacy, { ...legacy }, { ...legacy, round: 1 }], 3)
  assert.deepEqual(r.rounds, [1, 2, 3])
  assert.equal(r.spent?.length, 3)
})

test('roundOf: the hook’s count, from the ledger before this entry, for this session and reviewer only', () => {
  const raw = [
    JSON.stringify(e('BLOCK')),
    'not json {',
    JSON.stringify(e('BLOCK', 'a1', { session_id: 'another-session' })),
    JSON.stringify(e('BLOCK', 'a1', { agent_type: 'web-security-reviewer' })),
    JSON.stringify(e('BLOCK')),
    '',
  ].join('\n')
  assert.deepEqual(verdicts.roundOf(raw, e('PASS'), 3), { round: 3, overBudget: false })
  assert.deepEqual(verdicts.roundOf(`${raw}${JSON.stringify(e('BLOCK'))}\n`, e('PASS'), 3), {
    round: 4,
    overBudget: true,
  })
  assert.deepEqual(verdicts.roundOf('', e('BLOCK')), { round: 1, overBudget: false })
})

test('judgeRoundBudget: null within the budget; spent, it names the budget, the runs and every finding', () => {
  const owed = { agent: 'security-reviewer' }
  assert.equal(verdicts.judgeRoundBudget(owed, [e('BLOCK'), e('BLOCK')], 3), null)
  assert.equal(verdicts.judgeRoundBudget(owed, [e('PASS'), e('PASS'), e('PASS'), e('PASS')], 3), null)
  const f = verdicts.judgeRoundBudget(
    owed,
    [
      e('BLOCK', 'a1', { blocking: ['- [HIGH] supabase/migrations/x.sql:3 — no WITH CHECK'] }),
      e('BLOCK', 'a1', {
        blocking: ['- [HIGH] supabase/migrations/x.sql:3 — no WITH CHECK', '- [CRITICAL] y.sql:1 — z'],
      }),
      e('BLOCK', 'a1', { blocking: [] }),
      e('PASS'),
      // Another reviewer's entries are not this one's rounds.
      e('BLOCK', 'a9', { agent_type: 'web-security-reviewer' }),
    ],
    3,
  )
  assert.ok(f !== null)
  assert.match(f, /^security-reviewer used its round budget of 3/)
  assert.match(f, /agent_id a1/)
  assert.match(f, /hand these findings to the human/)
  assert.match(f, /never clears/)
  assert.equal(f.match(/no WITH CHECK/g)?.length, 1, 'each finding once')
  assert.match(f, /\[CRITICAL\] y\.sql:1 — z/)
  // A spent loop whose entries carry no findings says where the findings are instead.
  const bare = verdicts.judgeRoundBudget(
    owed,
    [{ agent_type: 'security-reviewer', verdict: 'BLOCK' }, { agent_type: 'security-reviewer', verdict: 'BLOCK' }],
    2,
  )
  assert.match(bare ?? '', /No finding was recorded/)
  assert.match(bare ?? '', /agent_id none recorded/)
})
