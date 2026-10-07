// Shared gate-script helpers. Doctrine: a gate that cannot run its real check
// SKIPS LOUDLY when the prerequisite is absent locally, and FAILS CLOSED in CI
// (CI=true or HARNESS_REQUIRE_TOOLCHAINS=1) — a skip must never look like a pass.
// Every failure path ends with a deterministic `FIX[gate]:` line (exact reproduce
// command + docs pointer) so an agent reading a red Stop block knows the next
// action without spelunking — the feedback loop is part of the product. Since
// 1.1.0 the only line that may follow it is the project's own field note for
// that gate (see "field notes" below).
// SOURCE: docs/harness/README.md (skip-local / fail-closed-CI asymmetry) [corpus: harness/doctrine]
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import {
  dottedCallee,
  key12,
  NAME_RE,
  path,
  sqlName,
  subjectId,
  symbol,
  UNPRINTABLE,
} from './closed-text.mjs'
import { toPosix, walkFiles } from './fs-walk.mjs'

export const inCI = () =>
  process.env.CI === 'true' || process.env.HARNESS_REQUIRE_TOOLCHAINS === '1'

// The arguments a FIX line repeats. One that needs no shell quoting (a flag, a word, a
// relative path) is printed as given. A KEY=VALUE pair prints as `KEY=…`, so a value handed
// through (a credential passed with `--env`, say) never reaches a log. Anything else is
// dropped, together with the flag it was the value of, so the printed command still parses.
// Until 1.0.4 only [a-z0-9-] tokens survived, and a failed device journey printed
// `--phase journey --file --out-dir`, which the runner rejects (#10).
function reproduceArgs(argv) {
  const out = []
  for (const arg of argv) {
    const pair = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(arg)
    if (pair !== null) out.push(`${pair[1]}=…`)
    else if (/^[A-Za-z0-9._/-]+$/.test(arg)) out.push(arg)
    else if (!arg.startsWith('-') && out.at(-1)?.startsWith('--')) out.pop()
  }
  return out
}

// The reproduce command is derived from the running script so it can never drift
// from reality; gates invoked through a wrapper fall back to the whole chain.
function fixHint(gate) {
  const script = process.argv[1]
    ?.split('\\')
    .join('/')
    .replace(/^.*?\/(tools\/)/, '$1')
  const argv = reproduceArgs(process.argv.slice(2))
  const cmd = script?.startsWith('tools/')
    ? ['node', script, ...argv].join(' ')
    : 'node tools/validate.mjs'
  return `FIX[${gate}]: reproduce with \`${cmd}\`; docs: docs/harness/gates-catalog.md ("${gate}")`
}

// ---- field notes (1.1.0) ----------------------------------------------------------
// tools/field-notes.json is the project's own line under a gate's FIX line: what it learned
// about that gate in its tree (the fixture it trips on, the fix that is usually right).
// `{"notes": {"<gate>": "one string"}}`, keyed on the token of `<gate>: FAIL`. PRINT-ONLY:
// the note is read on the three failure paths alone, after the FAIL, bullet and FIX lines
// have printed and just before exit(1), so it can neither change a verdict nor hide a
// finding, and it never prints on ok(), a stamp hit or a local skip. It is not a stamp
// input (a stamp records a green run; a note prints on a red one). The file is seeded and
// write-guarded: its text reaches an agent at the moment it decides how to make a red go
// away, so it is a human's to write.
// SOURCE: docs/harness/gates-catalog.md ("Shared behavior") [corpus: harness/doctrine]
/** @public named by the gates catalog; exported for tests/gates/gate-helpers.test.mjs */
export const FIELD_NOTE_MAX_CHARS = 300
const FIELD_NOTES_PATH = 'tools/field-notes.json'
const GATE_TOKEN = /^[a-z0-9-]+$/

// Whitespace (newlines included) collapses to one space; control, format and lone-surrogate
// code points are removed (ESC, C1, bidirectional overrides, zero-width characters), so a
// note cannot drive a terminal, reorder the line it sits on or carry text nobody can see.
// Property escapes, not a \x00-\x1f class: the machinery ESLint config bans control
// characters in regex literals (no-control-regex).
/** @param {string} value @returns {string} */
function sanitizeNote(value) {
  const text = value
    .replace(/\p{White_Space}+/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '')
    .replace(/ {2,}/g, ' ')
    .trim()
  // Counted in code points, so the cut never splits a surrogate pair.
  const points = [...text]
  if (points.length <= FIELD_NOTE_MAX_CHARS) return text
  return `${points
    .slice(0, FIELD_NOTE_MAX_CHARS - 1)
    .join('')
    .trimEnd()}…`
}

/**
 * The field-note line for `gate`, or null when there is none. Pure: `raw` is the text of
 * tools/field-notes.json, or null when the file is absent. Invalid JSON renders one fixed
 * line naming the file; a `notes` that is not an object, a key outside [a-z0-9-] and a
 * value that is not a string render nothing. It never throws.
 * @public exported for the harness repo's gate suite (tests/gates/gate-helpers.test.mjs)
 * @param {string} gate @param {string | null} raw @returns {string | null}
 */
export function renderFieldNote(gate, raw) {
  if (raw === null) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return `FIELD-NOTE[${gate}]: ${FIELD_NOTES_PATH} is not valid JSON; no note printed`
  }
  const notes = parsed?.notes
  if (notes === null || typeof notes !== 'object' || Array.isArray(notes)) return null
  if (!GATE_TOKEN.test(gate) || !Object.hasOwn(notes, gate)) return null
  const value = notes[gate]
  if (typeof value !== 'string') return null
  const text = sanitizeNote(value)
  return text === '' ? null : `FIELD-NOTE[${gate}]: ${text}`
}

// The one tail every failure path prints: the FIX line, then the project's note for this
// gate when it has one. The notes file is read relative to the working directory, as
// readManifest reads .harness/, and any read error (absence included) prints nothing.
/** @param {string} gate */
function printRemedy(gate) {
  console.error(fixHint(gate))
  let raw
  try {
    raw = readFileSync(FIELD_NOTES_PATH, 'utf8')
  } catch {
    return
  }
  const line = renderFieldNote(gate, raw)
  if (line !== null) console.error(line)
}

// The three exits below are annotated `@returns {never}` DELIBERATELY, and it is not
// cosmetic. Under `checkJs: true` TypeScript infers `void` for a function whose body ends in
// `process.exit()`, so at every `if (bad) fail(...)` call site the code after the branch is
// still considered reachable with the pre-branch types — which is how a `fail()` that replaced
// a `return process.exit(1)` silently stops narrowing (`never` is assignable to anything;
// `void` is not). `strict: false` means adding the annotation cannot break a caller, and the
// callers that already relied on narrowing get it back.

/** @param {string} gate @param {string} [msg] @returns {never} */
export function ok(gate, msg) {
  console.log(`${gate}: OK${msg ? ` — ${msg}` : ''}`)
  process.exit(0)
}

/** @param {string} gate @param {string} msg @returns {never} */
export function fail(gate, msg) {
  console.error(`${gate}: FAIL — ${msg}`)
  printRemedy(gate)
  process.exit(1)
}

// `validate --ci-parity` (1.0.4) hands each step HARNESS_PARITY_REPORT_DIR, one directory
// per step, and closes the run with one line per missing prerequisite a gate recorded
// there. noteMissingPrerequisite appends that record: one JSON line, {"gate","reason"}, to
// <dir>/<pid>.jsonl. It is called on the CI branch of skipOrFail and of every partial leg
// that fails closed in CI, right before the verdict. With the variable unset (every run
// but --ci-parity) it does nothing, and it swallows every error and prints nothing:
// record-keeping never decides a verdict, never adds output, and never writes into the
// project tree (the runner puts the directory in the OS temp dir).
// SOURCE: docs/harness/README.md (skip-local / fail-closed-CI asymmetry) [corpus: harness/doctrine]
/** @param {string} gate @param {string} reason */
export function noteMissingPrerequisite(gate, reason) {
  appendReport('HARNESS_PARITY_REPORT_DIR', { gate, reason })
}

// One JSON line in <dir>/<pid>.jsonl, <dir> the value of `variable`; nothing when it is unset.
/** @param {string} variable @param {Record<string, unknown>} entry */
function appendReport(variable, entry) {
  const dir = process.env[variable]
  if (!dir) return
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, `${process.pid}.jsonl`), `${JSON.stringify(entry)}\n`)
  } catch {
    // Deliberately silent: the record is a report, and the verdict is the gate's alone.
  }
}

// ---- the advisory recorder (2.1.0, #185) -------------------------------------------
// An advisory finding becomes one CLOSED RECORD, and a producer's finished leg one
// terminator, appended to <dir>/<pid>.jsonl where <dir> is HARNESS_ADVISORY_REPORT_DIR (the
// parity recorder's shape). With the variable unset nothing is written. The contract is
// noteMissingPrerequisite's: the recorder swallows its own errors, decides no verdict, and
// writes nothing into the project tree.
//   - noteAdvisory(record) validates the record against the closed schema below, appends
//     it, and prints its one `<producer>: NOTE — ` line, rendered from the record alone. A
//     record that fails the schema is not written, and a fixed line naming only its producer
//     prints instead. `{ print: false }` prints nothing at all.
//   - noteComplete({ producer, leg }) appends the leg's terminator. A producer writes it
//     immediately before its final failures() and ok() and never on an early exit, so a
//     skip, a fail(), a stamp hit or a crash leaves the leg incomplete, and nothing that
//     reads the records can take a leg that stopped early for a clean one.
//   - advisoryKey(record) is the record's identity: line numbers and content never enter
//     it, and its first 12 hex digits, the key12, are the one id the harness prints.
// A RECORD IS CLOSED (plan-v2 §5, plus `facts`): every field is a number, a boolean, a
// member of a closed set, or a value one of the printers in lib/closed-text.mjs accepts, so
// it can be printed, filed or handed to a reviewer without carrying text an author chose.
// SOURCE: docs/harness/gates-catalog.md ("Shared behavior") [corpus: harness/doctrine]
const ADVISORY_DIR = 'HARNESS_ADVISORY_REPORT_DIR'
/** @public the closed producer set; read by the factory's ratchet test @type {readonly string[]} */
export const ADVISORY_PRODUCERS = Object.freeze([
  'duplication',
  'query-shapes',
  'parity',
  'contracts',
  'i18n',
  'embeddings',
])
// The closed family enum, per producer. This release ships duplication's families: the
// single-home ones and the six complexity families (SINGLE-HOME §2.4). Each later item adds
// its producer's own (#189 adds `wire-orphan`).
/**
 * @public read by the factory's ratchet test (tests/gates/advisory-ratchet.test.mjs)
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const ADVISORY_RULES = Object.freeze({
  duplication: Object.freeze([
    'exact',
    'exact-small',
    'exact-nohome',
    'near-miss',
    'accepted-class-changed',
    'accepted-class-diverged',
    'stale-row',
    'pass-through',
    'helper-split',
    'intent-hiding',
    'single-consumer',
    'bool-selector',
    'edge-guard',
  ]),
  'query-shapes': Object.freeze([]),
  parity: Object.freeze([]),
  contracts: Object.freeze([]),
  i18n: Object.freeze([]),
  embeddings: Object.freeze([]),
})
const ADVISORY_STATUS_TEXT = {
  advisory: 'advisory (no verdict)',
  'ramp-withheld': 'withheld (ramp)',
  blocking: 'blocking',
}
const RECORD_KEYS = ['v', 'producer', 'rule', 'status', 'subject', 'fp', 'until', 'counts', 'facts']
const RECORD_REQUIRED = ['v', 'producer', 'rule', 'status', 'subject', 'fp']
const FACTS_DEPTH = 3
const FACT_STRINGS = [symbol, dottedCallee, sqlName, path, key12]

/** @param {unknown} v */
const isProducer = (v) => typeof v === 'string' && ADVISORY_PRODUCERS.includes(v)

/** @param {unknown} v @returns {v is Record<string, any>} */
const isPlainObject = (v) =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(v))

// One subject id, or a near-miss pair of two, sorted and joined by one space.
/** @param {unknown} subject */
function subjectOk(subject) {
  if (typeof subject !== 'string') return false
  const ids = subject.split(' ')
  if (ids.length > 2 || !ids.every((id) => subjectId.ok(id))) return false
  return ids.length === 1 || ids[0] < ids[1]
}

/** @param {unknown} counts */
const countsOk = (counts) =>
  isPlainObject(counts) &&
  Object.entries(counts).every(
    ([k, n]) => symbol.ok(k) && Number.isSafeInteger(n) && Number(n) >= 0,
  )

/** @param {unknown} v */
const factLeafOk = (v) =>
  typeof v === 'boolean' ||
  (typeof v === 'number' && Number.isFinite(v)) ||
  FACT_STRINGS.some((printer) => printer.ok(v))

// `facts` itself is depth 1; an array or object may sit at depth 2 or 3, never 4.
/** @param {unknown} v @param {number} depth @returns {boolean} */
function factOk(v, depth) {
  if (Array.isArray(v)) return depth <= FACTS_DEPTH && [...v].every((x) => factOk(x, depth + 1))
  if (isPlainObject(v)) {
    return (
      depth <= FACTS_DEPTH &&
      Object.entries(v).every(([k, x]) => symbol.ok(k) && factOk(x, depth + 1))
    )
  }
  return factLeafOk(v)
}

/** @param {Record<string, unknown>} r */
const shapeOk = (r) =>
  Object.keys(r).every((k) => RECORD_KEYS.includes(k)) &&
  RECORD_REQUIRED.every((k) => Object.hasOwn(r, k))

/** @param {unknown} r @returns {r is Record<string, any>} */
function advisoryRecordOk(r) {
  if (!isPlainObject(r) || !shapeOk(r) || !isProducer(r.producer)) return false
  return (
    r.v === 1 &&
    ADVISORY_RULES[r.producer].includes(r.rule) &&
    Object.hasOwn(ADVISORY_STATUS_TEXT, r.status) &&
    subjectOk(r.subject) &&
    key12.ok(r.fp) &&
    (r.until === undefined || (typeof r.until === 'string' && /^\d+\.\d+\.\d+$/.test(r.until))) &&
    (r.counts === undefined || countsOk(r.counts)) &&
    (r.facts === undefined || (isPlainObject(r.facts) && factOk(r.facts, 1)))
  )
}

/**
 * The record's identity: the first 16 hex digits of sha256(producer|rule|subject). No
 * printer admits `|`, so no two triples share an input. The key12 is its first 12.
 * @public read by the packet and the issue sync (#186, #205)
 * @param {Record<string, unknown>} record its producer, rule and subject
 * @returns {string}
 */
export function advisoryKey(record) {
  const { producer, rule, subject } = record
  return createHash('sha256')
    .update(`${String(producer)}|${String(rule)}|${String(subject)}`)
    .digest('hex')
    .slice(0, 16)
}

// A line that is not `ramp-withheld` never holds the word: `graduate` counts every NOTE line
// that does as a ramp still outstanding, so a value spelling it prints as `(unprintable)`.
/** @param {boolean} withheld @returns {(text: string) => string} */
const rampMask = (withheld) => (text) => (!withheld && /ramp/i.test(text) ? UNPRINTABLE : text)

/** @param {unknown} v @param {(text: string) => string} mask @returns {string} */
function factText(v, mask) {
  if (Array.isArray(v)) return `(${v.map((x) => factText(x, mask)).join(', ')})`
  if (isPlainObject(v)) {
    return `(${Object.entries(v)
      .map(([k, x]) => `${mask(k)} ${factText(x, mask)}`)
      .join(', ')})`
  }
  return typeof v === 'string' ? mask(`\`${v}\``) : String(v)
}

// The one NOTE line, from the validated record alone and in a fixed vocabulary.
/** @param {Record<string, any>} r */
function advisoryLine(r) {
  const mask = rampMask(r.status === 'ramp-withheld')
  const subject = r.subject
    .split(' ')
    .map((/** @type {string} */ id) => mask(subjectId.print(id)))
    .join(' and ')
  const key = advisoryKey(r).slice(0, 12)
  const parts = [
    `${r.producer}: NOTE — ${ADVISORY_STATUS_TEXT[r.status]} ${r.rule} \`${key}\` on ${subject}`,
  ]
  for (const [k, n] of Object.entries(r.counts ?? {})) parts.push(`${mask(k)} ${String(n)}`)
  if (r.until !== undefined) parts.push(`until ${r.until}`)
  for (const [k, v] of Object.entries(r.facts ?? {})) parts.push(`${mask(k)} ${factText(v, mask)}`)
  return parts.join(' · ')
}

/** @param {unknown} producer */
const refusedLine = (producer) =>
  `${isProducer(producer) ? producer : 'advisory'}: NOTE — a record was refused: it does not fit the closed advisory schema, so nothing was written`

/**
 * Record one advisory finding and print its NOTE line. Returns whether the record fit the
 * schema; it never throws and never exits.
 * @public the recorder producers call (#186); exported for tests/gates/gate-helpers.test.mjs
 * @param {unknown} record @param {{ print?: boolean }} [opts] @returns {boolean}
 */
export function noteAdvisory(record, { print = true } = {}) {
  let line = refusedLine(null)
  let accepted = false
  try {
    if (advisoryRecordOk(record)) {
      line = advisoryLine(record)
      accepted = true
      appendReport(
        ADVISORY_DIR,
        Object.fromEntries(
          RECORD_KEYS.filter((k) => record[k] !== undefined).map((k) => [k, record[k]]),
        ),
      )
    } else {
      line = refusedLine(/** @type {any} */ (record)?.producer)
    }
  } catch {
    // A record that throws while it is read (a getter, say) is refused like any other.
  }
  if (print) console.log(line)
  return accepted
}

/**
 * Record that a producer's leg ran to its verdict. Prints nothing; a producer outside the
 * closed set, or a leg that is not a name, writes nothing.
 * @param {{ producer: unknown, leg: unknown }} terminator
 */
export function noteComplete(terminator) {
  try {
    const { producer, leg } = terminator
    if (!isProducer(producer) || typeof leg !== 'string' || !NAME_RE.test(leg)) return
    appendReport(ADVISORY_DIR, { v: 1, producer, leg, complete: true })
  } catch {
    // Deliberately silent, like the record itself.
  }
}

// Prerequisite missing: loud local skip, hard CI failure.
/** @param {string} gate @param {string} reason @returns {never} */
export function skipOrFail(gate, reason) {
  if (inCI()) {
    noteMissingPrerequisite(gate, reason)
    console.error(
      `${gate}: FAIL — ${reason} (skips are not allowed in CI: set up the prerequisite or remove the surface)`,
    )
    printRemedy(gate)
    process.exit(1)
  }
  console.log(`${gate}: SKIPPED — ${reason} (this gate FAILS CLOSED in CI)`)
  process.exit(0)
}

export function failures(gate, list, hint) {
  if (list.length === 0) return
  console.error(`${gate}: FAIL (${list.length})`)
  for (const f of list) console.error(`  - ${f}`)
  if (hint) console.error(hint)
  printRemedy(gate)
  process.exit(1)
}

// ---- version-ramped checks ------------------------------------------------------
// A NEW check added to an EXISTING gate must not red a consumer whose seeded
// content predates it — projects grow into gates; gates never ambush an update.
// rampNote(gate, minVersion, detail, { until }) is the one shared ramp: it reads
// .harness/manifest.json and compares the install's baseVersion (the release
// vintage of its seeded content; older manifests fall back to harnessVersion)
// against the version the check went live in.
//   returns true  -> the caller must stay NOTE-only this run (a NOTE line naming
//                    the check, the ramp, the DEADLINE, and the graduation
//                    runbook is printed);
//   returns false -> the check is live: no manifest (template dev tree, gate
//                    fixtures, fresh pre-manifest runs), baseVersion >= min, or
//                    the deadline has passed.
// Corrupt manifest JSON FAILS CLOSED via fail(): .harness/ is write-guard-
// protected, so an unparseable manifest is tampering, not a ramp.
//
// `until` IS MANDATORY (0.3.0). Before it, "shipped ramped" meant "shipped
// disabled, indefinitely": rampNote downgraded a check to an advisory NOTE — in
// CI too — and the only thing that ever re-armed it was a human running
// `graduate`, which nothing nagged. A control whose expiry date is optional has
// no expiry date. A call site without one THROWS: that is a harness authoring
// bug, not a consumer problem, so it must not be reportable as a project gate
// failure. tests/gates/ramp-expiry.test.mjs closes it statically over every
// shipped call site, so the throw is the backstop and not the discovery path.
// SOURCE: docs/runbooks/harness-upgrade.md (version-ramp doctrine: NOTE on
// pre-ramp installs, hard-fail on fresh installs, expiry on the deadline)
// [corpus: harness/doctrine]

// Numeric dotted compare (the harness releases plain x.y.z tags); non-numeric
// fields compare as plain strings so a mangled version cannot compare as newest.
export function cmpDotted(a, b) {
  const pa = String(a).split('.')
  const pb = String(b).split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const na = Number.parseInt(pa[i] ?? '0', 10)
    const nb = Number.parseInt(pb[i] ?? '0', 10)
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      if ((pa[i] ?? '') !== (pb[i] ?? '')) return (pa[i] ?? '') < (pb[i] ?? '') ? -1 : 1
      continue
    }
    if (na !== nb) return na < nb ? -1 : 1
  }
  return 0
}

// The fail-closed read of the install record: null when there is none, the parsed object
// when it parses, and a FAIL naming the tampering when it does not. Exported (1.1.0) for the
// surface deferral's CLI, which compares apps/mobile/ against its records. `onCorrupt`, when
// given, runs before the FAIL: a caller with an output contract (tools/ci/surface-deferral.mjs
// --mode=pr owes $GITHUB_OUTPUT exactly two lines) writes its fail-safe values first.
/** @param {string} gate @param {() => void} [onCorrupt] */
export function readManifest(gate, onCorrupt) {
  const manifestPath = join('.harness', 'manifest.json')
  if (!existsSync(manifestPath)) return null
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (e) {
    onCorrupt?.()
    fail(
      gate,
      `${manifestPath} is not valid JSON (${e.message}) — it is write-guard-protected, so a corrupt manifest is tampering; restore it from git history`,
    )
  }
}

// The version of the harness CODE this install currently runs, or null when there is
// no install record (template dev tree, gate fixtures). Deliberately NOT baseVersion:
// baseVersion only moves when a human graduates a ramp, so a deadline measured
// against it is a deadline its own beneficiary controls. harnessVersion advances on
// every `installer update`, which is what makes an expiring escape actually expire.
// SOURCE: installer/lib/manifest.mjs (harnessVersion advances on update; baseVersion
// is a deliberate human graduation) [corpus: harness/doctrine]
export function installedHarnessVersion(gate) {
  const manifest = readManifest(gate)
  if (manifest === null) return null
  const v = manifest.harnessVersion ?? manifest.baseVersion
  return typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v) ? v : null
}

export function rampNote(gate, minVersion, detail, opts) {
  const until = opts?.until
  if (typeof until !== 'string' || !/^\d+\.\d+\.\d+$/.test(until)) {
    // Deliberately a throw, not fail(): fail() prints a FIX line pointing the
    // CONSUMER at a reproduce command, and there is nothing they can do about a
    // ramp the harness shipped without a deadline. An unhandled throw names the
    // file and line of the offending call site, which is who has to fix it.
    throw new TypeError(
      `rampNote('${gate}', '${minVersion}', …) was called without a valid \`until\` deadline (got ${JSON.stringify(until)}). ` +
        'Every ramp expires: pass { until: "<x.y.z>" } naming the release the escape ends in. ' +
        'A ramp with no deadline is a check shipped disabled. SOURCE: docs/runbooks/harness-upgrade.md (ramps expire)',
    )
  }
  if (cmpDotted(until, minVersion) <= 0) {
    throw new TypeError(
      `rampNote('${gate}', '${minVersion}', …) has until=${until}, which is not AFTER the ramp version — the escape would expire before or as it opens.`,
    )
  }
  const manifestPath = join('.harness', 'manifest.json')
  const manifest = readManifest(gate)
  if (manifest === null) return false // no install record -> the check is live
  const base = manifest.baseVersion ?? manifest.harnessVersion
  if (typeof base !== 'string' || !/^\d+\.\d+\.\d+/.test(base)) {
    fail(
      gate,
      `${manifestPath} carries no usable baseVersion/harnessVersion — restore it from git history (the ramp cannot fail open)`,
    )
  }
  if (cmpDotted(base, minVersion) >= 0) return false

  // The deadline is measured against harnessVersion, NOT baseVersion — see
  // installedHarnessVersion() above: baseVersion only moves when the ramp's own
  // beneficiary graduates, so a deadline measured against it never arrives.
  const live = installedHarnessVersion(gate)
  if (live !== null && cmpDotted(live, until) >= 0) {
    console.error(
      `${gate}: RAMP EXPIRED — ${detail} was ramped from baseVersion ${minVersion} with a deadline of ${until}, and this install runs harness ${live}. ` +
        'The escape is over: the finding below is a hard failure now. Sweep it, then `npx next-expo-supabase-agent-harness@latest graduate`; ' +
        'see docs/runbooks/harness-upgrade.md (ramps expire).',
    )
    return false
  }
  // `log` (1.1.0) prints the NOTE line elsewhere than stdout, for the one caller whose stdout
  // is data: tools/mutation-scope.mjs, whose stdout is Stryker's --mutate list.
  const log = typeof opts?.log === 'function' ? opts.log : console.log
  log(
    `${gate}: NOTE — ${detail} (ramp: live from baseVersion ${minVersion}; this install's baseVersion is ${base}; expires in ${until}). Sweep the findings, then graduate deliberately by bumping baseVersion in .harness/manifest.json — a human edit; see docs/runbooks/harness-upgrade.md`,
  )
  noteWithheld(gate, opts?.subject, until)
  return true
}

// `subject` (2.1.0, #185), `{ rule, subject }`: a ramp that withholds a converted producer's
// finding also records it, as `ramp-withheld` and printing nothing, so the NOTE line above
// is the one it always was. It rides the fourth argument, because scripts/lib/ramp-sites.mjs
// reads every call's third as the escape's id. A withheld record has no fingerprint of its
// own, so its `fp` is its key12.
/** @param {string} gate @param {unknown} subject @param {string} until */
function noteWithheld(gate, subject, until) {
  if (!isPlainObject(subject)) return
  const record = {
    v: 1,
    producer: gate,
    rule: subject.rule,
    status: 'ramp-withheld',
    subject: subject.subject,
  }
  try {
    noteAdvisory({ ...record, fp: advisoryKey(record).slice(0, 12), until }, { print: false })
  } catch {
    // advisoryKey reads the parts as strings; one that cannot be read leaves no record.
  }
}

// ---- subprocess capture contract ----------------------------------------------
// One ceiling for every captured gate subprocess: node's 1 MB default
// ENOBUFS-crashes on real monorepo output instead of failing with a named
// gate error.
export const MAX_BUFFER = 64 * 1024 * 1024

// runCmd: execSync under the shared capture contract — utf8, MAX_BUFFER, stdin
// ignored, stdout/stderr piped so a failure still surfaces via e.stdout/e.stderr.
export function runCmd(cmd, opts = {}) {
  return execSync(cmd, {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  })
}

// commandFailureOutput: the one idiom for reporting a captured subprocess
// failure. Both streams, stdout first (expo/pnpm/playwright write diagnostics
// there), each coerced (Buffer-safe) and trimmed; e.message only when the
// combined output is empty. The retired per-site idiom
// `e.stderr?.toString() ?? e.message` had two holes this closes: '' is not
// nullish (a tool that wrote nothing to stderr produced an EMPTY failure
// detail), and stdout was dropped entirely. Callers keep their own shaping
// (head/tail slice, first-N-lines) over the return value.
export function commandFailureOutput(e) {
  const parts = [e.stdout, e.stderr].map((s) => (s == null ? '' : String(s).trim())).filter(Boolean)
  if (parts.length > 0) return parts.join('\n')
  return String(e.message ?? e)
}

// ---- content-addressed stamps (generalized from the source harness's toolchain stamp) ----
// hashInputs: one sha256 over the declared input paths (files or directories,
// recursive, name+bytes, sorted walk so the digest is order-stable). A missing
// path (absent, or beneath a regular file) contributes its name —
// appearing/disappearing invalidates the stamp. Any OTHER reason a path cannot be
// opened (a symlink loop, EACCES on a parent, an invalid name) throws: hashing it
// as missing would let a stamp go stale-green over an input nobody could read.
// Each path is opened ONCE. A FILE input is typed and read through that one
// descriptor, so the test and the read see the same inode; a directory is typed
// through it and then walked by path, as before.
// Excluded dirs are the tree's own churn, never review-worthy input: build output
// ('.next'/'.expo'/'.turbo'), the Stop chain's own coverage maps ('coverage' — without
// it the `contracts` stamp's bare apps/packages roots self-invalidate every turn),
// and '.git'.
const STAMP_EXCLUDES = new Set([
  'node_modules',
  'target',
  'dist',
  'gen',
  'test-results',
  '.next',
  '.expo',
  '.turbo',
  'coverage',
  '.git',
])

/** @public exported for the harness repo's gate suite (tests/gates/hash-inputs.test.mjs) */
export function hashInputs(paths) {
  const h = createHash('sha256')
  for (const p of [...paths].sort()) {
    let fd
    try {
      fd = openSync(p, 'r')
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e
      h.update(`missing:${p}`)
      continue
    }
    // The whole walk stays inside the try: readFileSync(fd) never closes a descriptor it
    // was given, and a throw mid-walk must not leak the directory's handle.
    try {
      if (fstatSync(fd).isDirectory()) {
        const root = toPosix(p)
        for (const rel of walkFiles(p, { excludeDirs: STAMP_EXCLUDES })) {
          h.update(`${root}/${rel}`)
          h.update(readFileSync(`${p}/${rel}`))
        }
      } else {
        h.update(toPosix(p))
        h.update(readFileSync(fd))
      }
    } finally {
      closeSync(fd)
    }
  }
  return h.digest('hex')
}

// stampGate: if every declared input is byte-identical to the last GREEN run
// (stamp in .harness/<gate>.ok) and we are not in CI, report STAMPED instantly.
// CI always runs the real check — a stamp is a local convenience, never proof.
// Returns recordGreen(); the gate calls it right before its final ok(). Input
// completeness is reviewed data in tools/lib/stamp-inputs.mjs — an undeclared
// input class is a stale-pass bug, so tests/gates/gate-helpers.test.mjs holds every
// list to its script's whole import closure.
//
// A HIT IS ITS OWN STATUS (1.0.4). Through 1.0.3 it printed through ok(), so a turn that
// ended on warm stamps read exactly like one that re-proved everything; the Stop hook now
// lists `<gate>: STAMPED — ` lines beside its skipped layers. The exit stays 0.
//
// `salt` (1.0.4) is state no declared file carries, mixed into the digest: the rls runner
// passes the Supabase CLI version and the running database's identity, because a reset, a
// restart or an applied migration changes what its suites would conclude and edits no file.
// Omitted, the digest is hashInputs(inputs) exactly as before. Keep `salt` a plain third
// parameter (no default value): tests/rls/run-rls.mjs reads `stampGate.length` to tell this
// signature from 1.0.3's, which would drop the salt.
// SOURCE: docs/harness/README.md (stamped gates) [corpus: harness/doctrine]
/** @param {string} gate @param {string[]} inputs @param {string} [salt] */
export function stampGate(gate, inputs, salt) {
  const stampPath = join('.harness', `${gate}.ok`)
  const digest = stampDigest(inputs, salt)
  if (!inCI() && existsSync(stampPath) && readFileSync(stampPath, 'utf8').trim() === digest) {
    stamped(gate, `inputs unchanged since last green run (${stampPath}; CI always re-runs)`)
  }
  return function recordGreen() {
    mkdirSync('.harness', { recursive: true })
    writeFileSync(stampPath, digest)
  }
}

/** @param {string[]} inputs @param {string | undefined} salt */
function stampDigest(inputs, salt) {
  const inputsDigest = hashInputs(inputs)
  if (salt === undefined) return inputsDigest
  return createHash('sha256')
    .update(`${inputsDigest}\0${String(salt)}`)
    .digest('hex')
}

// The phrase after the dash is load-bearing: tests, the selftest's warm-lane control and
// graduate's comments match on "inputs unchanged since last green run".
/** @param {string} gate @param {string} msg @returns {never} */
function stamped(gate, msg) {
  console.log(`${gate}: STAMPED — ${msg}`)
  process.exit(0)
}
