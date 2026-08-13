// tools/lib/backup-posture.mjs — the BACKUP EVIDENCE judgement, as pure logic.
//
// WHAT PROBLEM THIS SOLVES. Essential Eight's *Regular backups* strategy asks whether backups
// happen, whether they are retained, and whether restoration is tested. Nothing in this
// repository could answer any of it, because unlike every other control here the subject is
// not in the tree: backups live in the platform's control plane, and the only way to learn
// their state is to ask.
//
// SO THE ASKING CANNOT BE A CHAIN STEP. `pnpm validate` must be deterministic and offline —
// a check that resolves its answer from a live third-party endpoint reds an untouched commit
// on a morning nobody chose, which is the rule CONTRIBUTING states and this repo has already
// paid for. The live query rides a SCHEDULED lane instead. What rides the chain is this
// file's unit tests over recorded fixtures, and that split is the only thing that stops a
// credential-gated lane from being decoration: a lane that skips on every machine without a
// token has never been shown to be capable of redding at all.
//
// THE TWO TRAPS THIS ENCODES, both of the "reds a CORRECT project" shape, both quoted from
// the vendor rather than reasoned about:
//   1. "If you enable PITR, we will no longer take Daily Backups." So daily-vs-PITR is an
//      OR and never an AND. An AND assertion reds every correctly configured PITR project.
//   2. "when the database has no activity, we do not make WAL file backups" — and the latest
//      restore point "could be significantly behind the current time", while "the state of
//      the database at the latest recovery point still reflects the current state". So
//      FRESHNESS IS NOT ASSERTABLE UNDER PITR. A quiet, correct project would red.
//
// PURE — no fs, no network, no clock of its own (`nowUnix` is a parameter). The gate script
// owns the request, the credentials and the exit code.
// SOURCE: https://supabase.com/docs/guides/platform/backups (the PITR/daily and idle-WAL statements)

/** The fields GET /v1/projects/{ref}/database/backups declares REQUIRED in its 200 response. */
const REQUIRED = ['region', 'walg_enabled', 'pitr_enabled', 'backups', 'physical_backup_data']

/** A backup row's `status` is a closed enum in the published schema. */
const STATUSES = new Set(['COMPLETED', 'FAILED', 'PENDING', 'REMOVED', 'ARCHIVED', 'CANCELLED'])

const HOUR = 3600

/**
 * Validate the reviewed posture file's own shape.
 *
 * `maxDailyBackupAgeHours` is deliberately REQUIRED and deliberately has NO harness default.
 * ASD's RB-01 asks for backups performed "in accordance with business criticality", and
 * business criticality is the operator's determination — a number invented here would
 * manufacture an obligation with no framework behind it, which is the same error as inventing
 * a patch SLA. The harness supplies the mechanism and the requirement to decide; the operator
 * supplies the number and the reason.
 *
 * @param {Record<string, unknown>} posture
 * @param {string} path
 * @returns {string[]}
 */
export function postureShapeProblems(posture, path) {
  const problems = []
  const hours = posture.maxDailyBackupAgeHours
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0) {
    problems.push(
      `${path}: \`maxDailyBackupAgeHours\` is ${JSON.stringify(hours)} — it must be a positive number. There is no harness default on purpose: ASD asks for backups "in accordance with business criticality", and that is the operator's determination, so a number invented here would be an obligation with nothing behind it.`,
    )
  }
  if (typeof posture.why !== 'string' || posture.why.trim().length < 40) {
    problems.push(
      `${path}: \`why\` must record (40+ characters) what business criticality produced that number. An unexplained recovery-point tolerance is not a decision anyone can assess.`,
    )
  }
  if (typeof posture.owner !== 'string' || posture.owner.trim() === '') {
    problems.push(
      `${path}: \`owner\` must name who holds this posture. Every backup requirement ASD states at the organisation boundary needs a name against it, and an unowned one is answered by nobody.`,
    )
  }
  return problems
}

/**
 * Validate that the response is the shape the published schema promises.
 *
 * ANTI-VACUITY, and it is the whole reason this runs first. If the endpoint changes shape —
 * a renamed field, a nested move — every assertion below would read undefined, find nothing
 * to object to, and report a green forever. A lane that cannot tell "correctly configured"
 * from "I could not see anything" is worse than no lane.
 *
 * @param {Record<string, unknown>} response
 * @returns {string[]}
 */
function shapeProblems(response) {
  const missing = REQUIRED.filter((k) => response?.[k] === undefined)
  if (missing.length > 0) {
    return [
      `the backups endpoint response is missing required field(s) ${missing.join(', ')} — the published schema declares all of ${REQUIRED.join(', ')} required, so the shape has changed under this lane and every assertion below would pass vacuously. Re-read the Management API schema before trusting a green here.`,
    ]
  }
  if (!Array.isArray(response.backups)) {
    return [
      'the backups endpoint returned a non-array `backups` field — the shape has changed under this lane.',
    ]
  }
  const bad = response.backups.filter((b) => !STATUSES.has(String(b?.status)))
  if (bad.length > 0) {
    return [
      `the backups endpoint returned ${String(bad.length)} row(s) whose \`status\` is outside the published enum (${[...STATUSES].join(', ')}) — an unrecognised status must not be silently counted as a good backup.`,
    ]
  }
  // A COMPLETED row whose timestamp cannot be read is a BROKEN RESPONSE, never an absent
  // backup. The published schema types `inserted_at` as a bare string with no `format` and no
  // pattern — unlike the schedule endpoint's `updated_at`, which does carry one — so nothing
  // guarantees it is parseable or carries a zone. Dropping such a row instead would leave the
  // newest-completed search empty and red the project as having NO RECOVERY MECHANISM AT ALL:
  // the right verdict for the wrong reason, and the most misleading failure this lane could
  // produce. An offset is demanded too, because JavaScript reads an offset-less date-time as
  // LOCAL time, which would shift every age computation by up to fourteen hours depending on
  // where the runner happens to be.
  const unreadable = response.backups
    .filter((b) => b.status === 'COMPLETED')
    .filter((b) => {
      const raw = String(b.inserted_at ?? '')
      return !Number.isFinite(Date.parse(raw)) || !/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)
    })
  if (unreadable.length > 0) {
    return [
      `${String(unreadable.length)} COMPLETED backup row(s) carry an \`inserted_at\` this lane cannot read as an unambiguous instant (e.g. ${JSON.stringify(unreadable[0].inserted_at)}). The published schema types the field as a bare string with no format and no pattern, so this is a response-shape problem rather than a missing backup — and treating it as the latter would red the project for having no recovery mechanism at all, which would be the right verdict for entirely the wrong reason.`,
    ]
  }
  return []
}

/**
 * Project states in which the backup set is legitimately in motion, or legitimately absent.
 *
 * Read from the published `status` enum. A project that is RESTORING, PAUSING, RESIZING or
 * COMING_UP is mid-operation, and INACTIVE means paused — asserting a recovery posture across
 * any of them would red a project for being busy. The sharpest case is RESTORING: a lane that
 * failed a project *because it was in the middle of a restore* would be firing at exactly the
 * moment the operator was using the thing it exists to protect.
 */
const SETTLED = new Set(['ACTIVE_HEALTHY', 'ACTIVE_UNHEALTHY'])

/** The newest COMPLETED backup's unix timestamp, or null when there is none. */
function newestCompleted(backups) {
  const times = backups
    .filter((b) => b.status === 'COMPLETED')
    .map((b) => Date.parse(String(b.inserted_at)))
    .filter((t) => Number.isFinite(t))
  return times.length === 0 ? null : Math.max(...times) / 1000
}

/**
 * The two guards that stop this lane redding a project that is CORRECT but not judgeable.
 *
 * Split out of judgeBackupPosture to stay under the cognitive-complexity ceiling the harness
 * holds every consumer to — the check that stops the harness exempting itself caught the
 * combined function at 19 against a bar of 15.
 *
 * @param {{ project: Record<string, unknown> | null, posture: Record<string, unknown>, nowUnix: number }} input
 * @returns {string | null} the note explaining why nothing is asserted, or null to carry on
 */
function unjudgeable({ project, posture, nowUnix }) {
  // LIVENESS. A project that is not settled has a backup set that is legitimately in motion
  // or legitimately absent. The sharpest case is RESTORING: failing a project because it is
  // mid-restore would fire at the exact moment the operator is using what this protects.
  const status = String(project?.status ?? '')
  if (status !== '' && !SETTLED.has(status)) {
    return `the project reports status ${status}, so no backup assertion was made: the backup set is legitimately in motion or absent in that state. This lane deliberately says nothing rather than guessing — most sharply for RESTORING, where failing the project would mean firing at the exact moment the operator is using what this lane exists to protect.`
  }
  // INFANCY. A project younger than the operator's own tolerance cannot yet have a daily
  // backup inside it. Note that this REUSES their number and invents none: the harness has no
  // opinion about how new is too new to judge.
  const createdAt = Date.parse(String(project?.created_at ?? ''))
  const max = Number(posture.maxDailyBackupAgeHours)
  if (!Number.isFinite(createdAt) || !Number.isFinite(max)) return null
  const ageHours = (nowUnix - createdAt / 1000) / HOUR
  if (ageHours > max) return null
  return `the project is ${ageHours.toFixed(1)}h old, inside the ${String(max)}h tolerance recorded in the posture, so no backup assertion was made — a project younger than its own backup window has not missed anything.`
}

/**
 * Judge one real project's backup posture.
 *
 * WHAT IS ASSERTED, and what is deliberately only REPORTED. Asserted: that SOME recovery
 * mechanism exists (PITR on, OR at least one completed daily backup), and — only when PITR is
 * off — that the newest daily backup is inside the operator's own stated tolerance. Reported
 * but never asserted: `walg_enabled`, the physical-backup flags, and the PITR recovery window.
 * Those are reported because their exact semantics are not documented well enough to red a
 * project over, and asserting a field whose meaning you have not verified is precisely how a
 * control ends up redding correct trees.
 *
 * `project` is OPTIONAL: it carries the envelope from GET /v1/projects/{ref}, which feeds the
 * two guards above. Without it they are inert and the judgement still runs — a caller holding
 * only the backups response gets a verdict, never a crash.
 *
 * @param {{
 *   response: Record<string, unknown>,
 *   project?: Record<string, unknown> | null,
 *   posture: Record<string, unknown>,
 *   nowUnix: number,
 * }} input
 * @returns {{ problems: string[], notes: string[] }}
 */
export function judgeBackupPosture({ response, project, posture, nowUnix }) {
  const shape = shapeProblems(response ?? {})
  if (shape.length > 0) return { problems: shape, notes: [] }

  const skip = unjudgeable({ project: project ?? null, posture, nowUnix })
  if (skip !== null) return { problems: [], notes: [skip] }

  const problems = []
  const notes = []
  const pitr = response.pitr_enabled === true
  const newest = newestCompleted(response.backups)

  // THE OR, NEVER THE AND. Quoted rather than reasoned: "If you enable PITR, we will no
  // longer take Daily Backups. PITR provides finer granularity than Daily Backups, so
  // running both is unnecessary." An AND here reds every correctly configured PITR project,
  // and a control that reds correct projects is a control somebody switches off.
  if (!pitr && newest === null) {
    problems.push(
      'this project has NEITHER Point-in-Time Recovery enabled NOR any COMPLETED backup — there is no recovery mechanism at all. Free-tier projects receive no daily backups: either move to a plan that does, enable PITR, or take responsibility for off-platform dumps (`supabase db dump`) and record that as the mechanism.',
    )
  }

  if (pitr) {
    // FRESHNESS IS NOT ASSERTABLE HERE, and the vendor is the reason: "when the database has
    // no activity, we do not make WAL file backups", and the latest restore point "could be
    // significantly behind the current time" while still reflecting the current state. An
    // idle, correct project would red on any recency bound. So the window is REPORTED for a
    // human to read, and nothing is claimed about it.
    // The inner fields are NOT required by the published schema — `physical_backup_data: {}`
    // is schema-legal — so both are read defensively and an absent window is REPORTED as
    // absent rather than rendered as NaN.
    const data = /** @type {Record<string, unknown>} */ (response.physical_backup_data ?? {})
    const earliest = Number(data.earliest_physical_backup_date_unix)
    const latest = Number(data.latest_physical_backup_date_unix)
    const span =
      Number.isFinite(earliest) && Number.isFinite(latest) ? (latest - earliest) / 86_400 : null
    notes.push(
      `PITR is enabled (walg_enabled=${String(response.walg_enabled)}); recovery window ${span === null ? 'not reported by the API' : `spans about ${span.toFixed(1)} day(s)`}. Recency is deliberately NOT asserted: the vendor documents that an idle database produces no recent WAL backups and that the latest recovery point still reflects the current state, so a quiet project is not a broken one.`,
    )
    return { problems, notes }
  }

  if (newest !== null) {
    const ageHours = (nowUnix - newest) / HOUR
    const max = Number(posture.maxDailyBackupAgeHours)
    notes.push(
      `PITR is OFF; the newest COMPLETED backup is ${ageHours.toFixed(1)}h old against the reviewed tolerance of ${String(max)}h. ${String(/** @type {unknown[]} */ (response.backups).length)} backup row(s) reported.`,
    )
    if (Number.isFinite(max) && ageHours > max) {
      problems.push(
        `the newest COMPLETED backup is ${ageHours.toFixed(1)} hours old, past the ${String(max)}-hour tolerance recorded in the backup posture. The platform takes daily backups automatically, so an age well past a day means they have stopped — check the project's plan and status before assuming this is a tolerance that needs widening.`,
      )
    }
  }

  return { problems, notes }
}
