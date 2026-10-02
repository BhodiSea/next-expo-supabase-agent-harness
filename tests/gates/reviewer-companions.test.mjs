// Reviewer bodies list what a change must bring (1.1.0, #66).
//
// A reviewer body's rubric asks about lines a diff contains, and 1.0.2 is this repository's
// own example of what that misses: seven tables kept `authenticated`'s default write
// privileges because a REVOKE was ABSENT, and the CHANGELOG records that a CI lane found it,
// "not by review". Every reviewer body that judges what a diff introduces now carries a
// `## WHAT MUST ACCOMPANY IT` table, one row per companion a rule the harness already states
// requires, and reports each row that applies as `<id>: present (file:line)` or
// `<id>: absent`. `citation-verifier` has none: it checks citations, not what a diff adds.
//
// What this file holds the shipped bodies to:
//   - exactly one heading per in-scope body, placed among the closing parts the way the
//     issue fixes it: before the `Flag ONLY` paragraph where the body has one, before the
//     `Severities:` line, and always before the verdict demand the body closes on;
//   - a well-formed table (scripts/lib/companion-table.mjs is the one parser);
//   - every `Stated in` path exists in a core-tier install, so a row restates a rule a
//     project can read rather than one that exists only in the factory;
//   - every `Enforced by` value is `review only` or a step of VALIDATE_STEPS ∪
//     STOP_HOOK_STEPS, so a row cannot claim a gate that does not exist;
//   - the rows the issue names are present, and a web-page row in the two mobile-UI bodies
//     says that it widens the body's scope;
//   - security-reviewer carries the `authenticated`-revoke row, and its opening says the
//     body has three sections now.
// No git and no shell: it runs on both selftest operating systems.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  COMPANION_HEADING,
  closingLines,
  companionTable,
  REVIEW_ONLY,
} from '../../scripts/lib/companion-table.mjs'
import { REVIEWER_AGENTS } from '../../template/base/tools/lib/agent-roster.mjs'
import { freshInstall } from '../installer/helpers/provenance-fixture.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const AGENTS = join(ROOT, 'template/base/.claude/agents')
const config = await import(pathToFileURL(join(ROOT, 'template/base/tools/harness.config.mjs')).href)
const STEPS = new Set([...config.VALIDATE_STEPS, ...config.STOP_HOOK_STEPS].map(([name]) => name))

const EXCLUDED = new Set(['citation-verifier'])
const IN_SCOPE = REVIEWER_AGENTS.filter((a) => !EXCLUDED.has(a))

// The rows the issue names, by id: a table (its revoke, its isolation rows, its audit
// trigger), a SQL function, an Edge Function and a tRPC mutation for security-reviewer; a
// Server Action for web-security-reviewer; a screen and a web page for the two mobile-UI
// reviewers and torvalds-reviewer; a permission and a config plugin; a new interface.
const REQUIRED = {
  'security-reviewer': [
    'table-authenticated-revoke',
    'table-isolation-targets',
    'table-audit-trigger',
    'definer-function-execute-revoke',
    'edge-function-adr',
    'mutation-rate-limit',
  ],
  'web-security-reviewer': ['server-action-rate-limit', 'server-action-identity', 'server-action-contract'],
  'accessibility-reviewer': ['screen-route-states', 'web-page-meta'],
  'design-reviewer': ['screen-route-states', 'web-page-meta'],
  'torvalds-reviewer': ['screen-route-states', 'screen-maestro-flow', 'screen-startup-budget', 'web-page-meta'],
  'mobile-security-reviewer': ['permission-register', 'config-plugin-register'],
  'architecture-reviewer': ['interface-second-consumer'],
}
const WIDENS = new Set(['accessibility-reviewer', 'design-reviewer'])

const body = (agent) => readFileSync(join(AGENTS, `${agent}.md`), 'utf8')
const collapsed = (text) => text.replace(/\s+/g, ' ')

let install = ''
before(async () => {
  install = await freshInstall('reviewer-companions-')
})
after(() => {
  if (install !== '') rmSync(install, { recursive: true, force: true })
})

test('the in-scope set is every reviewer but citation-verifier, and the required map names each one', () => {
  assert.deepEqual([...IN_SCOPE].sort(), Object.keys(REQUIRED).sort())
  assert.ok(REVIEWER_AGENTS.includes('citation-verifier'))
})

test('citation-verifier carries no companion table: it checks citations, not what a diff adds', () => {
  assert.equal(companionTable(body('citation-verifier')).headingLines.length, 0)
})

for (const agent of IN_SCOPE) {
  test(`${agent}: exactly one companion heading, a well-formed table, placed before the closing parts`, () => {
    const text = body(agent)
    const table = companionTable(text)
    assert.equal(table.headingLines.length, 1, `${agent}: expected exactly one \`${COMPANION_HEADING}\` heading`)
    assert.deepEqual(table.problems, [], `${agent}: the companion table is malformed`)
    const [heading] = table.headingLines
    const { flagOnly, severities, closing } = closingLines(text)
    if (flagOnly !== null) {
      assert.ok(heading < flagOnly, `${agent}: the heading (line ${heading}) must precede the Flag ONLY paragraph (line ${flagOnly})`)
    }
    assert.ok(severities !== null && heading < severities, `${agent}: the heading must precede the Severities: line`)
    assert.ok(heading < closing, `${agent}: the heading must precede the verdict demand the body closes on`)
  })

  test(`${agent}: every Stated in path exists in a core-tier install`, () => {
    const { rows } = companionTable(body(agent))
    assert.ok(rows.length > 0, `${agent}: no companion rows to check`)
    const missing = rows.flatMap((r) =>
      r.statedIn.filter((p) => !existsSync(join(install, p))).map((p) => `${r.id}: ${p}`),
    )
    assert.deepEqual(missing, [])
  })

  test(`${agent}: every Enforced by value is review only or a chain step`, () => {
    const { rows } = companionTable(body(agent))
    assert.ok(rows.length > 0, `${agent}: no companion rows to check`)
    const unknown = rows.flatMap((r) =>
      r.enforcedBy.filter((s) => s !== REVIEW_ONLY && !STEPS.has(s)).map((s) => `${r.id}: ${s}`),
    )
    assert.deepEqual(unknown, [])
  })

  test(`${agent}: carries the rows the issue names, and says how to report them`, () => {
    const text = body(agent)
    const { rows } = companionTable(text)
    const ids = new Set(rows.map((r) => r.id))
    assert.deepEqual(
      REQUIRED[agent].filter((id) => !ids.has(id)),
      [],
      `${agent}: missing required companion rows`,
    )
    assert.ok(collapsed(text).includes('`<id>: present (file:line)` or `<id>: absent`'), `${agent}: the report format is not stated`)
    if (WIDENS.has(agent)) {
      for (const r of rows.filter((row) => row.id.startsWith('web-page'))) {
        assert.match(`${r.introduces} ${r.bring}`, /widens this body's scope/, `${agent}: ${r.id} must say it widens the body's scope`)
      }
    }
  })
}

test("security-reviewer: the authenticated-revoke row, and 'Three sections.' in its opening", () => {
  const text = body('security-reviewer')
  const row = companionTable(text).rows.find((r) => r.id === 'table-authenticated-revoke')
  assert.ok(row, 'no table-authenticated-revoke row')
  assert.match(row.bring, /REVOKE ALL ON TABLE public\.<t> FROM authenticated/)
  assert.match(row.bring, /-- adr:/)
  const flat = collapsed(text)
  assert.ok(flat.includes('Three sections.'), 'the section count must say three')
  assert.ok(!flat.includes('Two sections.'), 'the old section count must be gone')
})
