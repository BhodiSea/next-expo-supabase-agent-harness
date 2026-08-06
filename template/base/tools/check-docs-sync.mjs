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
//      the seven reviewer agents hold ONLY read-only tools and disallow
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
import { walkFiles } from './lib/fs-walk.mjs'
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
  const chainCount = agents.match(/the (\d+)-step chain/)
  const listErrs = []
  if (documentedCount !== stepNames.length) {
    listErrs.push(
      `AGENTS.md says "The ${String(documentedCount)} gates" but VALIDATE_STEPS has ${String(stepNames.length)} — update the count`,
    )
  }
  if (documented.join(',') !== stepNames.join(',')) {
    listErrs.push(
      `AGENTS.md gate list drifted from VALIDATE_STEPS.\n    documented: ${documented.join(', ')}\n    actual:     ${stepNames.join(', ')}`,
    )
  }
  if (chainCount && Number(chainCount[1]) !== stepNames.length) {
    listErrs.push(
      `AGENTS.md says "the ${chainCount[1]}-step chain" but VALIDATE_STEPS has ${String(stepNames.length)} steps`,
    )
  }

  // ADDITIVE DRIFT IS THE HARNESS'S DOING, NOT THE PROJECT'S — and the two must not be
  // reported the same way. Found by the upgrade lane (0.3.0), which is the whole reason
  // that lane exists: AGENTS.md is SEEDED, so `update` correctly never rewrites it, while
  // `migrations.json`'s configSteps injection DOES add steps to the chain. The consumer's
  // documented list is then one release behind through no act of theirs, and a hard red
  // here would be a gate ambushing an update — the exact failure the ramp doctrine names.
  //
  // The distinction is decidable: if every documented step still exists, in the same
  // relative order, the only difference is steps that were ADDED, and the person who added
  // them was the harness. Anything else — a documented step that no longer exists, a
  // reordering — is the project's own drift and stays a hard red at every vintage.
  const actualIndex = new Map(stepNames.map((n, i) => [n, i]))
  const positions = documented.map((n) => actualIndex.get(n))
  const additiveOnly =
    positions.every((p) => p !== undefined) &&
    positions.every((p, i) => i === 0 || p > positions[i - 1])
  if (listErrs.length > 0) {
    if (
      additiveOnly &&
      rampNote(GATE, '0.3.0', 'AGENTS.md gate-list lockstep after an injected chain step', {
        until: '0.5.0',
      })
    ) {
      for (const e of listErrs) console.log(`${GATE}: NOTE — (ramp) ${e}`)
      console.log(
        `${GATE}: NOTE — every documented gate still exists and the order holds, so this drift is steps the UPDATE injected. Paste the ${String(stepNames.length)} names above into AGENTS.md's "The N gates, in order:" sentence and the "N-step chain" line, then graduate.`,
      )
    } else {
      errs.push(...listErrs)
    }
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
  // 0.4.0 DELETED THIS RAMP rather than expiring it. Its minVersion sat below v0.1.3,
  // this lineage's oldest release, so gate.mjs returned false at `base >= minVersion` for
  // every install that has ever existed: the escape was never reachable and the check has
  // always been unconditional in practice. Removing the branch changes no behaviour on any
  // real tree — it deletes a deadline that could not arrive.
  // SOURCE: scripts/check-ramp-ledger.mjs (never-armed ramps)
  errs.push(...catalogErrs)
}

// 4b. THE TWO DOCS MUST AGREE ABOUT THE PLAN PROBE.
//
// README.md and gates-catalog.md both describe where query plans are judged, and for two
// releases they contradicted each other: the README said there is deliberately no EXPLAIN
// plan probe, while the catalog described one in detail — along with a capturing pg-proxy
// and a `0002_notes_keyset_idx.sql` that existed in neither tree. A reader who consulted
// one doc got the opposite answer from the other, and nothing could see it, because each
// file was internally consistent and neither claim was checked against the repo.
//
// Both halves of the real answer are true and must stay stated together: there is no plan
// assertion in the RLS suite (a plan over seed.sql's handful of rows is a planner opinion
// that would flap or pass for the wrong reason), AND the probe exists in the path-filtered
// db-scale lane where the cardinality is. So the closure is: while the probe SCRIPT exists,
// both documents must name it and name the lane that runs it. Delete the probe and the
// assertion lifts with it; delete the paragraph from either doc and this reds.
const PROBE = 'tools/check-db-perf.mjs'
const PROBE_LANE = 'db-scale'
const README = 'docs/harness/README.md'
if (existsSync(PROBE)) {
  for (const doc of [README, CATALOG]) {
    if (!existsSync(doc)) continue
    const text = readFileSync(doc, 'utf8')
    for (const needle of ['check-db-perf.mjs', PROBE_LANE]) {
      if (!text.includes(needle)) {
        errs.push(
          `${doc} does not mention '${needle}' while ${PROBE} exists — README.md and ${CATALOG} must agree about where query plans are judged. They once did not: one said there was deliberately no EXPLAIN probe while the other documented one, plus a pg-proxy and an index migration that were in no tree. Say both halves in both files: no plan assertion in the RLS suite (wrong cardinality), and the real probe in the path-filtered ${PROBE_LANE} lane.`,
        )
      }
    }
  }
}

// 5. Agent roster. Every roster file must parse (fail-open here would let a
//    malformed reviewer hide a write grant) and carry the universal fields;
//    the seven reviewers may hold only read-only tools and must disallow
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
  // A reviewer's OUTPUT CONTRACT, not just its permissions. The rest of this loop proves a
  // reviewer cannot write; this proves the main thread can tell what it decided. A bare
  // `PASS` — which six of the seven asked for before 0.2.0 — is unparseable: the word
  // occurs in prose, in a quoted requirement, in "PASS or FAIL", so a caller cannot
  // distinguish a verdict from a sentence about one, and neither could any future gate
  // that wanted to bind a merge to a review. The prefixed form is the whole point, and it
  // is asserted here because an agent file is prose that nothing else in the chain reads.
  const body = readFileSync(path, 'utf8')
  if (!/`VERDICT: PASS`\s+or\s+`VERDICT: BLOCK`/.test(body.replace(/\s+/g, ' '))) {
    errs.push(
      `${path}: reviewer does not require a machine-readable verdict — its instructions must end by demanding exactly one final line, \`VERDICT: PASS\` or \`VERDICT: BLOCK\`. A bare PASS/FAIL cannot be told apart from prose.`,
    )
  }
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

// 6. APPROVED-TOOLS LOCKSTEP — the doc is the rendered view of the data.
//
// docs/security/approved-tools.md declared "Default deny. No MCP server runs on this
// codebase unless it is listed below" for three releases while nothing read it: the
// PreToolUse matchers were `Bash` and `Edit|Write|MultiEdit`, so an `mcp__` call matched no
// hook. 0.3.0 moved the registry into tools/approved-tools.json and gave it a guard — which
// creates the failure this section exists to prevent: two registries, one read by a machine
// and one read by a human, drifting apart. A server approved in the doc but absent from the
// data is denied at call time with the doc saying it is approved; a server in the data but
// absent from the doc has reach nobody reviewed.
//
// The settings check is the third corner: `enabledMcpjsonServers` is what actually starts a
// server. An entry there with no registry record is a server this project launches and then
// denies on its first call — a broken configuration, not a security hole, and worth naming
// as such.
const REGISTRY = 'tools/approved-tools.json'
const TOOLS_DOC = 'docs/security/approved-tools.md'
let mcpSummary = `${REGISTRY} absent (pre-0.3.0 install)`
if (existsSync(REGISTRY)) {
  const mcpErrs = []
  let registered = new Set()
  try {
    const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'))
    if (!Array.isArray(registry.servers)) {
      mcpErrs.push(`${REGISTRY} has no \`servers\` array — the MCP guard fails closed without it`)
    } else {
      registered = new Set(registry.servers.map((s) => s?.server).filter(Boolean))
      for (const row of registry.servers) {
        for (const field of ['server', 'version', 'reason']) {
          if (typeof row?.[field] !== 'string' || !row[field].trim()) {
            mcpErrs.push(
              `${REGISTRY}: server ${JSON.stringify(row?.server ?? '?')} is missing '${field}' — an unpinned, unreasoned approval is not a review`,
            )
          }
        }
        if (typeof row?.readOnly !== 'boolean') {
          mcpErrs.push(
            `${REGISTRY}: server ${JSON.stringify(row?.server ?? '?')} must declare readOnly as a boolean — the guard treats anything but an explicit \`false\` as read-only, so leaving it out reads as a decision nobody made`,
          )
        }
      }
    }
  } catch (e) {
    mcpErrs.push(`${REGISTRY} is not valid JSON (${e.message}) — restore it from git history`)
  }

  if (existsSync(TOOLS_DOC)) {
    const doc = readFileSync(TOOLS_DOC, 'utf8')
    const documented = new Set([...doc.matchAll(/^\|\s*`([^`]+)`\s*\|\s*MCP\b/gm)].map((m) => m[1]))
    for (const s of registered) {
      if (!documented.has(s)) {
        mcpErrs.push(
          `${REGISTRY} approves MCP server '${s}' but ${TOOLS_DOC} has no row for it — the doc is the rendered view of the data, and reach nobody wrote down is reach nobody reviewed`,
        )
      }
    }
    for (const s of documented) {
      if (!registered.has(s)) {
        mcpErrs.push(
          `${TOOLS_DOC} lists MCP server '${s}' as approved but ${REGISTRY} has no record — the guard denies it on its first call, so the doc is telling a reader the opposite of what the machine does`,
        )
      }
    }
  } else {
    mcpErrs.push(`${TOOLS_DOC} missing — the harness ships it (owned; \`update\` restores it)`)
  }

  if (existsSync('.claude/settings.json')) {
    try {
      const enabled = JSON.parse(
        readFileSync('.claude/settings.json', 'utf8'),
      ).enabledMcpjsonServers
      for (const s of Array.isArray(enabled) ? enabled : []) {
        if (!registered.has(s)) {
          mcpErrs.push(
            `.claude/settings.json enables MCP server '${s}' but ${REGISTRY} has no record — this project starts a server it will deny on its first tool call`,
          )
        }
      }
    } catch {
      // settings.json parse failures are gate-integrity's finding, not this gate's
    }
  }

  mcpSummary = `${String(registered.size)} approved MCP server(s) in lockstep across ${REGISTRY}, ${TOOLS_DOC} and .claude/settings.json`
  if (mcpErrs.length > 0) {
    // Ramped: an install that hand-tuned its approved-tools doc must get a release to
    // reconcile it against the data file this release introduces, rather than a red on
    // the update that delivered both.
    if (rampNote(GATE, '0.3.0', 'approved-tools registry ↔ doc lockstep', { until: '0.5.0' })) {
      for (const e of mcpErrs) console.log(`${GATE}: NOTE — (ramp) ${e}`)
      mcpSummary = `approved-tools lockstep NOTE-only (${String(mcpErrs.length)} finding(s) withheld by the 0.3.0 ramp)`
    } else {
      errs.push(...mcpErrs)
    }
  }
}

// 7. THE DOCTRINE TOKEN MAP — the agent surface may not teach an API that does not exist.
//
// `packages/api/src/trpc.ts` exports `orgProcedure` and puts the resolved gate on `ctx.org`.
// Ten authoring surfaces taught `memberProcedure` / `ctx.member` — 13 and 7 occurrences,
// with ZERO occurrences of `orgProcedure` outside the module defining it. The slice
// scaffolder wrote a non-resolving import into every new slice, and `/verify-invariants`
// hunted for a `ctx.member` string that cannot appear in real code, so that review step was
// vacuous on every codebase it ever ran against.
//
// Eleven layers of enforcement could not see it, because every one of them judges CODE and
// this was a lie in the PROSE that tells an agent what code to write — read at the start of
// every turn, and producing a compile error that arrives in the consumer's tree with the
// harness's name on it.
//
// A CLOSED map over reviewed data, never an open identifier scanner: an open scan of the
// agent surface would produce a river of false positives from prose and be turned off
// within a release. Both directions are checked, and the backward one is the sharper: a map
// that outlives the module it describes is not a map, it is a second stale doctrine.
const SYMBOLS = 'tools/doctrine-symbols.json'
let doctrineSummary = `${SYMBOLS} absent (pre-0.3.0 install)`
if (existsSync(SYMBOLS)) {
  const doctrineErrs = []
  let map
  try {
    map = JSON.parse(readFileSync(SYMBOLS, 'utf8'))
  } catch (e) {
    doctrineErrs.push(`${SYMBOLS} is not valid JSON (${e.message}) — restore it from git history`)
  }
  const symbols = Array.isArray(map?.symbols) ? map.symbols : []
  const scope = (map?.scope ?? []).map((s) => new RegExp(s))
  if (map !== undefined && symbols.length === 0) {
    doctrineErrs.push(`${SYMBOLS} declares no symbols — an empty map judges nothing`)
  }

  // The agent surface: every file the scope patterns admit. `docs/adr/**` is deliberately
  // not in scope — an ADR that narrates the symbol it retired is honest history.
  const surface = walkFiles('.', {
    excludeDirs: new Set(['node_modules', '.git', '.harness', 'dist', 'gen', '.next', '.expo']),
    filter: (rel) => scope.some((re) => re.test(rel)),
  })

  for (const sym of symbols) {
    // FORWARD: the retired token must appear nowhere on the instructed surface.
    for (const file of surface) {
      const text = readFileSync(file, 'utf8')
      if (!text.includes(sym.retired)) continue
      const lines = text.split('\n')
      lines.forEach((line, i) => {
        if (!line.includes(sym.retired)) return
        doctrineErrs.push(
          `${file}:${String(i + 1)} teaches '${sym.retired}', which ${sym.definedIn} does not export — use '${sym.replacement}'. An agent reading this writes code that cannot compile, and the error arrives in the consumer's tree with the harness's name on it.`,
        )
      })
    }
    // BACKWARD: the replacement must still exist where the map says it does.
    if (typeof sym.definedIn === 'string' && existsSync(sym.definedIn)) {
      if (!readFileSync(sym.definedIn, 'utf8').includes(sym.replacement)) {
        doctrineErrs.push(
          `${SYMBOLS} says '${sym.replacement}' lives in ${sym.definedIn}, but that file no longer contains it. A token map that outlives its module is not a map — it is a second stale doctrine, which is the exact failure this check exists to end. Update the map in the same commit that renamed the symbol.`,
        )
      }
    }
  }

  doctrineSummary = `${String(symbols.length)} doctrine symbol(s) checked over ${String(surface.length)} agent-surface file(s)`
  if (doctrineErrs.length > 0) {
    // Ramped: an install whose agent surface was hand-tuned before this map existed gets a
    // release to converge, rather than a red on the update that shipped the map.
    if (rampNote(GATE, '0.3.0', 'doctrine token map over the agent surface', { until: '0.5.0' })) {
      for (const e of doctrineErrs) console.log(`${GATE}: NOTE — (ramp) ${e}`)
      doctrineSummary = `doctrine token map NOTE-only (${String(doctrineErrs.length)} finding(s) withheld by the 0.3.0 ramp)`
    } else {
      errs.push(...doctrineErrs)
    }
  }
}

// 8. ENFORCEMENT-TIERS SHAPE — a compensating control nobody runs is not a control.
//
// docs/harness/enforcement-tiers.md is the release's honest statement that several layers
// cover one product surface and not the other. A tier is legitimate; an undeclared tier the
// docs deny is not — and a DECLARED tier whose "compensated by" names something that does
// not run is the same failure wearing the table's clothes, which would make this file the
// easiest place in the repo to reintroduce exactly the class of claim it exists to delete.
//
// So the shape is checked, not the prose: every row carries all five fields, and every
// `Compensated by` cell resolves to a live chain step or a real quality-gate job.
const TIERS = 'docs/harness/enforcement-tiers.md'
let tiersSummary = `${TIERS} absent (pre-0.3.0 install)`
if (existsSync(TIERS)) {
  const tierErrs = []
  const doc = readFileSync(TIERS, 'utf8')
  // Read the HEADER, then index by column name.
  //
  // This was a positional parser: it took the first six cells of every six-cell row and
  // filtered the header by matching `| Layer |`. 0.4.0 added a leading `Gate` column — the
  // machine-readable key scripts/check-tier-coverage.mjs reads — and the parser's answer to
  // a seven-cell table was ZERO rows, which surfaced as "the file declares nothing" on
  // every fresh install. Two defects in one: a table that grew a column read as a table
  // that had been emptied, and the assertion it was supposed to make silently stopped
  // running. A positional reader over a documented table is a lockstep nobody declared, so
  // the fix is not "expect seven" — it is to stop counting and start naming.
  const cellsOf = (l) =>
    l
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim())
  const lines = doc.split('\n').filter((l) => /^\|/.test(l) && !/^\|\s*-+/.test(l))
  const headerLine = lines.find((l) => {
    const c = cellsOf(l)
    return c.includes('Layer') && c.includes('Covers') && c.includes('Compensated by')
  })
  const FIELDS = ['Layer', 'Covers', 'Does NOT cover', 'Why', 'Compensated by', 'Target']
  const header = headerLine === undefined ? [] : cellsOf(headerLine)
  const missing = FIELDS.filter((f) => !header.includes(f))
  const rows =
    headerLine === undefined
      ? []
      : lines.filter((l) => l !== headerLine).filter((l) => cellsOf(l).length === header.length)

  if (missing.length > 0) {
    tierErrs.push(
      `${TIERS}: no header row carrying every required column — missing ${missing.map((f) => `'${f}'`).join(', ')}. The table is read BY COLUMN NAME, so a renamed or dropped heading silently unbinds the facts beneath it.`,
    )
  } else if (rows.length === 0) {
    tierErrs.push(
      `${TIERS} has no parseable tier rows — the file exists but declares nothing, which reads as "there are no tiers". Every data row must carry the same number of cells as the header (${String(header.length)}). Restore it from git history.`,
    )
  }
  const colOf = new Map(FIELDS.map((f) => [f, header.indexOf(f)]))

  // Everything that can legitimately be named as a compensating control: a step this
  // install actually runs, or a job the shipped workflow actually defines.
  const live = new Set(stepNames)
  try {
    const { STOP_HOOK_STEPS } = await import('./harness.config.mjs')
    for (const [name] of STOP_HOOK_STEPS ?? []) live.add(name)
  } catch {
    // the gate-list check above already owns an unloadable config
  }
  const WORKFLOW = '.github/workflows/quality-gate.yml'
  if (existsSync(WORKFLOW)) {
    const wf = readFileSync(WORKFLOW, 'utf8')
    const jobsAt = wf.indexOf('\njobs:')
    if (jobsAt !== -1) {
      for (const m of wf.slice(jobsAt).matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)) live.add(m[1])
    }
  }

  for (const line of rows) {
    const cells = cellsOf(line)
    const at = (field) => cells[colOf.get(field) ?? -1] ?? ''
    const layer = at('Layer')
    const compensated = at('Compensated by')
    for (const field of FIELDS) {
      if (at(field) === '') {
        tierErrs.push(
          `${TIERS}: the '${layer || '(unnamed)'}' row has an empty '${field}' cell — a tier declared without one of its five facts is not a declaration. Use an em dash only where the field genuinely does not apply.`,
        )
      }
    }
    // `—` means "nothing stands in for this", which is a legitimate and honest answer.
    if (compensated === '' || compensated === '—' || compensated === '-') continue
    for (const name of [...compensated.matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1])) {
      if (!live.has(name)) {
        tierErrs.push(
          `${TIERS}: the '${layer}' row is compensated by \`${name}\`, which is neither a step in tools/harness.config.mjs nor a job in ${WORKFLOW}. A compensating control nobody runs is not a control — name a live one, or say — and raise the Target.`,
        )
      }
    }
  }

  tiersSummary = `${String(rows.length)} enforcement tier(s) declared, every compensating control live`
  if (tierErrs.length > 0) {
    if (rampNote(GATE, '0.3.0', 'enforcement-tiers shape check', { until: '0.5.0' })) {
      for (const e of tierErrs) console.log(`${GATE}: NOTE — (ramp) ${e}`)
      tiersSummary = `enforcement-tiers shape NOTE-only (${String(tierErrs.length)} finding(s) withheld by the 0.3.0 ramp)`
    } else {
      errs.push(...tierErrs)
    }
  }
}

failures(GATE, errs)
ok(
  GATE,
  `AGENTS.md gate list in lockstep with the ${String(stepNames.length)}-step chain; CLAUDE.md pure; ${String(advertised.size)} advertised commands all exist; ${catalogSummary}; roster: ${String(rosterFiles.length)} agent(s) parsed, ${String(reviewersChecked)}/${String(REVIEWER_AGENTS.length)} reviewers read-only; ${mcpSummary}; ${doctrineSummary}; ${tiersSummary}`,
)
