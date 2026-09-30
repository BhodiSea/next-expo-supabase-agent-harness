// tools/lib/sql-fold-ramp.mjs — which findings ONLY the 1.1.0 history fold produces (#75).
//
// 1.1.0 taught tools/lib/sql-parse.mjs the two statements it used to skip: DROP TABLE now
// removes a table from every view, and ALTER POLICY rewrites a live policy. The SQL gates read
// those views, so on an install whose migration history holds either statement a verdict can
// move in both directions on upgrade. The ramp contract (issue #75, design record R06):
//
//   - a finding BOTH readings produce stays a hard red at every vintage;
//   - a finding only the OLD reading produced clears on every install — it describes an object
//     that was dropped or rewritten;
//   - a finding only the NEW reading produces rides the gate's own 1.1.0 ramp until 1.2.0.
//
// Telling the three apart needs the old reading's findings, so the gate replays ITSELF over the
// pre-fold history (sql-parse.mjs preFoldHistory) in a worker thread — "the twin" — and the
// two finding lists are compared as text. Replaying the whole script, not a copy of its rules,
// is the point: a second hand-written copy of seven gates' judgement is a second thing to drift.
//
// A worker thread, not a child process and not a flag. The twin is recognisable only by the
// workerData this module passes, so no argument or environment variable can put a real run into
// twin mode, and a fail()/process.exit() inside the twin ends the thread, never the gate. The
// twin runs only when the history holds a statement the fold reads differently AND the gate
// found something, which a shipped scaffold never does. (Harness tooling, not the product
// runtime: tools/conformance-map.json's "no worker_threads are used" is about the app tier.)
//
// The replay is scaffolding with an expiry. When every 1.1.0 ramp that calls it has expired and
// been removed, delete this file with them.
// SOURCE: docs/runbooks/harness-upgrade.md (1.1.0: the SQL history fold)
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'
import { preFoldHistory } from './sql-parse.mjs'

const TWIN = 'harnessSqlFoldTwin'

/** True only inside the replay this module starts. */
const inTwin = !isMainThread && workerData?.[TWIN] === true

/**
 * The migration history this run judges: the statements as written, or — inside the twin —
 * the pre-fold reading of them.
 * @param {string[]} statements
 */
export function historyFor(statements) {
  return inTwin ? preFoldHistory(statements) : statements
}

/** Whether this run is the twin, for a gate whose 1.0.x reading differs beyond historyFor. */
export function isTwin() {
  return inTwin
}

/**
 * Whether the history holds a statement the fold reads and the 1.0.x parser did not.
 * @param {string[]} statements
 */
export function foldTouches(statements) {
  return preFoldHistory(statements).length !== statements.length
}

/**
 * Run the gate script again in a worker over the pre-fold history and collect what it reports.
 * Null when the twin ended without reporting (it failed, skipped or threw before reaching the
 * gate's report point).
 * @param {string} gateUrl the gate's import.meta.url
 * @returns {Promise<string[] | null>}
 */
function replay(gateUrl) {
  return new Promise((resolve) => {
    /** @type {string[] | null} */
    let reported = null
    const worker = new Worker(new URL(gateUrl), {
      workerData: { [TWIN]: true },
      stdout: true,
      stderr: true,
    })
    // The twin's own output is the old reading's commentary, never the gate's: drained, not shown.
    worker.stdout.resume()
    worker.stderr.resume()
    worker.on('message', (m) => {
      if (Array.isArray(m)) reported = m.map(String)
    })
    // An uncaught throw in the twin arrives here and then as 'exit'; the verdict is 'exit's.
    worker.on('error', () => {})
    worker.on('exit', () => resolve(reported))
  })
}

/**
 * The findings only the fold produces, in the gate's order and deduplicated.
 *
 * `lists` is every finding list the gate has built by its report point. Inside the twin this
 * hands them to the gate and ends the thread; it never returns there. In the gate it replays
 * the twin only when `touched` and there is something to classify, and `replayed: false` means
 * the twin did not report — the caller then classifies nothing, so every finding stays where the
 * gate put it (fail closed: the ramp can only ever lift a finding the old reading did not make).
 * @param {string} gateUrl the gate's import.meta.url
 * @param {string[][]} lists
 * @param {boolean} touched
 * @returns {Promise<{ foldOnly: string[], replayed: boolean }>}
 */
export async function foldOnlyFindings(gateUrl, lists, touched) {
  if (inTwin) {
    parentPort?.postMessage(lists.flat())
    process.exit(0)
  }
  const found = [...new Set(lists.flat())]
  if (!touched || found.length === 0) return { foldOnly: [], replayed: true }
  const legacy = await replay(gateUrl)
  if (legacy === null) return { foldOnly: [], replayed: false }
  const before = new Set(legacy)
  return { foldOnly: found.filter((f) => !before.has(f)), replayed: true }
}

/**
 * Remove every withheld finding from each list, in place, so the gate's own red paths never
 * see them.
 * @param {string[][]} lists
 * @param {string[]} findings
 */
export function withhold(lists, findings) {
  const out = new Set(findings)
  for (const list of lists) {
    const kept = list.filter((f) => !out.has(f))
    list.splice(0, list.length, ...kept)
  }
}
