#!/usr/bin/env node
// Gate: docs-sync — the agent-facing documentation can never lie about the gate.
//   1. CLAUDE.md stays a pure `@AGENTS.md` include (one canonical memory file).
//   2. The AGENTS.md gate list ("The N gates, in order: ...") matches
//      VALIDATE_STEPS exactly — names, order, and count — so an agent reading
//      the docs and an agent reading the config act on the same chain.
//   3. Every `pnpm <script>` command AGENTS.md tells agents to run exists in
//      the root package.json scripts.
//   4. Every VALIDATE_STEPS name has its own section in
//      docs/harness/gates-catalog.md — the catalog is the anti-vacuity record
//      (how to make each gate fail), so an undocumented gate is an untrusted
//      gate. Version-ramped: NOTE-only on installs whose baseVersion predates
//      the check (a consumer's custom step must not red the update that shipped
//      it) — in this lineage it ships in 0.1.0, so it is live from the first
//      install and on the template tree.
//   5. The agent roster matches the docs' claim: every .claude/agents/*.md
//      parses under the pinned frontmatter grammar (a parse failure is a RED,
//      never a skip) and carries name (== filename), description, and model;
//      the six reviewer agents hold ONLY read-only tools and disallow
//      Write + Edit — "read-only by construction" (README "The agent roster"),
//      machine-asserted. Deliberately NOT version-ramped: the agent files are
//      harness-OWNED, so the update that delivers this check refreshes the
//      roster with it — only a hand-widened reviewer reds, and that is the point.
// This makes the release-time "update the docs" sweep MECHANICAL: change the
// chain and this gate names exactly the lines to fix.
// SOURCE: docs/harness/README.md (docs-sync gate) [corpus: harness/doctrine]
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { VALIDATE_STEPS } from './harness.config.mjs'
import {
  parseFrontmatter,
  REVIEWER_AGENTS,
  REVIEWER_READONLY_TOOLS,
  splitList,
} from './lib/agent-roster.mjs'
import { fail, failures, ok, rampNote, skipOrFail } from './lib/gate.mjs'

const GATE = 'docs-sync'
const errs = []

if (!existsSync('AGENTS.md')) skipOrFail(GATE, 'AGENTS.md not found (no docs surface yet)')

// 1. CLAUDE.md purity.
if (existsSync('CLAUDE.md')) {
  if (readFileSync('CLAUDE.md', 'utf8').trim() !== '@AGENTS.md') {
    errs.push('CLAUDE.md is not a pure `@AGENTS.md` include — content belongs in AGENTS.md')
  }
} else {
  errs.push('CLAUDE.md missing — it must exist as a pure `@AGENTS.md` include')
}

const agents = readFileSync('AGENTS.md', 'utf8')
const stepNames = VALIDATE_STEPS.map(([name]) => name)

// 2. Gate list lockstep. The docs sentence is data: "The N gates, in order:
//    `a`, `b`, ..." — parse the backticked names between the marker and the
//    closing parenthetical/period.
const listMatch = agents.match(/The (\d+) gates, in order:([\s\S]*?)(?:\(|\.\s*$|\.\n)/m)
if (!listMatch) {
  errs.push('AGENTS.md is missing the "The N gates, in order: ..." sentence — document the chain')
} else {
  const documentedCount = Number(listMatch[1])
  const documented = [...listMatch[2].matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1])
  if (documentedCount !== stepNames.length) {
    errs.push(
      `AGENTS.md says "The ${String(documentedCount)} gates" but VALIDATE_STEPS has ${String(stepNames.length)} — update the count`,
    )
  }
  if (documented.join(',') !== stepNames.join(',')) {
    errs.push(
      `AGENTS.md gate list drifted from VALIDATE_STEPS.\n    documented: ${documented.join(', ')}\n    actual:     ${stepNames.join(', ')}`,
    )
  }
  const chainCount = agents.match(/the (\d+)-step chain/)
  if (chainCount && Number(chainCount[1]) !== stepNames.length) {
    errs.push(
      `AGENTS.md says "the ${chainCount[1]}-step chain" but VALIDATE_STEPS has ${String(stepNames.length)} steps`,
    )
  }
}

// 3. Advertised pnpm scripts exist. Only bare `pnpm <script>` invocations are
//    script names; exec/dlx/install/add/--filter forms are pnpm-native.
let scripts = {}
try {
  scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts ?? {}
} catch (e) {
  fail(GATE, `package.json unreadable (${e.message})`)
}
const PNPM_NATIVE = new Set(['exec', 'dlx', 'install', 'add', 'remove', 'run', 'update'])
const advertised = new Set(
  [...agents.matchAll(/`pnpm ([a-z0-9:_-]+)`?/g)]
    .map((m) => m[1])
    .filter((cmd) => !PNPM_NATIVE.has(cmd)),
)
for (const cmd of advertised) {
  if (!(cmd in scripts) && !(`harness:${cmd}` in scripts)) {
    errs.push(`AGENTS.md advertises \`pnpm ${cmd}\` but package.json has no such script`)
  }
}

// 4. Gates-catalog lockstep. Heading grammar, pinned to the catalog's actual
//    format: chain steps are the NUMBERED sections `### <n>. <name> — \`<cmd>\``.
//    The number is what distinguishes them from the catalog's other `###`
//    sections (Stop-hook suites, the validate-runner note, opt-in modules), so
//    those can never satisfy — or false-positive — this check.
const CATALOG = 'docs/harness/gates-catalog.md'
const catalogErrs = []
if (!existsSync(CATALOG)) {
  catalogErrs.push(`${CATALOG} missing — the harness ships it (owned; \`update\` restores it)`)
} else {
  const catalog = readFileSync(CATALOG, 'utf8')
  const sections = new Set([...catalog.matchAll(/^### \d+\. ([a-z0-9-]+) — /gm)].map((m) => m[1]))
  for (const name of stepNames) {
    if (!sections.has(name)) {
      catalogErrs.push(
        `gate '${name}' has no section in ${CATALOG} — add a numbered heading (### <n>. ${name} — \`<command>\`) with its anti-vacuity proof`,
      )
    }
  }
}
let catalogSummary = 'gates-catalog documents every step'
if (catalogErrs.length > 0) {
  // rampNote prints the graduation NOTE and returns true when this install's
  // baseVersion predates the check; the findings then surface as NOTEs so the
  // sweep is actionable without a red. Fresh installs / template tree: hard fail.
  if (
    rampNote(GATE, '0.1.0', 'gates-catalog lockstep (every chain step needs a catalog section)')
  ) {
    for (const e of catalogErrs) console.log(`${GATE}: NOTE — (ramp) ${e}`)
    catalogSummary = `gates-catalog lockstep NOTE-only (${String(catalogErrs.length)} finding(s) withheld by the pre-0.1.0 ramp)`
  } else {
    errs.push(...catalogErrs)
  }
}

// 5. Agent roster. Every roster file must parse (fail-open here would let a
//    malformed reviewer hide a write grant) and carry the universal fields;
//    the six reviewers may hold only read-only tools and must disallow
//    Write + Edit. Author agents keep their write tools — universal fields only.
const AGENTS_DIR = '.claude/agents'
const DOCTRINE = 'reviewers are read-only by construction (README "The agent roster")'
const rosterFiles = existsSync(AGENTS_DIR)
  ? readdirSync(AGENTS_DIR)
      .filter((f) => f.endsWith('.md'))
      .sort()
  : []
const rosterStems = new Set(rosterFiles.map((f) => f.slice(0, -3)))
for (const reviewer of REVIEWER_AGENTS) {
  if (!rosterStems.has(reviewer)) {
    errs.push(
      `${AGENTS_DIR}/${reviewer}.md: reviewer agent missing — the roster is harness-owned; run \`npx next-expo-supabase-agent-harness update\` to restore it`,
    )
  }
}
let reviewersChecked = 0
for (const file of rosterFiles) {
  const path = `${AGENTS_DIR}/${file}`
  const stem = file.slice(0, -3)
  const parsed = parseFrontmatter(readFileSync(path, 'utf8'))
  if (!parsed.ok) {
    errs.push(
      `${path}: frontmatter does not parse (${parsed.error}) — an unreadable roster fails CLOSED; the accepted grammar is pinned in tools/lib/agent-roster.mjs`,
    )
    continue
  }
  const fm = parsed.data
  for (const field of ['name', 'description', 'model']) {
    if (!fm[field]?.trim()) errs.push(`${path}: missing/empty frontmatter field '${field}'`)
  }
  if (fm.name?.trim() && fm.name.trim() !== stem) {
    errs.push(
      `${path}: name '${fm.name.trim()}' must match the filename ('${stem}') — the subagent's identity is its filename`,
    )
  }
  if (!REVIEWER_AGENTS.includes(stem)) continue
  reviewersChecked += 1
  if (!fm.tools?.trim()) {
    errs.push(
      `${path}: reviewer declares no 'tools' list — an absent list inherits EVERY tool; ${DOCTRINE}. Pin tools to a subset of: ${REVIEWER_READONLY_TOOLS.join(', ')}`,
    )
  } else {
    for (const tool of splitList(fm.tools)) {
      if (!REVIEWER_READONLY_TOOLS.includes(tool)) {
        errs.push(
          `${path}: reviewer granted '${tool}' — ${DOCTRINE}. Remove the grant; the read-only allowlist is: ${REVIEWER_READONLY_TOOLS.join(', ')}`,
        )
      }
    }
  }
  const disallowed = splitList(fm.disallowedTools ?? '')
  for (const t of ['Write', 'Edit']) {
    if (!disallowed.includes(t)) {
      errs.push(
        `${path}: reviewer 'disallowedTools' must include ${t} (belt-and-suspenders under the tools allowlist) — ${DOCTRINE}`,
      )
    }
  }
}

failures(GATE, errs)
ok(
  GATE,
  `AGENTS.md gate list in lockstep with the ${String(stepNames.length)}-step chain; CLAUDE.md pure; ${String(advertised.size)} advertised commands all exist; ${catalogSummary}; roster: ${String(rosterFiles.length)} agent(s) parsed, ${String(reviewersChecked)}/${String(REVIEWER_AGENTS.length)} reviewers read-only`,
)
