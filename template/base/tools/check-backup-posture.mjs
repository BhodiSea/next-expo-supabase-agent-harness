#!/usr/bin/env node
// Scheduled control: does this project actually have a recovery mechanism, and is it the one
// the operator says it is?
//
// WHY THIS IS NOT A CHAIN STEP. Every other control in this harness judges an artefact in the
// tree. This one cannot: backups live in the platform's control plane, so the only way to
// learn their state is to ask over the network — and a check that resolves its answer from a
// live third-party endpoint reds an untouched commit on a morning nobody chose. That is the
// determinism rule that kept `pnpm audit` out of the chain, and it applies here with more
// force, because the answer can change without anybody touching the repository at all.
//
// So the LIVE QUERY rides `schedule` / `workflow_dispatch` only, and the JUDGEMENT lives in
// tools/lib/backup-posture.mjs, which is pure and unit-tested against recorded fixtures on
// every `pnpm test`. That split is what stops a credential-gated lane from being decoration:
// without it, a lane that skips on every machine with no token has never been shown to be
// capable of going red at all.
//
//   usage: node tools/check-backup-posture.mjs [--posture=<path>] [--fixture=<path>] [--now=<unix seconds>]
//
// `--posture` substitutes the reviewed file, `--fixture` substitutes a recorded API response
// for the live call, and `--now` substitutes the clock. Both exist for the same reason `check-framework-floor.mjs` takes `--today`: the
// red-proof must be able to drive this script to a failure without a live project and without
// waiting for a calendar. Neither flag SKIPS anything — they replace an input, and every
// assertion still runs.
// SOURCE: https://supabase.com/docs/guides/platform/backups [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { judgeBackupPosture, postureShapeProblems } from './lib/backup-posture.mjs'
import { fail, failures, ok } from './lib/gate.mjs'

const GATE = 'backup-posture'
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const POSTURE_PATH = arg('posture') ?? 'tools/backup-posture.json'
const CONFIG = 'supabase/config.toml'
const API = 'https://api.supabase.com/v1/projects'

/** Loud, non-fatal exit: this lane is a maintenance signal, never a contributor's blocker. */
function skipLoudly(reason) {
  // Deliberately NOT gate.mjs's skipOrFail, which hard-fails in CI. This lane runs ON a
  // schedule, so CI is always true, and hard-failing an operator who has not wired a token
  // would make deleting the lane the rational move. The opt-in below is how an operator who
  // HAS wired it makes the check binding on themselves.
  const required = process.env.HARNESS_REQUIRE_BACKUP_EVIDENCE === '1'
  const line = `${reason} — so NO backup evidence is being produced for this project, and the Essential Eight "Regular backups" rows have nothing behind them but the written record.`
  if (required) fail(GATE, `${line} (HARNESS_REQUIRE_BACKUP_EVIDENCE=1 makes this binding)`)
  console.log(
    `${GATE}: SKIPPED — ${line} Set SUPABASE_ACCESS_TOKEN (and SUPABASE_PROJECT_REF, or a project_id in ${CONFIG}), then set HARNESS_REQUIRE_BACKUP_EVIDENCE=1 to make this lane binding.`,
  )
  process.exit(0)
}

if (!existsSync(POSTURE_PATH)) {
  skipLoudly(`${POSTURE_PATH} is absent`)
}

let posture
try {
  posture = JSON.parse(readFileSync(POSTURE_PATH, 'utf8'))
} catch (e) {
  fail(GATE, `${POSTURE_PATH} is not valid JSON (${e.message})`)
}
/** The project ref: explicit env first, then the ref the scaffold wrote into config.toml. */
function projectRef() {
  const fromEnv = process.env.SUPABASE_PROJECT_REF?.trim()
  if (fromEnv) return fromEnv
  if (!existsSync(CONFIG)) return null
  const m = /^\s*project_id\s*=\s*"([^"]+)"/m.exec(readFileSync(CONFIG, 'utf8'))
  const ref = m?.[1]?.trim()
  // The template ships an unsubstituted placeholder; treating it as a ref would produce a
  // confusing 404 instead of the honest "this tree was never linked to a project".
  return ref && !ref.startsWith('{{') ? ref : null
}

const fixture = arg('fixture')
const nowUnix = Number(arg('now') ?? Math.floor(Date.now() / 1000))

/**
 * GET one Management API path, disposing of every documented failure by KIND.
 *
 * The 402 branch is the one worth reading twice. It was written as a fall-through — log the
 * plan gate, then drop into the generic `!res.ok` failure — which meant the code documenting
 * "a plan entitlement is not a misconfiguration" reported it as one anyway. It is terminal
 * now. Two further facts, both read off the published schema rather than assumed: the backups
 * endpoint declares NO 402 at all (only the Enterprise-gated `backups/schedule` does), so this
 * branch is defensive rather than expected; and `PlanGateErrorBody` requires only `message`,
 * with `error.code === 'entitlement_required'` present ONLY on true entitlement denials —
 * so a 402 WITHOUT that code is a billing-state or validation failure, and swallowing it as a
 * plan gate is how an organisation past due on payment quietly stops having backups.
 *
 * @param {string} url
 * @param {string} token
 * @returns {Promise<any>} the parsed body; every other disposition exits the process
 */
async function get(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (res.ok) return res.json()
  if (res.status === 402) {
    const body = await res.json().catch(() => ({}))
    if (body?.error?.code === 'entitlement_required') {
      console.log(
        `${GATE}: SKIPPED — the platform returned 402 entitlement_required for ${String(body?.error?.feature ?? 'this feature')}: ${String(body?.message ?? '')} That is a plan entitlement, not a misconfiguration, so nothing is asserted.`,
      )
      if (process.env.HARNESS_REQUIRE_BACKUP_EVIDENCE === '1') {
        fail(
          GATE,
          'a plan entitlement blocks the backup posture, and HARNESS_REQUIRE_BACKUP_EVIDENCE=1 makes that binding',
        )
      }
      process.exit(0)
    }
    fail(
      GATE,
      `402 with no entitlement_required marker: ${String(body?.message ?? 'no message')}. Per the published error schema that is a BILLING STATE or validation failure rather than a plan gate, and it must not be waved through — an organisation past due on payment is exactly the one about to discover its backups matter.`,
    )
  }
  // 401/403/404 mean the token is wrong, unscoped, or pointed at a project it cannot see —
  // a broken control, not an absent one, so it fails rather than skips. The skip path above
  // is only for "never configured at all".
  // `fail` exits, so this never returns — the `return` is for the reader and the linter.
  return fail(
    GATE,
    `GET ${url.replace(/\/v1\/projects\/[^/]+/, '/v1/projects/<ref>')} returned ${String(res.status)}. A configured lane that cannot read the backup posture is a broken control, not an absent one: check the access token's scope and the project ref.`,
  )
}

let response
/** @type {Record<string, unknown> | null} */
let project = null
if (fixture !== undefined) {
  const recorded = JSON.parse(readFileSync(fixture, 'utf8'))
  // A recorded fixture may carry the project envelope alongside the backups body, so the
  // liveness and infancy guards are exercisable without a live project.
  response = recorded.backups !== undefined ? recorded : recorded.response
  project = recorded.project ?? null
  console.log(`${GATE}: NOTE — judging the recorded fixture ${fixture} instead of a live project.`)
} else {
  const token = process.env.SUPABASE_ACCESS_TOKEN?.trim()
  const ref = projectRef()
  if (!token) skipLoudly('SUPABASE_ACCESS_TOKEN is not set')
  if (!ref) skipLoudly(`no project ref (SUPABASE_PROJECT_REF unset and ${CONFIG} carries none)`)

  response = await get(`${API}/${ref}/database/backups`, token)
  // The project envelope carries `status` and `created_at`, which feed the two guards that
  // stop this lane redding a project that is merely mid-restore or newly created. Only
  // `backups/schedule` is Enterprise-gated, so neither of these calls excludes a plan tier.
  project = await get(`${API}/${ref}`, token)
}

// The posture's own shape is judged only once there is something to judge WITH — a hard
// failure, not a skip, because at this point a malformed posture is the control broken rather
// than the prerequisite missing. It runs after credentials resolve on purpose: the file ships
// with a null tolerance that the operator must replace, and demanding that of a tree which has
// never been wired to a project would red people who are not using this lane at all.
failures(GATE, postureShapeProblems(posture, POSTURE_PATH))

const { problems, notes } = judgeBackupPosture({ response, project, posture, nowUnix })
for (const n of notes) console.log(`${GATE}: NOTE — ${n}`)
failures(
  GATE,
  problems,
  `\nThis lane reports what the platform says about recovery. It cannot test a restore: an in-place restore takes the project offline ("The project is inaccessible during this process"), and the non-destructive alternative — restore to a NEW project — is a Dashboard-only flow with no Management API path. So RESTORATION TESTING remains a written, dated record in ${POSTURE_PATH}, owned by a human.`,
)

ok(
  GATE,
  `the project reports a recovery mechanism (${response.pitr_enabled === true ? 'Point-in-Time Recovery' : `${String((response.backups ?? []).filter((b) => b.status === 'COMPLETED').length)} completed backup(s)`}) in region ${String(response.region)}`,
)
