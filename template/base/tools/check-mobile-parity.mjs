#!/usr/bin/env node
// Gate: parity — every backend ACTION is accounted for on BOTH client surfaces.
// The API exposes a set of tRPC procedures (the committed action inventory); this gate
// holds a ledger — PARITY.md — that must carry EXACTLY ONE row per action, naming the
// web screen and the mobile screen that surface it (or — for a reasoned exemption). The
// closure runs BOTH WAYS, which is the fix to the source scanner's two real defects:
//   forward  — every inventory action has a PARITY.md row (a NEW action nobody surfaced
//              on either client is the gap this catches). Version-RAMPED: soft on installs
//              predating the gate, strict on fresh installs + the template tree, and forced
//              strict anywhere by CHECK_MOBILE_PARITY_STRICT=1.
//   backward — every PARITY.md row names a LIVE action. The source `check-mobile-parity`
//              was one-way: a row for a DELETED action was never noticed and rotted. Here a
//              stale row reds (both modes — a dead-action row is unambiguous rot, not a ramp).
//
// The action-name grammar ADMITS DIGITS (`namespace.action` with `[a-z0-9-]`/`[A-Za-z0-9]`).
// The source regex `[a-z-]+\.[A-Za-z]+` silently dropped any action carrying a digit and then
// reported a false ✓ over the survivors — a scanner that can't see `billing.v2Invoice` is
// worse than none.
//
// REGEN-BEFORE-CONTAINMENT is structural, not re-run here: parity reads the COMMITTED
// tools/generated/action-inventory.json, and the `contracts` gate — which runs immediately
// before parity in the chain — proves that file byte-fresh against the live router via its
// regen-diff. So the input parity contains against is a gate-verified artifact, never a stale
// snapshot (the doctrine: generated artifacts are committed and gate-verified, never
// build-generated — a gate that reds on a stale artifact beats a graph that regenerates it).
// SOURCE: docs/harness/gates-catalog.md (parity gate) [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { fail, failures, ok, rampNote, skipOrFail } from './lib/gate.mjs'

const GATE = 'parity'
const INVENTORY = 'tools/generated/action-inventory.json'
const PARITY = 'PARITY.md'
// The version the two-way closure went live in. rampNote() returns true (NOTE-only) for an
// install whose baseVersion predates this — so parity never ambushes a project that installed
// before it existed. No manifest (template tree, gate fixtures) → false → live/strict.
const MIN_VERSION = '0.1.2'

// `namespace.action`: lowercase-kebab namespace, camel-ish action, DIGITS ADMITTED in both.
const ACTION_RE = /^[a-z][a-z0-9-]*\.[A-Za-z][A-Za-z0-9]*$/
// The exemption markers a surface cell may hold instead of a screen path. Em/en dash, plain
// hyphen, or n/a — a cell saying "this action is deliberately not surfaced here".
const EXEMPT = new Set(['—', '–', '-', 'n/a', 'N/A'])

// CHECK_MOBILE_PARITY_STRICT=1 forces the closure live even on a pre-ramp install (a consumer
// opting in early). Short-circuited so rampNote's NOTE side effect never fires under it.
const forceStrict = process.env.CHECK_MOBILE_PARITY_STRICT === '1'

// ---- 1. the committed action inventory (the SHAPE the ledger must mirror) ----
if (!existsSync(INVENTORY)) {
  skipOrFail(
    GATE,
    `${INVENTORY} not found — the contracts gate generates it (\`pnpm gen\`); parity has no action surface to mirror yet`,
  )
}
let inventory
try {
  inventory = JSON.parse(readFileSync(INVENTORY, 'utf8'))
} catch (e) {
  fail(
    GATE,
    `${INVENTORY} is not valid JSON (${e.message}) — it is a generated, contracts-gate-verified artifact; regenerate with \`pnpm gen\``,
  )
}
if (!Array.isArray(inventory)) {
  fail(
    GATE,
    `${INVENTORY} must be a JSON array of {"action","type"} rows — the inventory is malformed`,
  )
}
const actionType = new Map()
for (const row of inventory) {
  if (row === null || typeof row !== 'object' || typeof row.action !== 'string') {
    fail(
      GATE,
      `${INVENTORY}: every row must be {"action": string, "type": string} — got ${JSON.stringify(row)}`,
    )
  }
  actionType.set(row.action, typeof row.type === 'string' ? row.type : '?')
}
const inventoryActions = new Set(actionType.keys())

// ---- 2. the PARITY.md ledger ----
// Cells of one table row: split on `|`, drop the framing pipes, trim. A cell never contains a
// literal `|` (markdown would require escaping it), so this is lossless.
const cellsOf = (line) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())

const errs = []
const rows = [] // { action, web, mobile, notes, line }

if (!existsSync(PARITY)) {
  // No ledger at all. Every action is unrowed — surface each and let the ramp decide
  // NOTE-vs-fail. The template tree ships a complete PARITY.md, so this branch is only
  // reached on a pre-parity install whose seed was withheld (or a project that deleted it).
  for (const action of [...inventoryActions].sort()) {
    errs.push(
      `${action} (${actionType.get(action)}) has no row — in fact ${PARITY} does not exist. Seed the ledger (the harness ships one; \`update\` restores it): one row per action, columns \`| Action | Web | Mobile | Notes |\`.`,
    )
  }
} else {
  const lines = readFileSync(PARITY, 'utf8').split('\n')
  const headerIdx = lines.findIndex((l) =>
    /^\|\s*action\s*\|\s*web\s*\|\s*mobile\s*\|\s*notes\s*\|/i.test(l.trim()),
  )
  if (headerIdx === -1) {
    fail(
      GATE,
      `${PARITY} has no \`| Action | Web | Mobile | Notes |\` table — the parity ledger is gone or its header drifted`,
    )
  }
  const sepCells = cellsOf(lines[headerIdx + 1] ?? '')
  if (sepCells.length < 4 || !sepCells.every((c) => /^:?-+:?$/.test(c))) {
    fail(
      GATE,
      `${PARITY}:${headerIdx + 2}: the row under the header must be a markdown separator (\`| --- | --- | --- | --- |\`)`,
    )
  }
  for (let i = headerIdx + 2; i < lines.length; i += 1) {
    if (!lines[i].trim().startsWith('|')) break // the table ends at the first non-`|` line
    const c = cellsOf(lines[i])
    if (c.length < 4) {
      errs.push(
        `${PARITY}:${i + 1}: row has ${c.length} column(s), need 4 (\`| Action | Web | Mobile | Notes |\`)`,
      )
      continue
    }
    rows.push({ action: c[0], web: c[1], mobile: c[2], notes: c[3], line: i + 1 })
  }

  // Grammar + de-duplication. A malformed name is reported but the row is still mapped, so
  // closure below stays meaningful (no phantom "missing" for a row that IS present).
  const rowByAction = new Map()
  for (const r of rows) {
    if (!ACTION_RE.test(r.action)) {
      errs.push(
        `${PARITY}:${r.line}: action "${r.action}" is not a valid action name — expected \`namespace.action\` (lowercase-kebab namespace, camel-ish action, digits allowed; e.g. \`notes.create\`, \`billing.v2Invoice\`)`,
      )
    }
    if (rowByAction.has(r.action)) {
      errs.push(
        `${PARITY}:${r.line}: duplicate row for action "${r.action}" — also at line ${rowByAction.get(r.action).line}; one row per action`,
      )
      continue
    }
    rowByAction.set(r.action, r)
  }

  // Forward closure: every inventory action has a row.
  for (const action of [...inventoryActions].sort()) {
    if (!rowByAction.has(action)) {
      errs.push(
        `${action} (${actionType.get(action)}) has no row in ${PARITY} — every backend action must be accounted for on each surface. Add \`| ${action} | <web screen path or —> | <mobile screen path or —> | <reason when a cell is —> |\`.`,
      )
    }
  }
  // Backward closure: every row names a live action (stale rows rot — not ramp-gated below,
  // but reported here so the ramp still folds them into a NOTE on a pre-parity install).
  for (const r of rows) {
    if (ACTION_RE.test(r.action) && !inventoryActions.has(r.action)) {
      errs.push(
        `${PARITY}:${r.line}: action "${r.action}" is not in ${INVENTORY} — a stale ledger row for a removed/renamed action. Delete the row (or regenerate the inventory if the action still exists: \`pnpm gen\`).`,
      )
    }
  }
  // Cell integrity: each surface is an existing repo-relative path, or — (exempt) WITH a
  // Notes reason. Only mapped, live actions are cell-checked — a stale row is deleted, not
  // repaired, so piling path errors onto it would be noise.
  for (const action of [...inventoryActions].sort()) {
    const r = rowByAction.get(action)
    if (r === undefined) continue
    let anyExempt = false
    for (const [surface, cell] of [
      ['web', r.web],
      ['mobile', r.mobile],
    ]) {
      if (EXEMPT.has(cell)) {
        anyExempt = true
        continue
      }
      if (cell === '') {
        errs.push(
          `${PARITY}:${r.line}: ${surface} cell is empty for "${action}" — a repo-relative screen path, or — (exempt) with a Notes reason`,
        )
      } else if (cell.startsWith('/') || cell.includes('..')) {
        errs.push(
          `${PARITY}:${r.line}: ${surface} path "${cell}" must be repo-relative with no \`..\` — name the file that surfaces "${action}"`,
        )
      } else if (!existsSync(cell)) {
        errs.push(
          `${PARITY}:${r.line}: ${surface} path "${cell}" for "${action}" does not exist (stale reference) — name a real file, or — with a Notes reason`,
        )
      }
    }
    if (anyExempt && r.notes === '') {
      errs.push(
        `${PARITY}:${r.line}: "${action}" is exempt (—) on a surface but Notes is empty — an exemption must carry a reason (why is it not surfaced there?)`,
      )
    }
  }
}

// ---- 3. settle: ramp-gate the findings, then the hard verdict ----
if (
  errs.length > 0 &&
  !forceStrict &&
  rampNote(GATE, MIN_VERSION, `${errs.length} parity finding(s) (action↔${PARITY} closure)`, {
    until: '0.4.0',
  })
) {
  ok(
    GATE,
    `${errs.length} finding(s) held as a ramp NOTE (baseVersion < ${MIN_VERSION}); set CHECK_MOBILE_PARITY_STRICT=1 to enforce now`,
  )
}
failures(
  GATE,
  errs,
  `Every action needs exactly one ${PARITY} row; every row a live action; each surface an existing repo-relative screen path or — with a Notes reason.`,
)
ok(
  GATE,
  `${inventoryActions.size} action(s) mapped to web+mobile surfaces; action↔${PARITY} closure holds both ways`,
)
