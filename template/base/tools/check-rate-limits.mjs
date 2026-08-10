#!/usr/bin/env node
// Gate: rate-limits — the budgets that RUN are the budgets somebody reviewed, and every
// mutating surface spends from one.
//
// THE VACUITY THIS GATE EXISTS TO PREVENT is not "the numbers are wrong". It is a limiter
// that is wired, tested, and reaches nothing: a new mutation lands, nobody adds it to the
// policy, and the seam happily limits the five procedures it already knew about while the
// new one runs unbounded. Everything stays green. So the load-bearing rule here is a
// CLOSURE against a GENERATED inventory (tools/generated/action-inventory.json is walked
// out of the composed router, never hand-written): every mutation is mapped or carries a
// reasoned exemption, in both directions.
//
// The second rule is the by-value diff. apps/web/lib/rate-limit.ts is the code that runs;
// tools/rate-limit-budget.json is what a human approved. The gate EVALUATES the module —
// the same technique the `security-headers` gate uses, and the reason that module has zero
// value imports — and compares. A number edited in code without a reviewed diff reds, and
// so does a number edited in the JSON that the code does not honour.
//
// The third is the pair of wiring assertions. A policy nothing consults is a policy in
// name only, so the tRPC host must pass a `rateLimit` port and every Server Action the
// budget names must actually call the guard.
// SOURCE: docs/adr/20260204-rate-limiting.md
// SOURCE: docs/harness/gates-catalog.md (rate-limits) [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { walkFiles } from './lib/fs-walk.mjs'
import { fail, failures, ok, rampNote, runCmd, skipOrFail, stampGate } from './lib/gate.mjs'
import { STAMP_INPUTS } from './lib/stamp-inputs.mjs'

const GATE = 'rate-limits'
const BUDGET = 'tools/rate-limit-budget.json'
const MODULE = 'apps/web/lib/rate-limit.ts'
const INVENTORY = 'tools/generated/action-inventory.json'
const ROUTE = 'apps/web/app/api/trpc/[trpc]/route.ts'
const ACTIONS_DIR = 'apps/web/app/actions'
const RAMP = '0.2.0'

if (!existsSync(BUDGET)) {
  // Ramped, not fatal: a pre-0.2.0 install has no budget file and no seam to judge, and a
  // hard failure there would be a gate reporting on a feature the tree does not have.
  //
  // The return value MUST be consumed. Until 0.4.0 this site discarded it and called ok()
  // unconditionally, so when the deadline arrived rampNote printed `RAMP EXPIRED` on stderr
  // and the gate then exited 0 — an alarm that rings into a green run. The ledger
  // (scripts/check-ramp-ledger.mjs) now reds on an unconsumed call for exactly this reason.
  // Past the deadline the escape closes onto skipOrFail, matching every sibling adoption
  // seam (db-limits, tenancy, query-shapes, security-headers): loud locally, red in CI.
  if (
    rampNote(GATE, RAMP, `${BUDGET} is missing — this install predates the rate-limit seam`, {
      until: '0.4.0',
    })
  ) {
    ok(GATE, `pre-${RAMP} install without ${BUDGET} — run \`npx … update\` to adopt the surface`)
  }
  skipOrFail(GATE, `${BUDGET} is missing (no rate-limit budget in this tree)`)
}

let budget
try {
  budget = JSON.parse(readFileSync(BUDGET, 'utf8'))
} catch (e) {
  fail(
    GATE,
    `${BUDGET} is not valid JSON (${e.message}) — the gate fails closed rather than treating an unreadable budget as no budget`,
  )
}

// ---------------------------------------------------------------------------
// Contract shape — fail closed on every malformation.
// ---------------------------------------------------------------------------
if (!Array.isArray(budget.buckets) || budget.buckets.length === 0) {
  fail(
    GATE,
    `${BUDGET}: "buckets" must be a non-empty array — an empty budget set would green a deployment that limits nothing while carrying a limiter`,
  )
}
for (const b of budget.buckets) {
  if (b === null || typeof b !== 'object' || typeof b.name !== 'string' || b.name === '') {
    fail(GATE, `${BUDGET}: every bucket needs a "name"; got ${JSON.stringify(b)}`)
  }
  if (
    !Number.isInteger(b.limit) ||
    b.limit <= 0 ||
    !Number.isInteger(b.windowSeconds) ||
    b.windowSeconds <= 0
  ) {
    fail(
      GATE,
      `${BUDGET}: bucket "${b.name}" needs a positive integer "limit" and "windowSeconds" — got ${JSON.stringify({ limit: b.limit, windowSeconds: b.windowSeconds })}`,
    )
  }
  if (typeof b.reason !== 'string' || b.reason.trim().length < 20) {
    fail(
      GATE,
      `${BUDGET}: bucket "${b.name}" needs a substantive "reason" — a number with no argument behind it is a number the next person will change without one`,
    )
  }
}
if (
  budget.ceilings === null ||
  typeof budget.ceilings !== 'object' ||
  !Number.isInteger(budget.ceilings?.limit) ||
  !Number.isInteger(budget.ceilings?.windowSeconds)
) {
  fail(
    GATE,
    `${BUDGET}: "ceilings" must declare integer "limit" and "windowSeconds" maxima — without a ceiling, raising a budget to 100000 is a one-token diff that reads exactly like a limit`,
  )
}
if (
  budget.failOpen?.decided !== true ||
  typeof budget.failOpen?.reason !== 'string' ||
  budget.failOpen.reason.trim().length < 40
) {
  fail(
    GATE,
    `${BUDGET}: "failOpen" must record the decision AND its argument. Whether an unavailable limiter allows or refuses traffic is the single most consequential choice in this subsystem, and an install that never made it deliberately made it by accident`,
  )
}
for (const key of ['procedures', 'actions']) {
  if (budget[key] === null || typeof budget[key] !== 'object' || Array.isArray(budget[key])) {
    fail(GATE, `${BUDGET}: "${key}" must be an object mapping a name to a bucket name`)
  }
}
if (!Array.isArray(budget.exemptProcedures)) {
  fail(GATE, `${BUDGET}: "exemptProcedures" must be an array (possibly empty)`)
}
for (const e of budget.exemptProcedures) {
  if (
    e === null ||
    typeof e !== 'object' ||
    typeof e.action !== 'string' ||
    typeof e.reason !== 'string' ||
    e.reason.trim().length < 40
  ) {
    fail(
      GATE,
      `${BUDGET}: every exemptProcedures entry must be {"action", "reason"} with a substantive reason — an unlimited endpoint is a decision, and this is where it is defended; got ${JSON.stringify(e)}`,
    )
  }
}

const recordGreen = stampGate(GATE, STAMP_INPUTS[GATE])

const errs = []
const declared = new Map(budget.buckets.map((b) => [b.name, b]))

// ---------------------------------------------------------------------------
// 1. Ceilings. A budget above them is a widening that belongs in this diff.
// ---------------------------------------------------------------------------
for (const b of budget.buckets) {
  if (b.limit > budget.ceilings.limit) {
    errs.push(
      `${BUDGET}: bucket "${b.name}" allows ${String(b.limit)} per window but the reviewed ceiling is ${String(budget.ceilings.limit)} — a budget nobody can exceed is not a budget`,
    )
  }
  if (b.windowSeconds > budget.ceilings.windowSeconds) {
    errs.push(
      `${BUDGET}: bucket "${b.name}" has a ${String(b.windowSeconds)}s window but the reviewed ceiling is ${String(budget.ceilings.windowSeconds)}s — a window long enough to never close is an unlimited endpoint spelled slowly`,
    )
  }
}

// ---------------------------------------------------------------------------
// 2. Both maps name declared buckets, and every declared bucket is used.
// ---------------------------------------------------------------------------
const referenced = new Set()
for (const [surface, map] of [
  ['procedures', budget.procedures],
  ['actions', budget.actions],
]) {
  for (const [name, bucket] of Object.entries(map)) {
    if (!declared.has(bucket)) {
      errs.push(
        `${BUDGET}: ${surface}."${name}" names bucket "${bucket}", which "buckets" does not declare — a mapping to a bucket that does not exist limits nothing`,
      )
      continue
    }
    referenced.add(bucket)
  }
}
for (const name of declared.keys()) {
  if (!referenced.has(name)) {
    errs.push(
      `${BUDGET}: bucket "${name}" is declared but nothing spends from it — a stale bucket reads as coverage of a surface that no longer exists`,
    )
  }
}

// ---------------------------------------------------------------------------
// 3. THE CLOSURE. Every mutation in the GENERATED inventory is mapped or exempt,
//    and every mapped/exempt name is a procedure that still exists.
// ---------------------------------------------------------------------------
if (!existsSync(INVENTORY)) {
  skipOrFail(
    GATE,
    `${INVENTORY} not found — the procedure closure cannot run (regenerate with \`pnpm gen\`)`,
  )
}
let inventory
try {
  inventory = JSON.parse(readFileSync(INVENTORY, 'utf8'))
} catch (e) {
  fail(GATE, `${INVENTORY} is not valid JSON (${e.message})`)
}
const exempt = new Map(budget.exemptProcedures.map((e) => [e.action, e]))
const live = new Map(inventory.map((a) => [a.action, a.type]))

for (const [action, type] of live) {
  const mapped = Object.hasOwn(budget.procedures, action)
  // The CONTRADICTION check is deliberately NOT scoped to mutations. A query can be both
  // mapped and exempt just as easily, and the resulting contract says opposite things
  // about an endpoint whichever verb it carries — the only difference is which of the two
  // downstream rules the module happens to violate first.
  if (mapped && exempt.has(action)) {
    errs.push(
      `${action} is BOTH mapped to bucket "${budget.procedures[action]}" and listed in exemptProcedures — the two say opposite things and the gate will not choose between them`,
    )
  }
  // The COVERAGE requirement is mutation-only, and that asymmetry is the honest one: a
  // read costs a query and leaves nothing behind, so an unmapped query is a budget
  // decision somebody may reasonably not have made. An unmapped mutation is a write path
  // with no ceiling.
  if (type !== 'mutation') continue
  if (!mapped && !exempt.has(action)) {
    errs.push(
      `${action} is a MUTATION with no bucket in ${BUDGET} and no reasoned exemption — this is the failure the gate exists for: the seam is wired, the tests pass, and the newest write path is the one thing running unbounded. Map it, or record why it must not be limited`,
    )
  }
}
for (const action of Object.keys(budget.procedures)) {
  if (!live.has(action)) {
    errs.push(
      `${BUDGET}: procedures."${action}" names a procedure the router does not expose — a stale mapping reads as coverage of something that is gone; remove it`,
    )
  }
}
for (const [action, entry] of exempt) {
  if (!live.has(action)) {
    errs.push(
      `${BUDGET}: exemptProcedures names "${action}", which the router does not expose — an exemption outliving its procedure is a hole waiting for a procedure to arrive under that name. Reason on file: ${entry.reason.slice(0, 60)}…`,
    )
  }
}

// ---------------------------------------------------------------------------
// 4. The module's returned policy matches the reviewed one, BY VALUE.
// ---------------------------------------------------------------------------
if (!existsSync(MODULE)) {
  skipOrFail(GATE, `${MODULE} not found — nothing to evaluate the budget against`)
}
// ONE PHYSICAL LINE: runCmd goes through a shell, and a `-e` payload with real newlines
// arrives at node as literal backslash-n — a syntax error whose message reads exactly like
// "type stripping is unavailable", which would make this gate skip forever for a plausible
// reason. (Learned by the security-headers gate; kept identical here on purpose.)
const probe =
  `import(${JSON.stringify(pathToFileURL(MODULE).href)}).then((m) => process.stdout.write(JSON.stringify(` +
  `{ buckets: m.rateLimitBuckets(), procedures: Object.fromEntries(${JSON.stringify([
    ...live.keys(),
  ])}.map((p) => [p, m.bucketForProcedure(p)])), ` +
  `actions: Object.fromEntries(${JSON.stringify(
    Object.keys(budget.actions),
  )}.map((a) => [a, m.bucketForAction(a)])), ` +
  `unknownProcedure: m.bucketForProcedure('does.not.exist'), unknownAction: m.bucketForAction('doesNotExistAction') })))`

let evaluated
try {
  evaluated = JSON.parse(
    runCmd(`node --experimental-strip-types --no-warnings -e ${JSON.stringify(probe)}`),
  )
} catch (e) {
  const reason = (e.stderr?.toString() ?? e.message).trim().split('\n').slice(0, 3).join(' / ')
  skipOrFail(GATE, `could not evaluate ${MODULE} (${reason}) — needs node >= 22.6 type stripping`)
}

const emitted = new Map(evaluated.buckets.map((b) => [b.name, b]))
for (const b of budget.buckets) {
  const got = emitted.get(b.name)
  if (got === undefined) {
    errs.push(
      `${MODULE} does not emit bucket "${b.name}" that ${BUDGET} declares — the reviewed budget is not the one running`,
    )
    continue
  }
  if (got.limit !== b.limit || got.windowSeconds !== b.windowSeconds) {
    errs.push(
      `bucket "${b.name}": ${MODULE} runs ${String(got.limit)}/${String(got.windowSeconds)}s but ${BUDGET} approves ${String(b.limit)}/${String(b.windowSeconds)}s`,
    )
  }
}
for (const name of emitted.keys()) {
  if (!declared.has(name)) {
    errs.push(
      `${MODULE} emits bucket "${name}" that ${BUDGET} does not declare — a budget that appeared in code without a reviewed diff`,
    )
  }
}

// The resolvers agree with the map, in both directions.
for (const [action, want] of Object.entries(budget.procedures)) {
  const got = evaluated.procedures[action]
  if (got === undefined || got === null || got.name !== want) {
    errs.push(
      `${MODULE} bucketForProcedure('${action}') returns ${got === null ? 'null (unlimited)' : `"${got?.name ?? 'nothing'}"`} but ${BUDGET} maps it to "${want}"`,
    )
  }
}
for (const [action, entry] of exempt) {
  if (evaluated.procedures[action] !== null) {
    errs.push(
      `${MODULE} bucketForProcedure('${action}') returns a bucket, but ${BUDGET} exempts it: ${entry.reason.slice(0, 60)}… — a documented exemption the code does not honour is worse than none, because the reason reads as if it were in force`,
    )
  }
}
for (const [action, want] of Object.entries(budget.actions)) {
  const got = evaluated.actions[action]
  if (got === undefined || got === null || got.name !== want) {
    errs.push(
      `${MODULE} bucketForAction('${action}') returns ${got === null ? 'null (unlimited)' : `"${got?.name ?? 'nothing'}"`} but ${BUDGET} maps it to "${want}"`,
    )
  }
}

// An UNKNOWN name must fall to a real bucket, never to null. This is the difference
// between "a procedure added without touching the policy is limited as a write until the
// gate reds" and "a procedure added without touching the policy is unlimited".
if (evaluated.unknownProcedure === null || evaluated.unknownAction === null) {
  errs.push(
    `${MODULE} returns null (unlimited) for an UNKNOWN name — an unmapped surface must fall to a real bucket, so the seconds between writing a router and running this gate are limited rather than open`,
  )
}

// ---------------------------------------------------------------------------
// 5. Wiring. A policy nothing consults is a policy in name only.
// ---------------------------------------------------------------------------
if (existsSync(ROUTE)) {
  const routeText = readFileSync(ROUTE, 'utf8')
  if (!/\brateLimit\s*:/.test(routeText)) {
    errs.push(
      `${ROUTE} does not pass a \`rateLimit\` port to createContext — @app/api treats a missing port as an UNLIMITED router (correct for a worker or a test), so the web host omitting it is silent, total loss of the router seam`,
    )
  }
} else {
  skipOrFail(GATE, `${ROUTE} not found — the router wiring assertion cannot run`)
}

const actionFiles = walkFiles(ACTIONS_DIR, { filter: (p) => p.endsWith('.ts') })
if (actionFiles.length === 0) {
  skipOrFail(
    GATE,
    `${ACTIONS_DIR} has no action modules — the Server Action wiring assertion cannot run`,
  )
}
const actionsText = actionFiles.map((f) => readFileSync(`${ACTIONS_DIR}/${f}`, 'utf8')).join('\n')
for (const name of Object.keys(budget.actions)) {
  if (!new RegExp(`enforceActionRateLimit\\(\\s*['"\`]${name}['"\`]`).test(actionsText)) {
    errs.push(
      `${BUDGET} gives Server Action "${name}" bucket "${budget.actions[name]}", but no module under ${ACTIONS_DIR} calls enforceActionRateLimit('${name}') — a Server Action is a public HTTP endpoint with a generated id, so a budget it never consults limits nobody`,
    )
  }
}
// The other direction: an exported action with no budget entry.
for (const m of actionsText.matchAll(/^export async function (\w*Action)\b/gm)) {
  if (!Object.hasOwn(budget.actions, m[1])) {
    errs.push(
      `${ACTIONS_DIR} exports "${m[1]}" but ${BUDGET} actions has no entry for it — every Server Action is a public endpoint, and one added without a budget is the same hole as an unmapped mutation`,
    )
  }
}

failures(
  GATE,
  errs,
  `The contract is ${BUDGET}: buckets and ceilings are reviewed data, "procedures" is closed BOTH WAYS against the generated ${INVENTORY}, and an unlimited endpoint needs an entry in "exemptProcedures" with a reason. ${MODULE} is the code that runs and is diffed against it by value.`,
)
recordGreen()
ok(
  GATE,
  `${String(budget.buckets.length)} reviewed bucket(s) under ceiling; ${String(Object.keys(budget.procedures).length)} procedure(s) + ${String(Object.keys(budget.actions).length)} Server Action(s) mapped, ${String(exempt.size)} reasoned exemption(s); every mutation covered; both seams wired`,
)
