#!/usr/bin/env node
// Gate: resilience — the outbound-seam posture register, closed both ways.
//
// THE QUESTION THIS ANSWERS. Every seam that calls OUT of this system — the tRPC
// client, a server-side fetch, a supabase-js factory, an Edge Function — has a
// retry/timeout/backoff posture whether anyone chose one or not: an undeclared
// posture is "hang forever, retry never", decided by whichever runtime default
// happens to apply. This gate makes the posture REVIEWED DATA (tools/resilience.json):
// every outbound-transport construction site must have a row, and every row's claims
// must be true of the file it names.
//
// WHAT IT PROVES, AND WHAT IT DOES NOT. It proves — statically — that (1) no
// outbound-transport construction exists without a reviewed register row (the
// tools/observability.json sinks[] shape, one register over); (2) no row outlives its
// site or names a file without one (a posture claim with no code behind it is the
// vacuity this repo deletes checks for); and (3) a row's posture claims are backed by
// the symbols that implement them — a non-null timeoutMs requires `AbortSignal.timeout`
// in the file, retries > 0 requires a retry symbol, a non-null backoffMs requires a
// backoff symbol and retries > 0 to apply to. It does NOT prove the posture fires at
// runtime (that is the unit/e2e lanes' half), does not see a transport reached through
// a dependency's own internals, and does not judge whether a declared posture is WISE —
// `{ timeoutMs: null, retries: 0 }` with a written why is legal, because the gate
// refuses UNDECLARED and FALSE, never modest. Posture constants are provenance
// decision sites (SOURCE: on the line) per .claude/rules/provenance.md.
// SOURCE: docs/harness/gates-catalog.md ("resilience") [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'
import { walkFiles } from './lib/fs-walk.mjs'
import { fail, failures, ok, rampNote, skipOrFail } from './lib/gate.mjs'

const GATE = 'resilience'
const REGISTER = 'tools/resilience.json'
const ROOTS = ['apps', 'packages', 'supabase/functions']
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.next',
  '.expo',
  '.turbo',
  'coverage',
  'dist',
  'generated',
  'test-results',
  '.git',
])
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/
const NON_PRODUCT = /\.test\.|\.spec\.|__tests__|\/e2e\/|mock|\.generated\.|\/generated\//
const KINDS = new Set(['trpc-client', 'server-fetch', 'edge-function', 'supabase-client'])

const presentRoots = ROOTS.filter((r) => existsSync(r))
if (presentRoots.length === 0) {
  skipOrFail(GATE, `none of ${ROOTS.join(', ')} exists (no product surface yet)`)
}

let register = null
if (existsSync(REGISTER)) {
  try {
    register = JSON.parse(readFileSync(REGISTER, 'utf8'))
  } catch (e) {
    fail(
      GATE,
      `${REGISTER} is not valid JSON (${e.message}) — it is the reviewed posture register, so an unreadable one fails CLOSED rather than un-declaring every seam; restore it from git history`,
    )
  }
}

// ── 1. THE SCAN — outbound-transport construction sites ─────────────────────────────
// Comment-leading lines are skipped (a transport named in prose constructs nothing);
// the residual (a construction inside a block comment's continuation without a leading
// `*`) is accepted as a false positive in the safe direction.
const sites = new Map() // file -> { kinds: Set<string>, lines: number[] }

function lineKinds(t, importsSupabase) {
  const kinds = []
  if (/\bcreateTRPCClient\(|\bhttpBatchLink\(/.test(t)) kinds.push('trpc-client')
  if (/\bfetch\(|new WebSocket\(|new EventSource\(/.test(t)) kinds.push('server-fetch')
  if (importsSupabase && /\bcreateClient\(|\bcreateServerClient\(|\bcreateBrowserClient\(/.test(t)) {
    kinds.push('supabase-client')
  }
  return kinds
}

function detectKinds(file, text) {
  const underFunctions = file.startsWith('supabase/functions/')
  const importsSupabase = /from ['"](?:jsr:)?@supabase\//.test(text)
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue
    for (const kind of lineKinds(t, importsSupabase)) {
      const entry = sites.get(file) ?? { kinds: new Set(), lines: [] }
      entry.kinds.add(underFunctions ? 'edge-function' : kind)
      entry.lines.push(i + 1)
      sites.set(file, entry)
    }
  }
}

let scanned = 0
for (const root of presentRoots) {
  for (const rel of walkFiles(root, { excludeDirs: EXCLUDED_DIRS })) {
    if (!SOURCE_EXT.test(rel)) continue
    const file = `${root}/${rel}`
    if (NON_PRODUCT.test(file)) continue
    scanned += 1
    const text = readFileSync(file, 'utf8')
    if (
      !/createTRPCClient|httpBatchLink|fetch\(|WebSocket|EventSource|createClient|createServerClient|createBrowserClient/.test(
        text,
      )
    )
      continue
    detectKinds(file, text)
  }
}
if (scanned === 0) {
  fail(
    GATE,
    `zero source files found under ${presentRoots.join(', ')} — a posture verdict over nothing is vacuous, and an empty scan here means the roots moved out from under the gate`,
  )
}

const errs = []

// ── 2. THE REGISTER — shape first ───────────────────────────────────────────────────
const rows = Array.isArray(register?.seams) ? register.seams : []
const rowByFile = new Map()
for (const row of rows) {
  const file = String(row?.file ?? '')
  if (rowByFile.has(file)) {
    errs.push(`${REGISTER} carries two rows for ${file} — one seam file, one row.`)
  }
  rowByFile.set(file, row)
  if (!KINDS.has(String(row?.kind ?? ''))) {
    errs.push(
      `${REGISTER} row for ${file} has kind ${JSON.stringify(row?.kind ?? null)} — the closed set is ${[...KINDS].join(', ')}; an unknown kind licenses nothing.`,
    )
  }
  const p = row?.posture
  const timeoutOk = p?.timeoutMs === null || (typeof p?.timeoutMs === 'number' && p.timeoutMs > 0)
  const retriesOk = typeof p?.retries === 'number' && Number.isInteger(p.retries) && p.retries >= 0
  const backoffOk = p?.backoffMs === null || (typeof p?.backoffMs === 'number' && p.backoffMs > 0)
  if (p === null || typeof p !== 'object' || !timeoutOk || !retriesOk || !backoffOk) {
    errs.push(
      `${REGISTER} row for ${file} has a malformed posture — the shape is {timeoutMs: null|ms>0, retries: int>=0, backoffMs: null|ms>0}: null is a DECLARED absence, a missing key is an undeclared one, and only the first is reviewable.`,
    )
  } else if (p.backoffMs !== null && p.retries === 0) {
    errs.push(
      `${REGISTER} row for ${file} declares backoffMs with retries: 0 — a backoff between zero retries paces nothing; the pair is incoherent and one of the two is wrong.`,
    )
  }
  if (String(row?.why ?? '').trim().length < 40) {
    errs.push(
      `${REGISTER} row for ${file} has a \`why\` under 40 characters — this is the only place a reader learns why this seam's posture (including a declared do-nothing) is the reviewed choice.`,
    )
  }
}

// ── 3. TREE -> REGISTER: every construction site has a row ──────────────────────────
for (const [file, entry] of sites) {
  const row = rowByFile.get(file)
  if (row === undefined) {
    errs.push(
      `${file}:${String(entry.lines[0])} constructs an outbound transport (${[...entry.kinds].join(', ')}) with no ${REGISTER} row — an undeclared seam's posture is whatever the runtime default is, decided by nobody. Add a row {id, file, kind, posture, why} (write-guarded: adding one is a reviewed act).`,
    )
    continue
  }
  if (KINDS.has(String(row?.kind ?? '')) && !entry.kinds.has(String(row.kind))) {
    errs.push(
      `${REGISTER} row for ${file} declares kind ${JSON.stringify(row.kind)} but the file's detected construction is ${[...entry.kinds].join(', ')} — a row reviewed as one seam kind cannot license another.`,
    )
  }
}

// ── 4. REGISTER -> TREE: no stale rows, and posture claims are backed by symbols ────
for (const [file, row] of rowByFile) {
  if (!existsSync(file)) {
    errs.push(
      `${REGISTER} names ${file}, which is not a file in this tree — a posture claim with no code behind it is the exact vacuity this gate exists to refuse.`,
    )
    continue
  }
  if (!sites.has(file)) {
    errs.push(
      `${REGISTER} names ${file}, which constructs no outbound transport the detector knows — the register is closed both ways, so a row whose seam went away must go with it.`,
    )
    continue
  }
  const text = readFileSync(file, 'utf8')
  const p = row?.posture
  if (typeof p?.timeoutMs === 'number' && !text.includes('AbortSignal.timeout')) {
    errs.push(
      `${REGISTER} row for ${file} claims timeoutMs: ${String(p.timeoutMs)} but the file never calls AbortSignal.timeout — a deadline that exists only in the register bounds nothing.`,
    )
  }
  if (typeof p?.retries === 'number' && p.retries > 0 && !/retr(y|ies)/i.test(text)) {
    errs.push(
      `${REGISTER} row for ${file} claims retries: ${String(p.retries)} but the file carries no retry symbol — a retry count that exists only in the register retries nothing.`,
    )
  }
  if (typeof p?.backoffMs === 'number' && !/backoff/i.test(text)) {
    errs.push(
      `${REGISTER} row for ${file} claims backoffMs: ${String(p.backoffMs)} but the file carries no backoff symbol — a pace that exists only in the register paces nothing.`,
    )
  }
}

// ── the 1.0.0 ramp ───────────────────────────────────────────────────────────────────
// An install seeded before 1.0.0 may have grown its own outbound seams — hard-redding
// them on the update that delivered the scanner is the ambush the ramp doctrine exists
// for. One release of dated NOTEs to declare each seam; the deadline rides the
// rampNote call below.
if (
  errs.length > 0 &&
  rampNote(GATE, '1.0.0', 'the outbound-seam resilience register closure', {
    until: '1.1.0',
  })
) {
  console.log(`${GATE}: NOTE — ${String(errs.length)} finding(s) withheld by the 1.0.0 ramp:`)
  for (const e of errs) console.log(`  - ${e}`)
  ok(GATE, 'NOTE-only on this pre-1.0.0 install — the NOTE above carries the derived deadline')
}

if (register === null) {
  fail(
    GATE,
    `${REGISTER} is missing — it is the reviewed posture register this gate closes against (the scan above still found ${String(sites.size)} seam file(s)). Pull the seeded exemplar with \`npx next-expo-supabase-agent-harness update --refresh-seeded ${REGISTER}\`; its shipped state declares the scaffold's own seams exactly.`,
  )
}

failures(
  GATE,
  errs,
  `Each finding is a posture decision: declare the seam in ${REGISTER} (a declared {timeoutMs: null, retries: 0} with a written why is legal — the gate refuses undeclared and false, never modest), or remove the transport.`,
)
ok(
  GATE,
  `${String(scanned)} file(s) scanned, ${String(sites.size)} outbound seam file(s) all declared in ${REGISTER} (${String(rows.length)} row(s)), every posture claim backed by the symbol that implements it`,
)
