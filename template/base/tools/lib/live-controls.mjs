// tools/lib/live-controls.mjs — "what actually runs here", and "what covers only half the
// product", as one definition instead of four.
//
// THE DEFECT THIS CLOSES. check-docs-sync.mjs resolved every `Compensated by` cell in
// docs/harness/enforcement-tiers.md against ONE hard-coded workflow filename while eight
// ship. That is the identical defect check-canary-coverage.mjs corrected in 0.3.0 — a
// closure written against the merge gate because that is where most lanes live, and the
// single filename made the other seven invisible. A row compensated by `gitleaks` or
// `scan-pr` resolved to nothing and was reported as naming a control that does not exist.
//
// AND THE SECOND ONE, which is worse because it reads as working. Eleven tier rows name
// `web-e2e` or `perf-lane`, and BOTH are path-filtered: they do not run on a PR that does
// not touch their paths, and tools/ci/summarize-gate.mjs deliberately greens over a skipped
// lane after naming it. "This control exists" and "this control ran on this commit" are
// different claims, and the table was making the second while checking the first. A chain
// gate runs on a developer's laptop with no CI run to consult, so it cannot ask which lanes
// ran — what it CAN do, from the workflow text alone, is tell a conditional job from an
// unconditional one and require the row to say which it named. That is the honest version
// of the assertion, and it is decidable offline.
//
// DIRECTION OF THE DEPENDENCY. This lives under template/base/tools/lib/ and scripts/
// imports IT, never the reverse: the npm `files` list ships only installer/ and template/,
// so a template gate importing scripts/check-tier-coverage.mjs would resolve on the
// harness's own checkout and be missing on every install.
// SOURCE: scripts/check-canary-coverage.mjs (the 0.3.0 one-workflow correction)
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A job's `if:` expression, INCLUDING the folded-scalar body.
 *
 * Every conditional lane in the shipped merge gate is written `if: >-` with the expression
 * on the following lines, because the conditions are three clauses long. A one-line regex
 * captures `>-` and nothing else — which reads as "this job has no condition" and would
 * have made the path-filter rule below silently find zero conditional jobs. So the value is
 * the `if:` line plus every immediately-following line indented deeper than the key.
 * @param {string} block one job's text
 * @returns {string}
 */
function jobIf(block) {
  const lines = block.split('\n')
  const at = lines.findIndex((l) => /^ {4}if:/.test(l))
  if (at === -1) return ''
  const out = [lines[at].replace(/^ {4}if:/, '')]
  for (const line of lines.slice(at + 1)) {
    if (!/^ {5,}\S/.test(line)) break
    out.push(line)
  }
  return out.join(' ')
}

/**
 * Job ids in one workflow file, and which of them are CONDITIONAL.
 *
 * Conditional means the job carries an `if:` that consults the paths-filter job — the
 * shape `needs.changes.outputs.<name>`. A job gated on an event name (`schedule`,
 * `workflow_dispatch`) is conditional too, and is reported as such: a nightly lane is a
 * real control but it is not one that ran on this commit either.
 * @param {string} text
 * @returns {{ ids: string[], conditional: string[], invokes: Map<string, boolean> }}
 */
function jobsIn(text) {
  const at = text.indexOf('\njobs:')
  if (at === -1) return { ids: [], conditional: [], invokes: new Map() }
  const body = text.slice(at)
  const ids = []
  const conditional = []
  /** gate-script basename -> was EVERY job that invokes it conditional? */
  const invokes = new Map()
  // Split on top-level job keys (two-space indent, then a bare identifier and a colon), so
  // each job's own block can be read for its `if:` without a YAML parser.
  const starts = [...body.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)]
  for (const [i, m] of starts.entries()) {
    const id = m[1]
    ids.push(id)
    const block = body.slice(m.index, starts[i + 1]?.index ?? body.length)
    const isConditional = /needs\.[a-z0-9-]+\.outputs\.|github\.event_name/.test(jobIf(block))
    if (isConditional) conditional.push(id)
    // Two tier rows name a gate SCRIPT rather than a step or a job (`check-e2e-device.mjs`
    // compensates `check-web-e2e.mjs` and vice versa — they are lane RUNNERS, not chain
    // steps). Before 0.5.0 the cell parser matched kebab names only, so a `.mjs` name
    // resolved to nothing at all: those two rows were silently exempt from the very check
    // this table exists for, and nobody had said which two. Recording which jobs invoke a
    // script is what lets a script-named control be judged like any other.
    for (const s of block.matchAll(/tools\/([\w.-]+\.mjs)/g)) {
      invokes.set(s[1], (invokes.get(s[1]) ?? true) && isConditional)
    }
  }
  return { ids, conditional, invokes }
}

/**
 * Everything that may legitimately be named as a control, and which of those are
 * conditional.
 *
 * @param {{ steps: Iterable<string>, workflowDir: string }} input
 *   `steps` is VALIDATE_STEPS ∪ STOP_HOOK_STEPS — always unconditional, since the chain
 *   runs in full on every validate. `workflowDir` is the directory to read: an install's
 *   `.github/workflows`, or the harness's `template/base/github/workflows`.
 * @returns {{ live: Set<string>, conditional: Set<string>, workflows: number }}
 */
export function liveControls({ steps, workflowDir }) {
  const live = new Set(steps)
  const conditional = new Set()
  let workflows = 0
  let files = []
  try {
    files = readdirSync(workflowDir)
      .filter((f) => /\.ya?ml$/.test(f))
      .sort()
  } catch {
    // No workflow directory is a legitimate state (a scaffold with CI removed). The caller
    // decides what an empty job set means; inventing one here would be worse.
    return { live, conditional, workflows: 0 }
  }
  /** script basename -> conditional only if EVERY invoking job across every workflow is. */
  const scriptCond = new Map()
  for (const f of files) {
    workflows += 1
    const { ids, conditional: cond, invokes } = jobsIn(readFileSync(join(workflowDir, f), 'utf8'))
    for (const id of ids) live.add(id)
    for (const id of cond) conditional.add(id)
    for (const [script, isCond] of invokes) {
      scriptCond.set(script, (scriptCond.get(script) ?? true) && isCond)
    }
  }
  // A gate SCRIPT a lane invokes is a nameable control too — see jobsIn's note on the two
  // tier rows that name one. It carries the conditionality of the lanes that run it: a
  // script invoked only by path-filtered jobs did not run on a commit those jobs skipped,
  // which is the same fact about a different noun.
  for (const [script, isCond] of scriptCond) {
    live.add(script)
    if (isCond) conditional.add(script)
  }
  return { live, conditional, workflows }
}

// A surface literal in a scan-root POSITION — assigned to a const, pushed onto a roots
// array, or handed to a walker. Deliberately not "the file mentions apps/mobile anywhere":
// every gate's prose names both surfaces, and a comment is not a scan root.
const SCAN_ROOT_RE =
  /(?:const\s+\w+\s*=\s*|\[\s*|,\s*|join\(\s*)'(apps\/(?:mobile|web)(?:\/[\w.-]+)*)'/g

/**
 * Gate scripts that hard-code exactly ONE product surface as a scan root.
 *
 * Shared so that the factory control (scripts/check-tier-coverage.mjs: "every one-surface
 * gate declares its surface") and the chain control (check-docs-sync.mjs: "a Target that
 * has arrived must have closed its gap") derive the same set. Two copies of this
 * derivation would let a gate be single-surface for one of them and not the other, which
 * is the shape of disagreement this whole module exists to prevent.
 *
 * @param {{ toolsDir: string, configText?: string }} input
 * @returns {Array<{ file: string, key: string, roots: string[], surface: string }>}
 */
export function singleSurfaceGates({ toolsDir, configText = '' }) {
  // script basename -> the chain/Stop STEP it implements. Derived from the config's
  // commands rather than from the filename, because the two differ (`styleguide` runs
  // check-styleguide-manifest.mjs, `build` runs build-check.mjs) and a filename-only key
  // would demand rows nobody would think to write under those names.
  const stepFor = new Map()
  for (const m of configText.matchAll(/\[\s*'([\w-]+)'\s*,\s*'([^']*)'/g)) {
    for (const s of m[2].matchAll(/tools\/([\w.-]+\.mjs)/g)) stepFor.set(s[1], m[1])
  }

  // `build-check.mjs` is why the second half of this filter exists — a `check-*` prefix
  // alone silently exempts the build gate, and an exemption nobody chose is the failure.
  const files = readdirSync(toolsDir)
    .sort()
    .filter((f) => f.endsWith('.mjs') && (f.startsWith('check-') || stepFor.has(f)))

  const out = []
  for (const file of files) {
    const src = readFileSync(join(toolsDir, file), 'utf8')
    const roots = new Set()
    for (const m of src.matchAll(SCAN_ROOT_RE)) {
      // Strip a `//`-commented line the same way the ramp scanner does.
      const line = src.slice(src.lastIndexOf('\n', m.index) + 1, m.index)
      if (line.includes('//') || /^\s*\*/.test(line)) continue
      roots.add(m[1])
    }
    if (roots.size === 0) continue
    const surfaces = new Set([...roots].map((r) => r.split('/')[1]))
    if (surfaces.size !== 1) continue // reaches both surfaces — nothing to declare
    out.push({
      file,
      key: stepFor.get(file) ?? file.replace(/^check-|\.mjs$/g, ''),
      roots: [...roots].sort(),
      surface: [...surfaces][0],
    })
  }
  return out
}
