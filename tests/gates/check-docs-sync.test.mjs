// Can-fail proofs for the docs-sync gate: the agent-facing docs cannot lie
// about the chain. Fixtures render a minimal AGENTS.md/CLAUDE.md/package.json
// against the SHIPPED harness.config.mjs (copied in), so the gate's parse of
// the real config is under test, not a stub.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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
/** @param {{ agents?: any, claude?: any, scripts?: any, catalog?: any, manifest?: any, roster?: any, files?: Record<string, string> }} parts */
function fixture({ agents, claude = '@AGENTS.md\n', scripts = SHIPPED_SCRIPTS, catalog = shippedCatalog, manifest, roster, files }) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-docs-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  cpSync(join(TOOLS, 'lib'), join(dir, 'tools/lib'), { recursive: true })
  cpSync(join(TOOLS, 'harness.config.mjs'), join(dir, 'tools/harness.config.mjs'))
  cpSync(join(TOOLS, 'check-docs-sync.mjs'), join(dir, 'tools/check-docs-sync.mjs'))
  // The frozen Stop floor comes too: it is the universe of the gate's Stop-catalog
  // closure, and the shipped tree always carries it (owned; `update` restores it).
  cpSync(join(TOOLS, 'stop.floor.json'), join(dir, 'tools/stop.floor.json'))
  // The deferral ledger comes for the same reason (0.7.0): the shipped catalog carries a
  // dated deferral sentence, and without its ledger entry every fixture would red on the
  // scan rather than on its own subject.
  cpSync(join(TOOLS, 'deferrals.json'), join(dir, 'tools/deferrals.json'))
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
  for (const [rel, content] of Object.entries(files ?? {})) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  // The 0.9.5 body-command closure demands every `node <path>.mjs` a .claude body
  // names actually exist. Resolve each such reference against the SHIPPED template
  // and copy the real file in — so the GREEN fixtures keep proving the shipped
  // bodies reference only real paths, while a ghost reference (absent from the
  // template too) stays red exactly as it would on a real tree.
  const TEMPLATE_BASE = join(TOOLS, '..')
  for (const rel of ['rules', 'commands', 'skills', 'agents']) {
    const surfaceDir = join(dir, '.claude', rel)
    if (!existsSync(surfaceDir)) continue
    for (const body of walkBodies(surfaceDir)) {
      for (const m of body.matchAll(/`node ((?:tools|tests|\.claude)\/[^\s`]+\.mjs)/g)) {
        const shipped = join(TEMPLATE_BASE, m[1])
        if (existsSync(shipped) && !existsSync(join(dir, m[1]))) {
          mkdirSync(join(dir, m[1], '..'), { recursive: true })
          cpSync(shipped, join(dir, m[1]))
        }
      }
    }
  }
  return dir
}

function* walkBodies(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, entry.name)
    if (entry.isDirectory()) yield* walkBodies(p)
    else if (entry.name.endsWith('.md')) yield readFileSync(p, 'utf8')
  }
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

// ── ADDITIVE drift is the harness's doing; anything else is the project's (0.3.0) ──
// Found by the upgrade lane. AGENTS.md is SEEDED, so `update` correctly never rewrites
// it — while migrations.json's configSteps injection DOES add steps to the chain. A
// consumer's documented list is then one release behind through no act of theirs, and a
// hard red there is a gate ambushing an update. The distinction has to be decidable, or
// the fix is just "ramp everything", which retires the check.

test('RAMP: a chain that only GAINED steps is a dated NOTE on a pre-0.6.0 install', () => {
  // Every documented gate still exists, in order — so the difference is steps something
  // else added, and the only thing that adds steps to a seeded config is `update`.
  //
  // THE RAMP MOVED AGAIN IN 0.8.0 and these two tests moved with it, in the same diff —
  // exactly as the 0.6.0 move before it. The 0.6.0 ramp expired at 0.7.0; 0.8.0 injects
  // `observability` via configSteps, so the same ambush is live again for every install
  // whose AGENTS.md still says 33 (or fewer). A ramp's tests are pinned to its version by
  // construction — leaving them on the old one is how a re-opened escape ends up asserting
  // the previous release's deadline.
  const r = runGate(
    fixture({
      agents: shippedAgents
        .replace(/The (\d+) gates, in order:/, 'The 29 gates, in order:')
        .replace(/the (\d+)-step chain/, 'the 29-step chain')
        .replace(' `wiring`,\n  `secrets`,', '')
        .replace('`gate-integrity`, `wiring`, `secrets`,', '`gate-integrity`,'),
      manifest: { harnessVersion: '0.8.0', baseVersion: '0.7.0', files: {} },
    }),
  )
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('expires in 0.9.0'), `the NOTE must carry its deadline:\n${r.out}`)
  assert.ok(r.out.includes('steps the UPDATE injected'), r.out)
})

test('the re-opened gate-list ramp EXPIRES at harness 0.9.0 — the branch EXECUTED', () => {
  // The registered proof for the release the deadline arrives, written beside the ramp it
  // proves (the check-observability.test.mjs twin at its own 0.9.0 expiry): the same
  // additive drift that NOTEs above hard-fails once the harness reads 0.9.0, because the
  // 0.8.0→0.9.0 extension was the deadline's LAST move — the injected step's escape must
  // die on schedule or the lockstep check it escapes never returns.
  const r = runGate(
    fixture({
      agents: shippedAgents
        .replace(/The (\d+) gates, in order:/, 'The 29 gates, in order:')
        .replace(/the (\d+)-step chain/, 'the 29-step chain')
        .replace(' `wiring`,\n  `secrets`,', '')
        .replace('`gate-integrity`, `wiring`, `secrets`,', '`gate-integrity`,'),
      manifest: { harnessVersion: '0.9.0', baseVersion: '0.7.0', files: {} },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /docs-sync: RAMP EXPIRED/)
  assert.match(r.out, /deadline of 0\.9\.0/)
})

test('RED: the same additive drift is LIVE on a fresh install — no legacy, no ramp', () => {
  const r = runGate(
    fixture({
      agents: shippedAgents
        .replace(/The (\d+) gates, in order:/, 'The 29 gates, in order:')
        .replace('`gate-integrity`, `wiring`, `secrets`,', '`gate-integrity`,'),
      manifest: { harnessVersion: '0.8.0', baseVersion: '0.8.0', files: {} },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('drifted from VALIDATE_STEPS'), r.out)
})

test('RED: a documented gate that NO LONGER EXISTS is the project\'s drift — never ramped', () => {
  // The sharp half. An invented or deleted step is not something `update` did, so it stays
  // a hard red at every vintage — otherwise the ramp would swallow the case the check is
  // actually for.
  const r = runGate(
    fixture({
      agents: shippedAgents.replace('`docs-sync`', '`docs-sync`, `imaginary-gate`'),
      manifest: { harnessVersion: '0.3.0', baseVersion: '0.2.1', files: {} },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('drifted from VALIDATE_STEPS'), r.out)
})

test('RED: REORDERED gates are the project\'s drift too — the chain order is the contract', () => {
  const swapped = shippedAgents.replace('`format`, `gate-integrity`,', '`gate-integrity`, `format`,')
  const r = runGate(
    fixture({ agents: swapped, manifest: { harnessVersion: '0.3.0', baseVersion: '0.2.1', files: {} } }),
  )
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

test('a catalog miss reds on ANY vintage — the gates-catalog lockstep is unconditional', () => {
  // 0.4.0 DELETED this ramp rather than expiring it: its minVersion sat below v0.1.3,
  // the oldest release this lineage ever tagged, so gate.mjs returned false at
  // `base >= minVersion` for every install that has ever existed. The old test proved
  // the NOTE path with a HYPOTHETICAL pre-lineage manifest — a path no consumer can
  // take. Inverted: the check is unconditional, so even that manifest is held.
  const renamed = shippedCatalog.replace(/^### (\d+)\. perf-budget — /m, '### $1. perf-fudget — ')

  // A hypothetical pre-lineage consumer (no baseVersion field — harnessVersion is the
  // fallback). It used to ride a NOTE; it is held now.
  const ramped = runGate(
    fixture({ agents: shippedAgents, catalog: renamed, manifest: { harnessVersion: '0.0.9', files: {} } }),
  )
  assert.equal(ramped.code, 1, ramped.out)
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

// ── the Stop floor joins the closure (0.7.0): every step frozen in
// tools/stop.floor.json except `validate` needs its UNNUMBERED `### <name> — `
// section in the catalog. The universe is the FLOOR, deliberately not the live
// config's STOP_HOOK_STEPS — a consumer may APPEND steps, and documenting those
// is the consumer's business; the harness documents what the harness ships. ──

test('RED: a catalog missing the reviewer-verdicts heading reds naming the Stop-floor step', () => {
  // The motivating case: the newest, most novel control in the chain was the only
  // member with no documented way to watch it fail. The renamed heading also pins the
  // ONE-DIRECTIONAL membership: 'reviewer-verdicts-renamed' enters the catalog's
  // unnumbered set and satisfies nothing, because no floor step carries that name.
  const gutted = shippedCatalog.replace(
    /^### reviewer-verdicts — .*$/m,
    '### reviewer-verdicts-renamed — `node tools/check-reviewer-verdicts.mjs`',
  )
  assert.notEqual(gutted, shippedCatalog, 'fixture must actually remove the heading')
  const r = runGate(fixture({ agents: shippedAgents, catalog: gutted }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("Stop-floor step 'reviewer-verdicts' has no section"), r.out)
})

test("RED: deleting ANY Stop-floor step's heading reds — name-keyed, never command-keyed", () => {
  // mobile-unit is the deliberate second subject: its real heading PARAPHRASES its
  // command (jest-expo, not the pnpm invocation), so a command-keyed grammar would
  // have redded the accurate shipped catalog. The NAME is the key.
  for (const name of ['duplication', 'mobile-unit']) {
    const gutted = shippedCatalog.replace(new RegExp(`^### ${name} — `, 'm'), `### ex-${name} — `)
    assert.notEqual(gutted, shippedCatalog, `the ${name} heading must be found`)
    const r = runGate(fixture({ agents: shippedAgents, catalog: gutted }))
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.includes(`Stop-floor step '${name}' has no section`), r.out)
  }
})

test('GREEN: a consumer-APPENDED config-only Stop step needs no harness doc — the closure is floor-scoped', () => {
  const dir = fixture({ agents: shippedAgents })
  const cfg = join(dir, 'tools/harness.config.mjs')
  const appended = readFileSync(cfg, 'utf8').replace(
    "  ['reviewer-verdicts', 'node tools/check-reviewer-verdicts.mjs'],\n]",
    "  ['reviewer-verdicts', 'node tools/check-reviewer-verdicts.mjs'],\n  ['consumer-smoke', 'node tools/consumer-smoke.mjs'],\n]",
  )
  assert.ok(appended.includes('consumer-smoke'), 'the fixture must actually append a Stop step')
  writeFileSync(cfg, appended)
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
})

test('the validate-runner heading is INERT: not required, and unable to satisfy the closure', () => {
  // `validate` is excluded from the Stop-floor closure — its documentation IS the
  // numbered chain sections plus the runner note — so the shipped catalog carries no
  // unnumbered `### validate — ` heading, and green above proves the exclusion is
  // real rather than satisfied by an accident of grammar...
  assert.doesNotMatch(shippedCatalog, /^### validate — /m)
  // ...and deleting the runner note changes nothing: "the validate runner" is not a
  // step name, so the heading never enters the closure's set in either direction.
  const gone = shippedCatalog.replace(/^### the validate runner — .*$/m, '')
  assert.notEqual(gone, shippedCatalog, 'fixture must actually remove the runner note')
  const r = runGate(fixture({ agents: shippedAgents, catalog: gone }))
  assert.equal(r.code, 0, r.out)
})

// ── agent roster: "read-only by construction" is machine-asserted.
// The GREEN baseline above already proves the SHIPPED roster parses clean —
// fixture() copies the real .claude/agents in by default. Deliberately no ramp
// cases: the roster is harness-owned, so it refreshes with the gate. ──

function shippedAgent(name) {
  return readFileSync(join(ROSTER_TEMPLATE, name), 'utf8')
}

test('GREEN: the shipped roster passes and the summary counts every reviewer', () => {
  const r = runGate(fixture({ agents: shippedAgents }))
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('8/8 reviewers read-only'), r.out)
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
  assert.ok(r.out.includes('12 agent(s) parsed'), r.out)
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

// ---- the enforcement-tiers shape (0.4.0) ----------------------------------------
//
// This half of the gate shipped in 0.3.0 with NO can-fail proof, and 0.4.0 found out why
// that matters: adding a `Gate` column to the table took the positional parser from six
// cells to zero rows, so the file that declares every one-surface gate read as declaring
// nothing — and the `Compensated by` liveness assertion beneath it silently stopped
// running. A gate whose parser can be defeated by a column is a gate with a lockstep
// nobody wrote down. It is read BY COLUMN NAME now, and these are the proofs.

const TIERS_TEMPLATE = fileURLToPath(
  new URL('../../template/base/docs/harness/enforcement-tiers.md', import.meta.url),
)
const shippedTiers = readFileSync(TIERS_TEMPLATE, 'utf8')

const WORKFLOW_TEMPLATE = fileURLToPath(
  new URL('../../template/base/github/workflows/quality-gate.yml', import.meta.url),
)
const WORKFLOW_DIR = fileURLToPath(
  new URL('../../template/base/github/workflows', import.meta.url),
)
const SECURITY_DOCS = fileURLToPath(new URL('../../template/base/docs/security', import.meta.url))

/**
 * The fixture plus a tiers file, at a baseVersion where the 0.3.0 ramp is INERT.
 * The shipped workflow comes too: half the table's compensating controls are CI JOBS
 * (`web-e2e`), not chain steps, so a fixture without it would red every one of them and
 * the green case could only be made to pass by weakening the assertion.
 *
 * `allTools` and `allWorkflows` (0.5.0) exist because the two new controls read things the
 * minimal fixture does not carry. The Target check re-derives which gates still hard-code
 * one product surface, which needs the real `tools/` — with only three scripts present it
 * would find nothing single-surface and discharge every Target VACUOUSLY, which is the
 * failure shape these tests are for. `harness` overrides the install's harnessVersion,
 * which is what a Target date is measured against.
 */
function tiersFixture(tiers, { allTools = false, allWorkflows = false, harness = '0.4.0' } = {}) {
  const dir = fixture({
    agents: shippedAgents,
    manifest: harness === null ? undefined : { baseVersion: '0.4.0', harnessVersion: harness },
  })
  mkdirSync(join(dir, 'docs/harness'), { recursive: true })
  mkdirSync(join(dir, '.github/workflows'), { recursive: true })
  if (allTools) {
    cpSync(TOOLS, join(dir, 'tools'), { recursive: true })
    // The full tools/ brings approved-tools.json and doctrine-symbols.json, which arm two
    // OTHER sections of this gate. Their docs come with them, or these tests would red on
    // a finding that has nothing to do with tiers — and a test that fails for the wrong
    // reason teaches the reader to distrust the right ones.
    mkdirSync(join(dir, 'docs/security'), { recursive: true })
    cpSync(SECURITY_DOCS, join(dir, 'docs/security'), { recursive: true })
  }
  if (allWorkflows) cpSync(WORKFLOW_DIR, join(dir, '.github/workflows'), { recursive: true })
  else cpSync(WORKFLOW_TEMPLATE, join(dir, '.github/workflows/quality-gate.yml'))
  if (tiers !== null) writeFileSync(join(dir, 'docs/harness/enforcement-tiers.md'), tiers)
  return dir
}

test('TIERS GREEN: the SHIPPED table parses and every compensating control is live', () => {
  // The regression that motivated the rewrite. If this reds, the shipped table and the
  // parser have drifted apart again — and the symptom is "declares nothing", not a diff.
  const r = runGate(tiersFixture(shippedTiers))
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /enforcement tier\(s\) declared over \d+ workflow\(s\); every compensating control live/)
  assert.doesNotMatch(r.out, /no parseable tier rows/, r.out)
})

test('TIERS: the row count is REAL — the summary counts what the table actually declares', () => {
  // Anti-vacuity in the other direction: a parser that finds rows but not the right ones
  // would still print a clean summary. Pin the count to the shipped file's own data rows.
  const expected = shippedTiers
    .split('\n')
    .filter((l) => /^\|/.test(l) && !/^\|\s*-+/.test(l) && !/^\|\s*Gate\s*\|/.test(l)).length
  const r = runGate(tiersFixture(shippedTiers))
  assert.match(r.out, new RegExp(`${String(expected)} enforcement tier\\(s\\) declared`), r.out)
})

test('TIERS RED: a table with no header row declares nothing, however many rows follow', () => {
  const headerless = shippedTiers.replace(/^\| Gate \| Layer \|.*$/m, '| A | B | C | D | E | F |')
  const r = runGate(tiersFixture(headerless))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /no header row carrying every required column/)
})

test('TIERS RED: a RENAMED heading unbinds the facts beneath it', () => {
  // The exact failure the positional parser could not see: the cells are all still there,
  // in order, and the column they belong to no longer says what it is.
  const renamed = shippedTiers.replace('| Compensated by |', '| Mitigation |')
  const r = runGate(tiersFixture(renamed))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /'Compensated by'/)
})

test('TIERS RED: a compensating control that is not a live step or job is not a control', () => {
  const bogus = shippedTiers.replace(
    /^\| `unit` \|.*$/m,
    '| `unit` | vitest | packages | apps/web/app | because | `no-such-step` | — |',
  )
  const r = runGate(tiersFixture(bogus))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /no-such-step/)
  assert.match(r.out, /A compensating control nobody runs is not a control/)
})

test('TIERS RED: an empty cell is a tier declared without one of its facts', () => {
  const blank = shippedTiers.replace(
    /^\| `unit` \|.*$/m,
    '| `unit` | vitest | packages |  | because | — | — |',
  )
  const r = runGate(tiersFixture(blank))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /empty 'Does NOT cover' cell/)
})

// ── `Target` becomes a control, and `Compensated by` stops overstating (0.5.0) ────────

test('TIERS: the shipped table is GREEN at 0.5.0 — the deferred rows are not yet due', () => {
  // The other half of the deferral being honest: moving i18n and route-manifest to 0.6.0
  // buys exactly one release, and this pins that it buys only one.
  const r = runGate(tiersFixture(shippedTiers, { allTools: true, allWorkflows: true, harness: '0.5.0' }))
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /every arrived Target discharged/)
})

test('TIERS: BOTH 0.6.0 commitments are discharged — the shipped table is green AT 0.6.0', () => {
  // THIS TEST WAS A MUST-RED, AND ITS SUBJECT GOT FIXED — twice, in one release. Through
  // 0.5.0 it asserted that `i18n` and `route-manifest` both red at harness 0.6.0, which is
  // what made those deferrals commitments rather than a way to buy a green release. 0.6.0
  // paid both: `i18n` is surface-parameterised (`SURFACES` in check-i18n.mjs) and the
  // `route-manifest` STEP now runs check-web-routes.mjs beside check-route-manifest.mjs.
  //
  // So the assertion inverts, and it has to invert in the same diff that closes the gaps —
  // a must-red test left asserting a fixed defect is a test that reds on the fix. The
  // control itself is unchanged and still proven, by the two tests below: one re-dates a
  // discharged row and watches it red, the other holds a genuinely single-surface gate to an
  // arrived date. What is gone is only the harness's own outstanding debt.
  const r = runGate(tiersFixture(shippedTiers, { allTools: true, allWorkflows: true, harness: '0.6.0' }))
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /every arrived Target discharged/)
  assert.doesNotMatch(r.out, /gate `i18n`/)
  assert.doesNotMatch(r.out, /gate `route-manifest`/)
})

test('TIERS: the 0.8.0 commitment discharges through its PROBE — the vacuous-surface trap, closed', () => {
  // THE TRAP THIS RELEASE FOUND AND CLOSED. The observability row's Target (0.8.0) was
  // declared at 0.7.0 while the gate did not exist — and the surface-derivation discharge
  // form asks whether the gate "still scans one product surface": a gate that is NOT in the
  // derived set discharges, and a NONEXISTENT gate is never in the set. Had the date
  // arrived on the 0.7.0-shaped row, it would have discharged VACUOUSLY — a machine-held
  // commitment self-satisfying with nothing shipped. The shipped row now carries the
  // `closes:` probe (`tools/observability.json#vendorSpecifiers`), so the discharge rests
  // on the shipped register and the gate reading it, re-derived every run.
  const r = runGate(
    tiersFixture(shippedTiers, { allTools: true, allWorkflows: true, harness: '0.8.0' }),
  )
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /every arrived Target discharged/)
  assert.doesNotMatch(r.out, /gate `observability`/)

  // And the probe is LIVE, not decoration: empty the record it names and the same run
  // reds naming the missing half — the discharge cannot survive the register it rests on.
  const broken = tiersFixture(shippedTiers, {
    allTools: true,
    allWorkflows: true,
    harness: '0.8.0',
  })
  const registerPath = join(broken, 'tools/observability.json')
  const register = JSON.parse(readFileSync(registerPath, 'utf8'))
  register.vendorSpecifiers = []
  writeFileSync(registerPath, JSON.stringify(register, null, 2))
  const red = runGate(broken)
  assert.equal(red.code, 1, red.out)
  assert.match(red.out, /carries no non-empty value at top-level key 'vendorSpecifiers'/)
})

test('TIERS RED: an ARRIVED Target on a still-single-surface gate reds', () => {
  // THE CONTROL, proven against a gate that really is single-surface rather than against
  // the harness's own debt — which is what keeps this test meaningful now that the debt is
  // paid. `perf-budget` scans apps/mobile only and says so with `Target —`; re-dating it to
  // a release that has arrived must red.
  const due = shippedTiers.replace(/^(\| `perf-budget` \|.*)\| — \|$/m, '$1| 0.6.0 |')
  assert.notEqual(due, shippedTiers, 'the perf-budget row must be found for this test to mean anything')
  const r = runGate(tiersFixture(due, { allTools: true, allWorkflows: true, harness: '0.6.0' }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /committed to closing its gap in 0\.6\.0 and this install runs harness 0\.6\.0/)
  assert.match(r.out, /gate `perf-budget`/)
  // The rows that carry `Target —` mean "no other half is owed" and must NOT red: a draft of
  // this check treated the em dash as a missing commitment and reddened all of them.
  assert.doesNotMatch(r.out, /gate `expo-policy`/)
  assert.doesNotMatch(r.out, /gate `native-deps`/)
})

test('TIERS: the TWIN-SCRIPT step discharges — a fold over the step, not the script', () => {
  // 0.6.0's derivation fix, asserted where it matters. `route-manifest` runs TWO scripts and
  // each is single-surface; the STEP covers both, and a tier row names a step. Before the
  // fold this row could never have discharged no matter what shipped, because the mobile
  // script would have kept it in the single-surface set forever — a control demanding a
  // change that no change could satisfy.
  const due = shippedTiers.replace(/^(\| `route-manifest` \|.*)\| — \|$/m, '$1| 0.6.0 |')
  assert.notEqual(due, shippedTiers, 'the route-manifest row must be found for this test to mean anything')
  const r = runGate(tiersFixture(due, { allTools: true, allWorkflows: true, harness: '0.6.0' }))
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /gate `route-manifest`/)
})

test('TIERS: a Target DISCHARGES when the gate stops being single-surface', () => {
  // `build` is the worked example: 0.5.0 gave build-check.mjs a `--web` mode over the
  // `.next` client chunks, so it is no longer single-surface and its Target became `—`.
  // Re-dating a row it can still discharge would be the loophole; re-deriving from the
  // gate SOURCE is what closes it.
  const due = shippedTiers.replace(/^(\| `build` \|.*)\| — \|$/m, '$1| 0.1.3 |')
  assert.notEqual(due, shippedTiers, 'the build row must be found for this test to mean anything')
  const r = runGate(tiersFixture(due, { allTools: true, allWorkflows: true, harness: '0.6.0' }))
  assert.doesNotMatch(r.out, /gate `build`/, r.out)
})

test('TIERS RED: a Target that is not a version and not an em dash is a deadline with no date', () => {
  const vague = shippedTiers.replace(/^(\| `unit` \|.*)\| — \|$/m, '$1| soon |')
  const r = runGate(tiersFixture(vague, { allTools: true, allWorkflows: true, harness: '0.5.0' }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /Target is "soon"/)
})

test('TIERS: with NO manifest the Target check SAYS it is not judging, rather than passing silently', () => {
  // The template dev tree and every gate fixture have no .harness/manifest.json, so there
  // is no installed release to measure a date against. Defined rather than inherited: a
  // silent pass would leave Targets unenforced in exactly the tree the harness's own
  // maintainers work in, which is where the three stale ones were written.
  const r = runGate(tiersFixture(shippedTiers, { allTools: true, allWorkflows: true, harness: null }))
  assert.match(r.out, /no \.harness\/manifest\.json, so `Target` dates .* are not judged/)
})

// ── the SECOND discharge form (0.7.0): the declared `closes:` probe ──────────────────
//
// The surface derivation can only discharge a Target whose gap is "the gate scans one
// product surface". A row whose declared gap is a reviewed-data floor (version-sync's
// iOS toolchain) would stand red forever after shipping the floor — a control demanding
// a change no change can satisfy, the same defect the 0.6.0 step-fold fixed for
// twin-script steps. The declared form lets the row name its own evidence:
// `0.7.0 — closes: `tools/store-policy.json#iosToolchain`` discharges iff the record
// carries a non-empty value at the key AND a script implementing the row's step
// references the key on a non-comment line. `perf-budget` is the deliberate subject
// throughout: it is GENUINELY single-surface (the arrived-Target red above proves
// exactly that), so a probe-form green is proof the probe REPLACED the surface
// derivation rather than riding it.

const PROBE_CELL = '0.6.0 — closes: `tools/probe-policy.json#probeDischargeKey`'
const PROBE_REF = "\nconst PROBE_POLICY_KEY = 'probeDischargeKey'\nvoid PROBE_POLICY_KEY\n"

/**
 * Plant a probe-form Target on the perf-budget row, plus (optionally) the JSON record
 * the probe names and a reference to the key inside the step's own gate script.
 * @param {{ cell?: string, record?: object, reference?: string }} parts
 */
function probeFixture({ cell = PROBE_CELL, record, reference } = {}) {
  const probed = shippedTiers.replace(/^(\| `perf-budget` \|.*)\| — \|$/m, `$1| ${cell} |`)
  assert.notEqual(probed, shippedTiers, 'the perf-budget row must be found for the probe fixtures to mean anything')
  const dir = tiersFixture(probed, { allTools: true, allWorkflows: true, harness: '0.6.0' })
  if (record !== undefined) writeFileSync(join(dir, 'tools/probe-policy.json'), JSON.stringify(record))
  if (reference !== undefined) appendFileSync(join(dir, 'tools/check-perf-budget.mjs'), reference)
  return dir
}

test('TIERS PROBE: an arrived, SATISFIED probe discharges a still-single-surface gate', () => {
  const r = runGate(probeFixture({ record: { probeDischargeKey: { xcodeFloor: 26 } }, reference: PROBE_REF }))
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /every arrived Target discharged/)
  // The sharp half: perf-budget still hard-codes one surface, so the surface form would
  // red this row (the arrived-Target test above proves it). Green means the probe governed.
  assert.doesNotMatch(r.out, /STILL scans one product surface/, r.out)
})

test('TIERS PROBE RED: an arrived probe with no record — key absent, or file absent — cannot discharge', () => {
  const noKey = runGate(probeFixture({ record: {}, reference: PROBE_REF }))
  assert.equal(noKey.code, 1, noKey.out)
  assert.match(noKey.out, /carries no non-empty value at top-level key 'probeDischargeKey'/)

  const noFile = runGate(probeFixture({ reference: PROBE_REF }))
  assert.equal(noFile.code, 1, noFile.out)
  assert.match(noFile.out, /tools\/probe-policy\.json does not exist/)
})

test('TIERS PROBE RED: a key NO step script reads cannot discharge — comment mentions do not count', () => {
  // The record is present and non-empty; nothing under tools/ references the key.
  const unread = runGate(probeFixture({ record: { probeDischargeKey: { xcodeFloor: 26 } } }))
  assert.equal(unread.code, 1, unread.out)
  assert.match(unread.out, /no script implementing the row's step .* references 'probeDischargeKey' on a non-comment line/)

  // A comment-only mention is not a reference — a key a gate merely talks about is a
  // record nothing enforces, which is the self-certification the reference check exists
  // to refuse.
  const commentOnly = runGate(
    probeFixture({
      record: { probeDischargeKey: { xcodeFloor: 26 } },
      reference: '\n// a later release will read probeDischargeKey from the policy file\n',
    }),
  )
  assert.equal(commentOnly.code, 1, commentOnly.out)
  assert.match(commentOnly.out, /on a non-comment line/)
})

test('TIERS PROBE: before the date arrives the probe is NOT judged — the deadline arms it', () => {
  // No record, no reference: the probe is UNSATISFIED, and still green — the probe is
  // the arrived-discharge question, not a standing lint. The date is what arms it, the
  // same way the surface form leaves an undue row alone.
  const r = runGate(probeFixture({ cell: '0.9.0 — closes: `tools/probe-policy.json#probeDischargeKey`' }))
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /every arrived Target discharged/)
})

test('TIERS PROBE RED: a malformed `closes:` annotation reds even before the date arrives', () => {
  // No backticked path — nothing can evaluate this, and waiting for the date would let a
  // typo sleep until the deadline and then fail the discharge for a clerical reason.
  const bare = runGate(probeFixture({ cell: '0.9.0 — closes: tools/probe-policy.json#probeDischargeKey' }))
  assert.equal(bare.code, 1, bare.out)
  assert.match(bare.out, /`closes:` annotation does not parse/)

  // A backticked path with no `#key` names a file but no record to look for.
  const keyless = runGate(probeFixture({ cell: '0.9.0 — closes: `tools/probe-policy.json`' }))
  assert.equal(keyless.code, 1, keyless.out)
  assert.match(keyless.out, /annotation does not parse/)
})

test('TIERS RED: an only-conditional compensating control must admit it is path-filtered', () => {
  // The critic's finding, mechanised. `web-e2e` is path-filtered, and summarize-gate.mjs
  // deliberately greens over a skipped lane after naming it — so a row whose ONLY
  // compensating control is that lane claims coverage on exactly the commits that did not
  // get it. Nine shipped rows were in that state.
  const overstated = shippedTiers.replace(
    /^(\| `perf-budget` \|.*)\| `web-e2e` \(path-filtered\) \| — \|$/m,
    '$1| `web-e2e` | — |',
  )
  assert.notEqual(overstated, shippedTiers, 'the perf-budget row must be found')
  const r = runGate(tiersFixture(overstated, { allTools: true, allWorkflows: true, harness: '0.5.0' }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /are CONDITIONAL jobs \(path- or event-filtered\)/)
  assert.match(r.out, /summarize-gate\.mjs greens over a skipped lane/)
})

test('TIERS: a control living in a NON-quality-gate workflow now resolves', () => {
  // Eight workflows ship and this resolved against one. A row compensated by `gitleaks`
  // (gitleaks.yml) or `analyze` (codeql.yml) named a real, blocking lane and was reported
  // as naming a control that does not exist.
  const elsewhere = shippedTiers.replace(
    /^(\| `duplication` \|.*)\| — \| — \|$/m,
    '$1| `gitleaks` | — |',
  )
  assert.notEqual(elsewhere, shippedTiers, 'the duplication row must be found')

  const all = runGate(tiersFixture(elsewhere, { allTools: true, allWorkflows: true, harness: '0.5.0' }))
  assert.equal(all.code, 0, all.out)

  // ...and the proof that the fixture is not simply lenient: with only quality-gate.yml
  // present, the same cell resolves to nothing, which is what every install saw until now.
  const one = runGate(tiersFixture(elsewhere, { allTools: true, harness: '0.5.0' }))
  assert.equal(one.code, 1, one.out)
  assert.match(one.out, /gitleaks/)
})

// ── the security doc's coverage claim tracks the gate it describes (0.5.0) ────────────

test('SANDBOX GREEN: the shipped doc names web-build, and the shipped gate has --web', () => {
  const dir = tiersFixture(shippedTiers, { allTools: true, allWorkflows: true, harness: '0.5.0' })
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /states the build gate's surfaces in lockstep .*\(web mode present\)/)
})

test('SANDBOX RED: a gate whose --web mode is deleted while the doc still describes it', () => {
  // The drift that shipped for two releases in the other direction: the doc claimed a
  // secret-exfiltration control the tree did not implement. A security reviewer reads the
  // doc, not the gate.
  const dir = tiersFixture(shippedTiers, { allTools: true, allWorkflows: true, harness: '0.5.0' })
  const gate = join(dir, 'tools/build-check.mjs')
  writeFileSync(gate, readFileSync(gate, 'utf8').replaceAll("'--web'", "'--disabled'"))
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /claims a secret-exfiltration control the tree does not implement/)
})

test('SANDBOX RED: a --web mode the doc never mentions understates a real control', () => {
  const dir = tiersFixture(shippedTiers, { allTools: true, allWorkflows: true, harness: '0.5.0' })
  const doc = join(dir, 'docs/security/sandbox-and-supply-chain.md')
  writeFileSync(doc, readFileSync(doc, 'utf8').replaceAll('web-build', 'some-other-lane'))
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /never names the `web-build` lane/)
})

// ── the deferral ledger (0.7.0): tools/deferrals.json + the dated-sentence scan ───────
//
// Prose in the OWNED surfaces makes dated promises ("Deferred to x.y.z", "out of scope
// for x.y.z"), and for a release three sites carried the SAME stale one — each internally
// consistent, none read by any machine, so the date rolled past while still reading as a
// plan. The scan closes sentence <-> ledger both ways over a DECLARED surface list
// (the catalog, the top-level tools/*.mjs, tools/auth-posture.json — enforcement-tiers.md
// excluded because its Target column has its own reader; SEEDED files excluded because a
// consumer's prose is not the harness's to red), and an ARRIVED target reds until the
// author ships the check or moves the date in a reviewed diff.

const shippedLedger = JSON.parse(
  readFileSync(join(TOOLS, 'deferrals.json'), 'utf8'),
)
const LONG_REASON =
  'A test-fixture deferral reason comfortably past the forty-character review floor.'

/**
 * A minimal fixture plus a planted scan subject: `sentence` becomes a consumer-style
 * tools/check-custom-lane.mjs (top-level tools/*.mjs ARE the declared surface, so a
 * consumer's own gate script is scanned — the residual-false-positive answer is rewording
 * to the ledger form, which is the behavior the control wants). `extraEntries` are
 * appended to the SHIPPED ledger rather than replacing it: the shipped catalog carries a
 * real dated sentence, and dropping its entry would red every case on the wrong subject.
 * @param {{ sentence?: string, extraEntries?: object[], manifest?: any, catalog?: any }} parts
 */
function deferralFixture({ sentence, extraEntries = [], manifest, catalog } = {}) {
  const dir = fixture({
    agents: shippedAgents,
    manifest,
    ...(catalog === undefined ? {} : { catalog }),
  })
  if (sentence !== undefined) writeFileSync(join(dir, 'tools/check-custom-lane.mjs'), sentence)
  if (extraEntries.length > 0) {
    writeFileSync(
      join(dir, 'tools/deferrals.json'),
      JSON.stringify({ deferrals: [...shippedLedger.deferrals, ...extraEntries] }),
    )
  }
  return dir
}

const LIVE_070 = { harnessVersion: '0.7.0', baseVersion: '0.7.0', files: {} }

test('DEFERRAL RED: an ARRIVED target reds naming the entry, both versions, and the two legitimate moves', () => {
  const r = runGate(
    deferralFixture({
      sentence: '// The custom scale census is deferred until 0.6.0.\n',
      extraEntries: [
        {
          id: 'custom-scale-census',
          file: 'tools/check-custom-lane.mjs',
          target: '0.6.0',
          reason: LONG_REASON,
          reviewedOn: '2026-08-08',
        },
      ],
      manifest: LIVE_070,
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /entry 'custom-scale-census' committed to 0\.6\.0 and this install runs harness 0\.7\.0/)
  assert.match(r.out, /has ARRIVED/)
  assert.match(r.out, /move the date to a release you mean in a reviewed diff/)
})

test('DEFERRAL GREEN: the same sentence with a FUTURE target is a ledgered plan, not a finding', () => {
  const r = runGate(
    deferralFixture({
      sentence: '// The custom scale census is deferred until 0.8.0.\n',
      extraEntries: [
        {
          id: 'custom-scale-census',
          file: 'tools/check-custom-lane.mjs',
          target: '0.8.0',
          reason: LONG_REASON,
          reviewedOn: '2026-08-08',
        },
      ],
      manifest: LIVE_070,
    }),
  )
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /dated deferral\(s\) ledgered over \d+ owned prose surface\(s\)/)
})

test('DEFERRAL RED: a dated sentence with NO ledger entry is a plan nothing reads', () => {
  const r = runGate(
    deferralFixture({
      sentence: '// This half is deferred to 0.9.0 pending the upstream fix.\n',
      manifest: LIVE_070,
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /tools\/check-custom-lane\.mjs:1 defers something to 0\.9\.0/)
  assert.match(r.out, /has no entry for this file at that target/)
})

test('DEFERRAL RED: a ledger entry whose file dropped the sentence is a second stale doctrine', () => {
  const r = runGate(
    deferralFixture({
      sentence: '// an ordinary comment with no dated promise in it\n',
      extraEntries: [
        {
          id: 'custom-scale-census',
          file: 'tools/check-custom-lane.mjs',
          target: '0.9.0',
          reason: LONG_REASON,
          reviewedOn: '2026-08-08',
        },
      ],
      manifest: LIVE_070,
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /entry 'custom-scale-census' says tools\/check-custom-lane\.mjs defers to 0\.9\.0/)
  assert.match(r.out, /no longer carries that dated sentence/)
})

test('DEFERRAL RED: a reason under 40 characters is not a review', () => {
  const r = runGate(
    deferralFixture({
      sentence: '// The custom scale census is deferred until 0.9.0.\n',
      extraEntries: [
        {
          id: 'custom-scale-census',
          file: 'tools/check-custom-lane.mjs',
          target: '0.9.0',
          reason: 'too short',
          reviewedOn: '2026-08-08',
        },
      ],
      manifest: LIVE_070,
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /'reason' must carry at least 40 characters/)
})

test('DEFERRAL: with NO manifest the arrival check SAYS it is not judging — the closure still runs', () => {
  // The template dev tree and every gate fixture: no .harness/manifest.json, so there is
  // no installed release to measure an arrival against. Defined rather than inherited,
  // exactly like the tiers Target NOTE — and the sentence<->ledger closure is NOT version
  // arithmetic, so it stays live: the stale-entry case must red even here.
  const quiet = runGate(deferralFixture({}))
  assert.equal(quiet.code, 0, quiet.out)
  assert.match(quiet.out, /deferral targets in tools\/deferrals\.json are not judged for arrival/)

  const stale = runGate(
    deferralFixture({
      sentence: '// an ordinary comment with no dated promise in it\n',
      extraEntries: [
        {
          id: 'custom-scale-census',
          file: 'tools/check-custom-lane.mjs',
          target: '0.9.0',
          reason: LONG_REASON,
          reviewedOn: '2026-08-08',
        },
      ],
    }),
  )
  assert.equal(stale.code, 1, stale.out)
  assert.match(stale.out, /no longer carries that dated sentence/)
})

test('DEFERRAL RAMP: findings are dated NOTEs on a pre-0.7.0 install, and the escape expires at 0.8.0', () => {
  // An install whose own tools/*.mjs carry dated prose gets one release to ledger or
  // re-word it rather than a red on the update that shipped the scanner.
  const noted = runGate(
    deferralFixture({
      sentence: '// This half is deferred to 0.9.0 pending the upstream fix.\n',
      manifest: { harnessVersion: '0.7.0', baseVersion: '0.6.0', files: {} },
    }),
  )
  assert.equal(noted.code, 0, noted.out)
  assert.ok(noted.out.includes('expires in 0.8.0'), `the NOTE must carry its deadline:\n${noted.out}`)
  assert.match(noted.out, /NOTE — \(ramp\).*has no entry for this file at that target/)

  // At harness 0.8.0 the escape is over: the same planted finding is a hard failure under
  // the RAMP EXPIRED banner. Planted, because the SHIPPED ledger no longer carries an
  // arrived date here — the census moved to 0.9.0 in the reviewed 0.8.0 diff — so the
  // expiry proof needs its own finding rather than riding the ledger's.
  const expired = runGate(
    deferralFixture({
      sentence: '// This half is deferred to 0.9.0 pending the upstream fix.\n',
      manifest: { harnessVersion: '0.8.0', baseVersion: '0.6.0', files: {} },
    }),
  )
  assert.equal(expired.code, 1, expired.out)
  assert.match(expired.out, /RAMP EXPIRED/)
  assert.match(expired.out, /has no entry for this file at that target/)

  // And the SHIPPED tree at 0.8.0, nothing planted, is GREEN — the move bought exactly
  // one release, which is what a date-move is for.
  const clean = runGate(
    deferralFixture({ manifest: { harnessVersion: '0.8.0', baseVersion: '0.8.0', files: {} } }),
  )
  assert.equal(clean.code, 0, clean.out)
})

test('DEFERRAL ARRIVAL: the shipped census target is a live tripwire, derived — never hardcoded', () => {
  // THE FACTORY-SIDE FORCING FUNCTION: the template dev tree has no manifest, so this test
  // IS the arrival enforcement for the shipped ledger (check-docs-sync.mjs says so in its
  // no-manifest NOTE). Deriving the target from the ledger keeps it self-updating at the
  // next move: whatever release the census commits to, an install running that release
  // reds until the census ships or the date moves again in a reviewed diff.
  const target = shippedLedger.deferrals.find((e) => e.id === 'auth-posture-cli-census').target
  const r = runGate(
    deferralFixture({ manifest: { harnessVersion: target, baseVersion: target, files: {} } }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, new RegExp(`entry 'auth-posture-cli-census' committed to ${target.replaceAll('.', '\\.')}`))
  assert.match(r.out, /has ARRIVED/)
})

test('DEFERRAL RED: re-freezing the old auth-posture sentence reds both directions of the closure', () => {
  // The anti-regression for the 0.7.0 prose sweep: the shipped catalog says the CLI census
  // is deferred with the LEDGER's target. Rewinding the sentence to the previous release's
  // date reds forward (a dated sentence at a target no entry carries) AND backward (the
  // entry's file no longer carries ITS sentence) — the sweep cannot quietly un-happen.
  const target = shippedLedger.deferrals.find((e) => e.id === 'auth-posture-cli-census').target
  const refrozen = shippedCatalog.replace(`Deferred to ${target}`, 'Deferred to 0.8.0')
  assert.notEqual(refrozen, shippedCatalog, 'the catalog must carry the ledgered sentence')
  const r = runGate(deferralFixture({ catalog: refrozen, manifest: LIVE_070 }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /docs\/harness\/gates-catalog\.md:\d+ defers something to 0\.8\.0/)
  assert.match(r.out, /no longer carries that dated sentence/)
})

// ── 0.9.5: agent-surface truth (3b budget honesty + 3c body closure, one ramp) ──────

test('RED: AGENTS.md whose own budget sentence is false reds LIVE on a fresh tree', () => {
  const lying = shippedAgents.replace('Keep under ~350 lines', 'Keep under ~10 lines')
  assert.notEqual(lying, shippedAgents, 'the shipped budget sentence must exist to falsify')
  const r = runGate(fixture({ agents: lying }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /claims "Keep under ~10 lines" but is \d+ lines/)
})

test('GREEN: deleting the budget sentence deletes the check — a fork may unbudget', () => {
  const unbudgeted = shippedAgents.replace(/Keep under ~\d+ lines\.?/, '')
  const r = runGate(fixture({ agents: unbudgeted }))
  assert.equal(r.code, 0, r.out)
})

test('RED: an agent body advertising a ghost pnpm script reds LIVE; NOTE under the 0.9.5 ramp', () => {
  const files = {
    '.claude/rules/extra.md': 'Run `pnpm ghost-script` before every turn.\n',
  }
  const live = runGate(fixture({ agents: shippedAgents, files }))
  assert.equal(live.code, 1, live.out)
  assert.ok(live.out.includes('`pnpm ghost-script`'), live.out)

  const ramped = runGate(
    fixture({
      agents: shippedAgents,
      files,
      manifest: { baseVersion: '0.9.0', harnessVersion: '0.9.5' },
    }),
  )
  assert.equal(ramped.code, 0, ramped.out)
  assert.ok(ramped.out.includes('NOTE') && ramped.out.includes('ghost-script'), ramped.out)
})

test('RED: a body pointing `node tools/absent.mjs` at nothing reds', () => {
  const files = {
    '.claude/skills/deploying/SKILL.md': 'Then run `node tools/absent.mjs --check`.\n',
  }
  const r = runGate(fixture({ agents: shippedAgents, files }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('node tools/absent.mjs') && r.out.includes('no such file'), r.out)
})

// ── 0.9.5: ADR content shape (3d, ramped until 0.11.0) ─────────────────────────────

const ADR_OK = `# 9999 — Fixture decision

- **Status:** Accepted
- **Date:** 2026-08-11

## Context

A fixture context long enough to clear the forty-character substance floor easily.

## Decision

A fixture decision long enough to clear the forty-character substance floor easily.

## Consequences

Fixture consequences long enough to clear the forty-character substance floor.

## Sources

- <https://www.postgresql.org/docs/current/ddl-rowsecurity.html> — backs the fixture.
`

test('GREEN: a well-shaped ADR passes; template and README stay exempt', () => {
  const files = {
    'docs/adr/29990101-fixture.md': ADR_OK,
    'docs/adr/0000-adr-template.md': '# template with no real sections\n',
    'docs/adr/README.md': '# index\n',
  }
  const r = runGate(fixture({ agents: shippedAgents, files }))
  assert.equal(r.code, 0, r.out)
})

test('RED: a sectionless ADR reds LIVE, naming every missing section', () => {
  const files = { 'docs/adr/29990101-hollow.md': '# hollow\n\n- **Status:** Accepted\n' }
  const r = runGate(fixture({ agents: shippedAgents, files }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('lacks a `## Context`'), r.out)
  assert.ok(r.out.includes('lacks a `## Sources`'), r.out)
})

test('RED: a heading with no substance reds — the empty file with extra steps', () => {
  const files = {
    'docs/adr/29990101-thin.md': ADR_OK.replace(
      /## Decision\n\nA fixture decision long enough to clear the forty-character substance floor easily\./,
      '## Decision\n\nTBD.',
    ),
  }
  const r = runGate(fixture({ agents: shippedAgents, files }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('`## Decision` body is under 40 characters'), r.out)
})

test('RED: no Status in the closed vocabulary; lowercase seeded form stays green', () => {
  const noStatus = runGate(
    fixture({
      agents: shippedAgents,
      files: { 'docs/adr/29990101-x.md': ADR_OK.replace('- **Status:** Accepted\n', '') },
    }),
  )
  assert.equal(noStatus.code, 1, noStatus.out)
  assert.ok(noStatus.out.includes('no `**Status:**` line'), noStatus.out)

  const seededForm = runGate(
    fixture({
      agents: shippedAgents,
      files: {
        'docs/adr/29990101-x.md': ADR_OK.replace(
          '- **Status:** Accepted',
          '**Status:** accepted · **Date:** 2026-08-11',
        ),
      },
    }),
  )
  assert.equal(seededForm.code, 0, seededForm.out)
})

test('RED: an unresolvable corpus id and an off-allowlist host both red', () => {
  const corpus = JSON.stringify([{ id: 'real/id' }])
  const badCorpus = runGate(
    fixture({
      agents: shippedAgents,
      files: {
        'tools/mcp/corpus/index.json': corpus,
        'docs/adr/29990101-x.md': ADR_OK.replace(
          '- <https://www.postgresql.org/docs/current/ddl-rowsecurity.html> — backs the fixture.',
          '- `[corpus: ghost/id]` — backs nothing.',
        ),
      },
    }),
  )
  assert.equal(badCorpus.code, 1, badCorpus.out)
  assert.ok(badCorpus.out.includes('[corpus: ghost/id]'), badCorpus.out)

  const badHost = runGate(
    fixture({
      agents: shippedAgents,
      files: {
        'docs/adr/29990101-x.md': ADR_OK.replace(
          'https://www.postgresql.org/docs/current/ddl-rowsecurity.html',
          'https://some-random-blog.example/post',
        ),
      },
    }),
  )
  assert.equal(badHost.code, 1, badHost.out)
  assert.ok(badHost.out.includes('some-random-blog.example'), badHost.out)
})

test('NOTE: ADR shape findings are advisory on a pre-0.9.5 install until 0.11.0', () => {
  const files = { 'docs/adr/29990101-hollow.md': '# hollow\n\n- **Status:** Accepted\n' }
  // harnessVersion stays below 0.10.0: at 0.10.0 the fixture would instead red on the
  // deferral ledger's ARRIVAL check (auth-posture-cli-census targets 0.10.0) — a
  // different gate concern this test must not entangle. Past 0.10.0 the agent-surface
  // ramp expires too; the ADR ramp alone runs to 0.11.0.
  const r = runGate(
    fixture({
      agents: shippedAgents,
      files,
      manifest: { baseVersion: '0.9.0', harnessVersion: '0.9.9' },
    }),
  )
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('NOTE') && r.out.includes('ADR shape'), r.out)
})
