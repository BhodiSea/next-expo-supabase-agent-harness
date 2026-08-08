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
import {
  cmpDotted,
  fail,
  failures,
  installedHarnessVersion,
  ok,
  rampNote,
  skipOrFail,
} from './lib/gate.mjs'
import { liveControls, singleSurfaceGates } from './lib/live-controls.mjs'

const GATE = 'docs-sync'
const HARNESS_CONFIG = 'tools/harness.config.mjs'
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
  // THE RAMP IS RE-OPENED AT 0.6.0, and it had to be. The 0.3.0 ramp expired at 0.5.0, and
  // 0.6.0 injects `auth-posture` via configSteps — so on every existing install the chain grows
  // to 32 steps while AGENTS.md still says 31. AGENTS.md is SEEDED: `update` cannot rewrite a
  // project's memory file, so the consumer is the only one who can fix it, and hard-redding them
  // on an upgrade they did not ask for is precisely the ambush this mechanism exists to prevent.
  // The NOTE below tells them exactly what to paste. Expires at 0.7.0.
  //
  // The comment lives HERE and not inside the condition: scripts/check-ramp-ledger.mjs reads the
  // line preceding `rampNote(` to decide whether the result is consumed, and a comment between
  // `additiveOnly &&` and the call reads to it as a discarded result — a ramp that gates nothing.
  if (listErrs.length > 0) {
    if (
      additiveOnly &&
      rampNote(GATE, '0.6.0', 'AGENTS.md gate-list lockstep after an injected chain step', {
        until: '0.7.0',
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
  // `Gate` joined the list in 0.5.0, and its absence was not cosmetic: the column index map
  // is built from FIELDS, so `at('Gate')` resolved to the empty string and the new Target
  // check silently discharged every row — a control that passed because it could not find
  // the key it was judging. It is also a genuinely required field: it is the machine-readable
  // key scripts/check-tier-coverage.mjs matches rows on, so an empty one unbinds the row.
  const FIELDS = ['Gate', 'Layer', 'Covers', 'Does NOT cover', 'Why', 'Compensated by', 'Target']
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

  // ── `Target` becomes a control (0.5.0) ─────────────────────────────────────────
  //
  // The section above this table says Target "is a commitment, not a wish: the row stays
  // until the machinery lands". Three rows carried `Target: 0.5.0` and NOTHING read the
  // column, so the commitment was a sentence next to a date. A date nobody checks is the
  // exact shape of claim this file's own opening line calls illegitimate.
  //
  // WHAT "DISCHARGED" MEANS, mechanically. The gap a Target promises to close is, by
  // default, one gap: the gate hard-codes ONE product surface. So the question is re-derived
  // from the gate SOURCE — is it still single-surface? — using the identical derivation
  // scripts/check-tier-coverage.mjs uses to demand the row in the first place. Moving the
  // date is the other legitimate answer, and it is a reviewed diff in an owned, sha-pinned
  // file, which is what makes it deliberate rather than a flag. A row whose gap is NOT a
  // scan root may DECLARE its evidence instead — the `closes:` probe form below (0.7.0).
  const running = installedHarnessVersion(GATE)
  const configText = existsSync(HARNESS_CONFIG) ? readFileSync(HARNESS_CONFIG, 'utf8') : ''
  let stillSingleSurface = null
  if (running === null) {
    // The template dev tree and the gate fixtures have no .harness/manifest.json, so there
    // is no release to measure a deadline against. Defined rather than inherited: a silent
    // pass here would make every Target unenforced in exactly the tree the harness's own
    // maintainers run the gate in — which is where the stale Targets were written.
    console.log(
      `${GATE}: NOTE — no .harness/manifest.json, so \`Target\` dates in ${TIERS} are not judged (there is no installed release to compare them against). scripts/check-tier-coverage.mjs and tests/gates/check-docs-sync.test.mjs cover this table in the harness's own tree.`,
    )
  } else {
    try {
      stillSingleSurface = new Set(
        singleSurfaceGates({
          toolsDir: 'tools',
          // The config maps a script basename to the STEP name a row may key on
          // (`styleguide` runs check-styleguide-manifest.mjs), so without it a row keyed by
          // step would never match and its Target would discharge for the wrong reason.
          configText,
        }).flatMap((g) => [g.key, g.file.replace(/\.mjs$/, ''), g.file]),
      )
    } catch (e) {
      tierErrs.push(
        `${TIERS}: the Target check could not read tools/ to re-derive which gates are still single-surface (${String(e.message).slice(0, 120)}). It fails rather than skipping: an unreadable scan root would silently discharge every dated commitment in this table.`,
      )
    }
  }

  // ── the SECOND discharge form (0.7.0): the declared `closes:` probe ───────────────
  //
  // The surface derivation above can only discharge a Target whose gap is "the gate
  // scans one product surface". The version-sync row's declared gap is a toolchain
  // FLOOR: shipping the floor changes no scan root, so under the surface form its
  // arrived Target would stand red forever — a control demanding a change no change
  // can satisfy, the same defect the 0.6.0 step-fold in lib/live-controls.mjs fixed
  // for twin-script steps. So a Target cell may declare its own evidence instead:
  // `0.7.0 — closes: \`tools/store-policy.json#iosToolchain\`` discharges iff the
  // named file carries a non-empty value at that top-level key AND a script
  // implementing the row's step references the key on a non-comment line — both
  // re-derived from the tree on every run, never taken on trust.
  //
  // DIVISION OF LABOR, stated so a reviewer cannot mistake the probe for a proof of
  // enforcement: the reference check is a static read and can be satisfied by a line
  // that asserts nothing. That is the identical standard the surface form sets (see
  // lib/live-controls.mjs on what the step fold deliberately does not verify): this
  // table says which evidence a discharge rests on; the canary registry
  // (tests/canary/injections.json) is what proves the gate reading the key can
  // actually fail. Choosing the form — like moving a date — is a reviewed diff in
  // this owned, sha-pinned file, which is what makes it deliberate rather than a flag.

  // step -> the script basenames implementing it, read from the config's command text:
  // the IDENTICAL derivation singleSurfaceGates uses to key a row on its step, run in
  // the opposite direction. A second, different derivation here would let a row's step
  // resolve under one discharge form and not the other — the exact disagreement
  // lib/live-controls.mjs exists to prevent.
  const scriptsForStep = new Map()
  for (const m of configText.matchAll(/\[\s*'([\w-]+)'\s*,\s*'([^']*)'/g)) {
    for (const s of m[2].matchAll(/tools\/([\w.-]+\.mjs)/g)) {
      scriptsForStep.set(m[1], [...(scriptsForStep.get(m[1]) ?? []), s[1]])
    }
  }

  /**
   * The `closes:` annotation, parsed. null = no annotation (the surface form governs);
   * 'malformed' = an annotation nothing can evaluate, which is a red regardless of the
   * date — a probe with a typo would otherwise sleep until the deadline and then fail
   * the discharge for a clerical reason.
   * @param {string} t
   * @returns {null | 'malformed' | { file: string, key: string }}
   */
  const parseProbe = (t) => {
    if (!t.includes('closes:')) return null
    const m = /closes:\s*`([^`#]+)#([^`#\s]+)`/.exec(t)
    return m === null ? 'malformed' : { file: m[1], key: m[2] }
  }

  // A non-comment reference — the same `//`-strip the scan-root reader in
  // lib/live-controls.mjs applies, because a key a gate merely talks about in a comment
  // is a record nothing enforces.
  const referencesKey = (src, key) =>
    src.split('\n').some((line) => {
      const at = line.indexOf(key)
      return at !== -1 && !line.slice(0, at).includes('//') && !/^\s*\*/.test(line)
    })

  /**
   * An ARRIVED probe-form Target: discharged iff the record landed and the step's own
   * gate reads it. Every failure names the missing half — a probe that cannot be
   * evaluated reds rather than discharging, or the annotation is self-certification.
   * @param {{layer: string, key: string, due: string, probe: {file: string, key: string}}} row
   */
  const judgeProbeCell = ({ layer, key, due, probe }) => {
    const row = `the '${layer}' row (gate \`${key}\`) declares its discharge probe as \`${probe.file}#${probe.key}\` and its Target (${due}) has arrived`
    if (!existsSync(probe.file)) {
      return [
        `${TIERS}: ${row}, but ${probe.file} does not exist — a probe over a file the tree does not carry can never discharge. Ship the reviewed record, or move the Target to a release you mean in a reviewed diff.`,
      ]
    }
    let value
    try {
      value = JSON.parse(readFileSync(probe.file, 'utf8'))[probe.key]
    } catch (e) {
      return [
        `${TIERS}: ${row}, but ${probe.file} is not valid JSON (${e.message}) — an unreadable probe fails CLOSED rather than discharging the row. Restore the file from git history.`,
      ]
    }
    const empty =
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim() === '') ||
      (typeof value === 'object' && Object.keys(value).length === 0)
    if (empty) {
      return [
        `${TIERS}: ${row}, but ${probe.file} carries no non-empty value at top-level key '${probe.key}' — the reviewed record the probe promises has not landed. Land it, or move the Target to a release you mean in a reviewed diff.`,
      ]
    }
    const scripts =
      scriptsForStep.get(key) ??
      [key, `${key}.mjs`].filter((f) => f.endsWith('.mjs') && existsSync(`tools/${f}`))
    const read = scripts.some(
      (f) =>
        existsSync(`tools/${f}`) && referencesKey(readFileSync(`tools/${f}`, 'utf8'), probe.key),
    )
    if (!read) {
      return [
        `${TIERS}: ${row} and the record exists, but no script implementing the row's step (${scripts.length > 0 ? scripts.map((f) => `tools/${f}`).join(', ') : `none resolve from ${HARNESS_CONFIG}`}) references '${probe.key}' on a non-comment line — a key no gate reads is a record nothing enforces, so the probe cannot discharge the row. Wire the step's gate to the record, or move the Target in a reviewed diff.`,
      ]
    }
    return [] // discharged: the record landed and the step's own gate reads it
  }

  /** @param {{layer: string, target: string, gate: string}} row */
  const judgeTargetCell = ({ layer, target, gate }) => {
    if (stillSingleSurface === null) return []
    const t = target.trim()
    // `—` is a legitimate and honest answer: no web half is owed, and the Why cell carries
    // the reason. Six shipped rows say it. A draft of this check treated `—` as a missing
    // commitment and reddened all six, which would have been the control's first act.
    if (t === '' || t === '—' || t === '-') return []
    const due = /(\d+\.\d+\.\d+)/.exec(t)?.[1]
    if (due === undefined) {
      return [
        `${TIERS}: the '${layer}' row's Target is ${JSON.stringify(t)} — it must be a release (x.y.z) or \`—\`. A Target nothing can compare is a deadline with no date.`,
      ]
    }
    const probe = parseProbe(t)
    if (probe === 'malformed') {
      return [
        `${TIERS}: the '${layer}' row's Target is ${JSON.stringify(t)} — its \`closes:\` annotation does not parse. The declared discharge form is \`x.y.z — closes: \`<file>#<top-level key>\`\` (one backticked path, one \`#\`, one key), judged the moment it is written: a probe nothing can evaluate is a deadline with no date, the same failure as a Target of "soon".`,
      ]
    }
    if (cmpDotted(running, due) < 0) return [] // not yet due
    const key = gate.replaceAll('`', '').trim()
    // The declared form REPLACES the surface question for its row: the probe is the
    // discharge evidence the reviewed cell names, so the scan-root derivation — which
    // this row's gap was never about — must not get a vote either way.
    if (probe !== null) return judgeProbeCell({ layer, key, due, probe })
    if (!stillSingleSurface.has(key) && !stillSingleSurface.has(key.replace(/\.mjs$/, ''))) {
      return [] // the gap closed: the gate no longer hard-codes one surface
    }
    return [
      `${TIERS}: the '${layer}' row (gate \`${key}\`) committed to closing its gap in ${due} and this install runs harness ${running}, but the gate STILL scans one product surface. This table's own rule is that Target "is a commitment, not a wish". Close the gap, or move the Target to a release you mean in a reviewed diff — the file is harness-owned and sha-pinned, so moving it is a deliberate act rather than a flag.`,
    ]
  }

  // Everything that can legitimately be named as a compensating control: a step this
  // install actually runs, or a job ANY shipped workflow defines.
  //
  // 0.5.0 — ALL EIGHT WORKFLOWS, not one. This resolved against a single hard-coded
  // `.github/workflows/quality-gate.yml` while eight ship, so a row compensated by
  // `gitleaks`, `scan-pr` or `analyze` resolved to nothing and was reported as naming a
  // control that does not exist. It is the identical defect check-canary-coverage.mjs
  // corrected in 0.3.0, and the derivation is now shared with it (lib/live-controls.mjs)
  // rather than written a third time.
  const stopNames = await import('./harness.config.mjs')
    .then((m) => (m.STOP_HOOK_STEPS ?? []).map(([name]) => name))
    // the gate-list check above already owns an unloadable config
    .catch(() => [])
  const WORKFLOW_DIR = '.github/workflows'
  const { live, conditional, workflows } = liveControls({
    steps: [...stepNames, ...stopNames],
    workflowDir: WORKFLOW_DIR,
  })

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
    tierErrs.push(...judgeTargetCell({ layer, target: at('Target'), gate: at('Gate') }))
    // `—` means "nothing stands in for this", which is a legitimate and honest answer.
    if (compensated === '' || compensated === '—' || compensated === '-') continue
    // `[a-z0-9.-]+`, not `[a-z0-9-]+`: two rows name a gate SCRIPT (`check-e2e-device.mjs`)
    // rather than a step or a job, and the old pattern matched neither the dot nor the
    // extension — so those two cells resolved to the empty set and were exempt from both
    // rules below. An exemption nobody chose, in the one table whose subject is exactly
    // that. The `named.length > 0` guard below is what keeps a genuinely empty cell (`—`,
    // already skipped above) from being read as a violation.
    const named = [...compensated.matchAll(/`([a-z0-9][a-z0-9.-]*)`/g)].map((m) => m[1])
    for (const name of named) {
      if (!live.has(name)) {
        tierErrs.push(
          `${TIERS}: the '${layer}' row is compensated by \`${name}\`, which is neither a step in tools/harness.config.mjs nor a job in any workflow under ${WORKFLOW_DIR}/. A compensating control nobody runs is not a control — name a live one, or say — and raise the Target.`,
        )
      }
    }
    // "EXISTS" IS NOT "RAN" (0.5.0). `web-e2e` and `perf-lane` are path-filtered, and
    // tools/ci/summarize-gate.mjs deliberately greens over a skipped lane after naming it —
    // so a row whose only compensating control is a conditional job is claiming coverage on
    // exactly the commits that did not get it. A chain gate runs on a laptop and cannot ask
    // which lanes ran; what it can do is tell a conditional job from an unconditional one in
    // the workflow text and require the row to SAY so. `(path-filtered)` is that admission.
    if (
      named.length > 0 &&
      named.every((n) => conditional.has(n)) &&
      !/path-filtered/i.test(compensated)
    ) {
      tierErrs.push(
        `${TIERS}: the '${layer}' row's only compensating control(s) — ${named.map((n) => `\`${n}\``).join(', ')} — are CONDITIONAL jobs (path- or event-filtered), so they do not run on every commit, and summarize-gate.mjs greens over a skipped lane after naming it. The row currently claims coverage the commit may not have received. Either add an unconditional control, or write "(path-filtered)" in the cell so the qualification is in the table a reviewer reads.`,
      )
    }
  }

  tiersSummary = `${String(rows.length)} enforcement tier(s) declared over ${String(workflows)} workflow(s); every compensating control live, every conditional one declared conditional, every arrived Target discharged`
  if (tierErrs.length > 0) {
    if (rampNote(GATE, '0.3.0', 'enforcement-tiers shape check', { until: '0.5.0' })) {
      for (const e of tierErrs) console.log(`${GATE}: NOTE — (ramp) ${e}`)
      tiersSummary = `enforcement-tiers shape NOTE-only (${String(tierErrs.length)} finding(s) withheld by the 0.3.0 ramp)`
    } else {
      errs.push(...tierErrs)
    }
  }
}

// ── 7. the SECURITY doc's coverage claim tracks the gate it describes (0.5.0) ──────
//
// docs/security/sandbox-and-supply-chain.md said "the build gate greps the exported bundle
// for DSNs, keys, and secret-shaped strings" — with no qualification — while
// build-check.mjs was `const APP = 'apps/mobile'`. Two shipped documents contradicting each
// other about a secret-exfiltration control, and the one a security reviewer opens was the
// one that overstated. 0.5.0 gave the gate a `--web` mode and rewrote the bullet per
// surface; this is what stops the two drifting apart again.
//
// The rule is an IFF, because both halves are decidable from the tree: the doc names the
// `web-build` lane exactly when build-check.mjs actually has a web mode. HONEST LIMIT — it
// cannot judge PROSE. It can catch the doc describing a mode that was deleted and the mode
// existing with no doc; it cannot catch a paragraph that is merely badly worded.
const SANDBOX_DOC = 'docs/security/sandbox-and-supply-chain.md'
const BUILD_GATE = 'tools/build-check.mjs'
let sandboxSummary = `${SANDBOX_DOC} absent`
if (existsSync(SANDBOX_DOC) && existsSync(BUILD_GATE)) {
  const hasWebMode = readFileSync(BUILD_GATE, 'utf8').includes("'--web'")
  const claimsWeb = readFileSync(SANDBOX_DOC, 'utf8').includes('web-build')
  if (hasWebMode && !claimsWeb) {
    errs.push(
      `${BUILD_GATE} has a \`--web\` mode (the web client-bundle scan) but ${SANDBOX_DOC} never names the \`web-build\` lane that runs it — the doc understates a control that exists, so a reviewer reading it cannot know the web bundle is scanned at all.`,
    )
  } else if (!hasWebMode && claimsWeb) {
    errs.push(
      `${SANDBOX_DOC} describes the \`web-build\` client-bundle scan, but ${BUILD_GATE} has no \`--web\` mode — the doc claims a secret-exfiltration control the tree does not implement. This is the exact drift the per-surface rewrite in 0.5.0 corrected; restore the mode or the paragraph, not whichever is easier.`,
    )
  }
  sandboxSummary = `${SANDBOX_DOC} states the build gate's surfaces in lockstep with ${BUILD_GATE} (web mode ${hasWebMode ? 'present' : 'absent'})`
}

failures(GATE, errs)
ok(
  GATE,
  `AGENTS.md gate list in lockstep with the ${String(stepNames.length)}-step chain; CLAUDE.md pure; ${String(advertised.size)} advertised commands all exist; ${catalogSummary}; roster: ${String(rosterFiles.length)} agent(s) parsed, ${String(reviewersChecked)}/${String(REVIEWER_AGENTS.length)} reviewers read-only; ${mcpSummary}; ${doctrineSummary}; ${tiersSummary}; ${sandboxSummary}`,
)
