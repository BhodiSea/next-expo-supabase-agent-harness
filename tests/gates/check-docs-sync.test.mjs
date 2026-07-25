// Can-fail proofs for the docs-sync gate: the agent-facing docs cannot lie
// about the chain. Fixtures render a minimal AGENTS.md/CLAUDE.md/package.json
// against the SHIPPED harness.config.mjs (copied in), so the gate's parse of
// the real config is under test, not a stub.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseFrontmatter,
  splitList,
} from '../../template/base/tools/lib/agent-roster.mjs'

const TOOLS = fileURLToPath(new URL('../../template/base/tools', import.meta.url))
const AGENTS_TEMPLATE = fileURLToPath(new URL('../../template/base/AGENTS.md', import.meta.url))
const CATALOG_TEMPLATE = fileURLToPath(
  new URL('../../template/base/docs/harness/gates-catalog.md', import.meta.url),
)
const ROSTER_TEMPLATE = fileURLToPath(
  new URL('../../template/base/.claude/agents', import.meta.url),
)

// The REAL shipped scripts (placeholders neutralized) — the GREEN case must
// prove the shipped AGENTS.md against the shipped package surface.
const SHIPPED_SCRIPTS = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../template/base/package.json.tmpl', import.meta.url)), 'utf8')
    .replace(/\{\{[A-Z0-9_]+\}\}/g, 'x'),
).scripts

// The shipped catalog is the canonical fixture for the catalog-lockstep check,
// exactly like the shipped AGENTS.md is for the gate-list check. `catalog: null`
// simulates a deleted catalog; `manifest` (an object) plants .harness/manifest.json
// for the version-ramp cases. The shipped .claude/agents roster is copied in by
// default (the GREEN case proves the real shipped agents against the real gate);
// `roster` overlays it — filename -> content plants/overwrites a file, null deletes.
/** @param {{ agents?: any, claude?: any, scripts?: any, catalog?: any, manifest?: any, roster?: any }} parts */
function fixture({ agents, claude = '@AGENTS.md\n', scripts = SHIPPED_SCRIPTS, catalog = shippedCatalog, manifest, roster }) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-docs-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  cpSync(join(TOOLS, 'lib'), join(dir, 'tools/lib'), { recursive: true })
  cpSync(join(TOOLS, 'harness.config.mjs'), join(dir, 'tools/harness.config.mjs'))
  cpSync(join(TOOLS, 'check-docs-sync.mjs'), join(dir, 'tools/check-docs-sync.mjs'))
  cpSync(ROSTER_TEMPLATE, join(dir, '.claude/agents'), { recursive: true })
  for (const [name, content] of Object.entries(roster ?? {})) {
    if (content === null) rmSync(join(dir, '.claude/agents', name))
    else writeFileSync(join(dir, '.claude/agents', name), content)
  }
  writeFileSync(join(dir, 'AGENTS.md'), agents)
  writeFileSync(join(dir, 'CLAUDE.md'), claude)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts }))
  if (catalog !== null) {
    mkdirSync(join(dir, 'docs/harness'), { recursive: true })
    writeFileSync(join(dir, 'docs/harness/gates-catalog.md'), catalog)
  }
  if (manifest !== undefined) {
    mkdirSync(join(dir, '.harness'), { recursive: true })
    writeFileSync(join(dir, '.harness/manifest.json'), JSON.stringify(manifest))
  }
  return dir
}

const shippedCatalog = readFileSync(CATALOG_TEMPLATE, 'utf8')

function runGate(dir) {
  const res = spawnSync('node', ['tools/check-docs-sync.mjs'], { cwd: dir, encoding: 'utf8', env: { ...process.env, CI: 'true' } })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

// The shipped AGENTS.md is the canonical fixture — extract its real gate-list
// sentence so these tests track the template instead of hand-copying it.
const shippedAgents = readFileSync(AGENTS_TEMPLATE, 'utf8')

test('GREEN: the shipped AGENTS.md gate list matches the shipped VALIDATE_STEPS', () => {
  const r = runGate(fixture({ agents: shippedAgents }))
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('lockstep'), r.out)
})

test('RED: a drifted gate list names the documented vs actual chains', () => {
  const drifted = shippedAgents.replace('`docs-sync`', '`docs-sync`, `imaginary-gate`')
  const r = runGate(fixture({ agents: drifted }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('drifted from VALIDATE_STEPS'), r.out)
})

test('RED: a wrong gate COUNT fails even when the names parse', () => {
  const wrongCount = shippedAgents.replace(/The (\d+) gates, in order:/, 'The 7 gates, in order:')
  const r = runGate(fixture({ agents: wrongCount }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('update the count'), r.out)
})

test('RED: impure CLAUDE.md and an advertised script that does not exist', () => {
  const impure = runGate(fixture({ agents: shippedAgents, claude: '@AGENTS.md\nextra doctrine here\n' }))
  assert.equal(impure.code, 1, impure.out)
  assert.ok(impure.out.includes('pure'), impure.out)

  const ghost = runGate(
    fixture({ agents: shippedAgents, scripts: { test: 'vitest run', 'test:rls': 'x' } }),
  )
  assert.equal(ghost.code, 1, ghost.out)
  assert.ok(ghost.out.includes('`pnpm validate`'), ghost.out)
})

// ── catalog lockstep: every VALIDATE_STEPS name needs its numbered
// `### <n>. <name> — ` section in docs/harness/gates-catalog.md. In this lineage
// the check ships in 0.1.0, so it is live on every fresh install. ──

test('RED: renaming a numbered catalog section reds the catalog-lockstep sub-check', () => {
  const renamed = shippedCatalog.replace(
    /^### (\d+)\. perf-budget — /m,
    '### $1. perf-fudget — ',
  )
  assert.notEqual(renamed, shippedCatalog, 'fixture must actually rename a section')
  const r = runGate(fixture({ agents: shippedAgents, catalog: renamed }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("gate 'perf-budget' has no section"), r.out)
  assert.ok(r.out.includes('FIX[docs-sync]:'), r.out)
})

test('RED: a deleted catalog file fails naming the owned doc; module/runner sections never satisfy the check', () => {
  const gone = runGate(fixture({ agents: shippedAgents, catalog: null }))
  assert.equal(gone.code, 1, gone.out)
  assert.ok(gone.out.includes('docs/harness/gates-catalog.md missing'), gone.out)

  // Strip every NUMBERED heading but keep the un-numbered sections (Stop-hook
  // suites, the validate-runner note, opt-in modules): all 21 steps must red —
  // proof the pinned grammar cannot be satisfied by a non-step section.
  const unnumbered = shippedCatalog.replace(/^### \d+\. [a-z0-9-]+ — .*$/gm, '')
  const r = runGate(fixture({ agents: shippedAgents, catalog: unnumbered }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("gate 'format' has no section"), r.out)
  assert.ok(r.out.includes("gate 'docs-sync' has no section"), r.out)
})

test('RAMP: a baseVersion predating 0.1.0 downgrades a catalog miss to NOTE + pass; 0.1.0 manifests stay live', () => {
  // The catalog check is ramped via rampNote(GATE, '0.1.0', …). Every install in
  // THIS lineage starts at 0.1.0, so in practice the check is always live — but
  // the ramp machinery itself must still be provable both ways (it is the same
  // shared rampNote every later check will ride).
  const renamed = shippedCatalog.replace(/^### (\d+)\. perf-budget — /m, '### $1. perf-fudget — ')

  // A hypothetical pre-lineage consumer (no baseVersion field yet — harnessVersion
  // is the fallback): the miss surfaces as NOTEs, the gate stays green.
  const ramped = runGate(
    fixture({ agents: shippedAgents, catalog: renamed, manifest: { harnessVersion: '0.0.9', files: {} } }),
  )
  assert.equal(ramped.code, 0, ramped.out)
  assert.ok(ramped.out.includes('NOTE'), ramped.out)
  assert.ok(ramped.out.includes('baseVersion'), ramped.out)
  assert.ok(ramped.out.includes("gate 'perf-budget' has no section"), ramped.out)

  // A first-lineage (or graduated) install is live: same injection, real red.
  const live = runGate(
    fixture({
      agents: shippedAgents,
      catalog: renamed,
      manifest: { harnessVersion: '0.1.0', baseVersion: '0.1.0', files: {} },
    }),
  )
  assert.equal(live.code, 1, live.out)
  assert.ok(live.out.includes("gate 'perf-budget' has no section"), live.out)
})

// ── agent roster: "read-only by construction" is machine-asserted.
// The GREEN baseline above already proves the SHIPPED roster parses clean —
// fixture() copies the real .claude/agents in by default. Deliberately no ramp
// cases: the roster is harness-owned, so it refreshes with the gate. ──

function shippedAgent(name) {
  return readFileSync(join(ROSTER_TEMPLATE, name), 'utf8')
}

test('GREEN: the shipped roster passes and the summary counts all seven reviewers', () => {
  const r = runGate(fixture({ agents: shippedAgents }))
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('7/7 reviewers read-only'), r.out)
})

test('RED: a reviewer granted Bash names the agent, the grant, and the doctrine', () => {
  const widened = shippedAgent('security-reviewer.md').replace(
    'tools: Read, Grep, Glob, mcp__rls_verify',
    'tools: Read, Grep, Glob, mcp__rls_verify, Bash',
  )
  assert.ok(widened.includes(', Bash'), 'fixture must actually widen the grant')
  const r = runGate(fixture({ agents: shippedAgents, roster: { 'security-reviewer.md': widened } }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(".claude/agents/security-reviewer.md: reviewer granted 'Bash'"), r.out)
  assert.ok(r.out.includes('read-only by construction'), r.out)
  assert.ok(r.out.includes('FIX[docs-sync]:'), r.out)
})

test('RED: a reviewer granted Write, and a reviewer with disallowedTools dropped, both red', () => {
  const written = shippedAgent('torvalds-reviewer.md').replace(
    'tools: Read, Grep, Glob',
    'tools: Read, Grep, Glob, Write',
  )
  const w = runGate(fixture({ agents: shippedAgents, roster: { 'torvalds-reviewer.md': written } }))
  assert.equal(w.code, 1, w.out)
  assert.ok(w.out.includes(".claude/agents/torvalds-reviewer.md: reviewer granted 'Write'"), w.out)

  const undisallowed = shippedAgent('mobile-security-reviewer.md').replace(
    /disallowedTools: Write, Edit\n/,
    '',
  )
  assert.ok(!undisallowed.includes('disallowedTools'), 'fixture must actually drop the key')
  const d = runGate(
    fixture({ agents: shippedAgents, roster: { 'mobile-security-reviewer.md': undisallowed } }),
  )
  assert.equal(d.code, 1, d.out)
  assert.ok(d.out.includes("'disallowedTools' must include Write"), d.out)
  assert.ok(d.out.includes("'disallowedTools' must include Edit"), d.out)
})

test('RED: a reviewer with NO tools list (inherit-everything) fails closed', () => {
  const inherit = shippedAgent('accessibility-reviewer.md').replace(/tools: Read, Grep, Glob\n/, '')
  assert.ok(!/^tools:/m.test(inherit), 'fixture must actually drop the tools list')
  const r = runGate(
    fixture({ agents: shippedAgents, roster: { 'accessibility-reviewer.md': inherit } }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("declares no 'tools' list"), r.out)
})

test('GREEN: author agents are unconstrained — a consumer-added author with Bash/Write stays green', () => {
  const custom =
    '---\nname: db-tuner\ndescription: consumer-added author agent\ntools: Read, Edit, Write, Bash\nmodel: sonnet\n---\nBody.\n'
  const r = runGate(fixture({ agents: shippedAgents, roster: { 'db-tuner.md': custom } }))
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('11 agent(s) parsed'), r.out)
})

test('RED: missing model, name/filename mismatch, unparseable frontmatter, deleted reviewer', () => {
  const noModel = runGate(
    fixture({
      agents: shippedAgents,
      roster: { 'helper.md': '---\nname: helper\ndescription: x\n---\nBody.\n' },
    }),
  )
  assert.equal(noModel.code, 1, noModel.out)
  assert.ok(noModel.out.includes("helper.md: missing/empty frontmatter field 'model'"), noModel.out)

  const mismatch = runGate(
    fixture({
      agents: shippedAgents,
      roster: { 'helper.md': '---\nname: other\ndescription: x\nmodel: sonnet\n---\nBody.\n' },
    }),
  )
  assert.equal(mismatch.code, 1, mismatch.out)
  assert.ok(mismatch.out.includes("name 'other' must match the filename ('helper')"), mismatch.out)

  // A reviewer rewritten with a block SEQUENCE (outside the pinned grammar): the
  // Bash grant inside it must NOT be silently skipped — parse failure is the red.
  const unparseable = runGate(
    fixture({
      agents: shippedAgents,
      roster: {
        'security-reviewer.md':
          '---\nname: security-reviewer\ndescription: x\nmodel: opus\ntools:\n  - Read\n  - Bash\n---\nBody.\n',
      },
    }),
  )
  assert.equal(unparseable.code, 1, unparseable.out)
  assert.ok(unparseable.out.includes('frontmatter does not parse'), unparseable.out)
  assert.ok(unparseable.out.includes('fails CLOSED'), unparseable.out)

  const gone = runGate(fixture({ agents: shippedAgents, roster: { 'citation-verifier.md': null } }))
  assert.equal(gone.code, 1, gone.out)
  assert.ok(gone.out.includes('citation-verifier.md: reviewer agent missing'), gone.out)
})

// ── the pinned frontmatter grammar itself (tools/lib/agent-roster.mjs) ──

test('agent-roster parser: scalars, quotes, folded/literal blocks, inline + bracketed lists, comments', () => {
  const parsed = parseFrontmatter(
    [
      '---',
      '# a comment line',
      'name: security-reviewer',
      "model: 'opus'",
      'description: >',
      '  Read-only auditor.',
      '  Second folded line.',
      '',
      'notes: |',
      '  line one',
      '  line two',
      'tools: Read, Grep, Glob',
      'flow: [Read, "Grep"]',
      'empty:',
      '---',
      'body text is never parsed',
    ].join('\n'),
  )
  assert.equal(parsed.ok, true, JSON.stringify(parsed))
  assert.equal(parsed.data.name, 'security-reviewer')
  assert.equal(parsed.data.model, 'opus')
  assert.equal(parsed.data.description, 'Read-only auditor. Second folded line.')
  assert.equal(parsed.data.notes, 'line one\nline two')
  assert.deepEqual(splitList(parsed.data.tools), ['Read', 'Grep', 'Glob'])
  assert.deepEqual(splitList(parsed.data.flow), ['Read', 'Grep'])
  assert.equal(parsed.data.empty, '')
  assert.deepEqual(splitList(undefined), [])
})

test('agent-roster parser: everything outside the pinned grammar FAILS — never fail-open', () => {
  const bad = {
    'no frontmatter': 'just a body\n',
    unterminated: '---\nname: x\n',
    'block sequence': '---\ntools:\n  - Read\n  - Bash\n---\n',
    'nested map': '---\nmeta: x\n  nested: y\n---\n',
    'duplicate key': '---\nname: a\nname: b\n---\n',
    'not key-value': '---\njust some words\n---\n',
  }
  for (const [label, text] of Object.entries(bad)) {
    const parsed = parseFrontmatter(text)
    assert.equal(parsed.ok, false, `${label} must fail to parse`)
    assert.ok(parsed.error.length > 0, label)
  }
})
