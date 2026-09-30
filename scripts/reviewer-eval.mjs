#!/usr/bin/env node
// The reviewer eval (1.1.0, #66): a corpus of seeded changes, each with the verdict a reviewer
// must return, and a score for a set of recorded replies.
//
// WHY. Nothing measured the reviewers. A change to a reviewer body, or to the model behind
// it, shipped on judgement: the only checks that read a body asked whether its frontmatter
// parsed, which tools it held and where its verdict demand sat. 1.0.2 is this repository's
// own example of what that misses. Seven tables kept `authenticated`'s default write
// privileges because a REVOKE was absent, and a CI lane found it, not review.
//
// THE CORPUS, tests/fixtures/reviewer-eval/<case>/:
//   case.json   { "reviewer", "kind", "expect": "PASS"|"BLOCK", "mustName": [row ids],
//                 "twin", "why", "edits"? }
//   overlay/    NEW files written over a core-tier install, each stored as `<path>.txt` so
//               the root lint, tsc, knip and `node --test` never read one as repository
//               code; the eval strips the suffix when it writes the file.
//   edits       anchored line edits to a file the install already has (a register row, a
//               catalog key): { "path", "after"|"before"|"replace": "<one whole line>",
//               "lines" } inserts the lines after or before the anchor, or puts them in its
//               place. The anchor must match exactly one line, so an edit that no longer
//               applies says so instead of landing somewhere else. Shared files are edited,
//               never copied whole, so a case keeps applying when those files change
//               around it.
// Every kind of change the design record names (a table, a function, an Edge Function, a
// web page, a screen) has an absence case, which must BLOCK and name every `mustName` id,
// and a complete control twin, which must PASS. So a reviewer that always answers PASS
// scores at most half, and so does one that always answers BLOCK. Every `mustName` id is a
// row of the reviewer's `## WHAT MUST ACCOMPANY IT` table (scripts/lib/companion-table.mjs).
//
// THE MODES.
//   --check              validate the corpus offline: shape, twins, ids, trigger ownership
//                        (tools/reviewer-triggers.json must owe the case's reviewer), and
//                        that every overlay applies to a fresh core-tier install.
//   --score <dir>        score one recorded final message per case, `<dir>/<case>.txt`. The
//                        verdict is classifyVerdict()'s, the one the SubagentStop hook uses;
//                        a reply with no verdict, or no reply, is a miss; a BLOCK counts only
//                        when every `mustName` id appears in it as a whole id.
//   --live <dir>         record those replies: for each case, a fresh core-tier install with
//                        the case applied, then `claude -p --agent <reviewer>` in it, with
//                        every hook off (an install's Stop hook would run the whole chain)
//                        and no MCP servers. The agent's pin decides the model, because
//                        `--model` would override it; which model ran is read back from the
//                        run's `modelUsage` and written to `<dir>/live.json`. How `--agent`
//                        treats the body, the tools and the pin was probed at Claude Code
//                        2.1.285 (design/CONTROL-PLANE-FACTS.md, Fact 17).
//                        `--case <name>` (repeatable) narrows the run; `--claude <bin>` names
//                        the binary.
//   --corpus <dir>       read another corpus (the tests use this for malformed ones).
//
// THE GUARD. The eval gates nothing. It exits 0 whatever the score, and 1 only on a
// malformed corpus or bad usage. It is not a chain step, a hook, a workflow or a lint.yml
// check, and `--live` runs only on a maintainer's machine: it spends model calls, needs
// credentials, and refuses to run under the test runner. A score threshold needs its own
// gate-proposal. The name is deliberately not check-*.mjs, which would put it in the
// factory-gate canary closure (scripts/check-canary-coverage.mjs).
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { init } from '../installer/commands/init.mjs'
import { modelPolicy, REVIEWER_AGENTS } from '../template/base/tools/lib/agent-roster.mjs'
import { classifyVerdict, modelMatches, owedByTurn } from '../template/base/tools/lib/reviewer-verdicts.mjs'
import { companionTable } from './lib/companion-table.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CORPUS = join(ROOT, 'tests/fixtures/reviewer-eval')
const AGENTS_DIR = join(ROOT, 'template/base/.claude/agents')
const TRIGGERS = join(ROOT, 'template/base/tools/reviewer-triggers.json')

export const KINDS = ['table', 'function', 'edge-function', 'web-page', 'screen']
const EXPECTS = new Set(['PASS', 'BLOCK'])
const SUFFIX = '.txt'
const INIT_SET = ['PROJECT_NAME=Fixture App', 'GITHUB_OWNER=fixture-owner', 'SECURITY_OWNERS=@fixture-owner/security']
const LIVE_TIMEOUT_MS = 15 * 60 * 1000
export const USAGE = [
  'usage: node scripts/reviewer-eval.mjs --check [--corpus <dir>]',
  '       node scripts/reviewer-eval.mjs --score <replies-dir> [--corpus <dir>]',
  '       node scripts/reviewer-eval.mjs --live <out-dir> [--case <name>]... [--claude <bin>] [--corpus <dir>]',
].join('\n')

// ── the corpus ───────────────────────────────────────────────────────────────────────────

/** Every file under `dir`, as POSIX paths relative to it. */
function walk(dir, prefix = '') {
  /** @type {string[]} */
  const out = []
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const rel = prefix === '' ? e.name : `${prefix}/${e.name}`
    if (e.isDirectory()) out.push(...walk(join(dir, e.name), rel))
    else out.push(rel)
  }
  return out.sort()
}

/** A case directory's overlay: each stored file, the install path it writes, and its source. */
function overlayOf(caseDir) {
  const base = join(caseDir, 'overlay')
  return walk(base).map((stored) => ({
    stored,
    path: stored.endsWith(SUFFIX) ? stored.slice(0, -SUFFIX.length) : stored,
    source: join(base, ...stored.split('/')),
  }))
}

/** @param {string} caseDir @returns {Record<string, any>|string} */
function readCaseJson(caseDir) {
  let raw
  try {
    raw = readFileSync(join(caseDir, 'case.json'), 'utf8')
  } catch {
    return 'no case.json'
  }
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : 'case.json is not an object'
  } catch {
    return 'case.json does not parse'
  }
}

/**
 * Read a corpus. A directory whose case.json is missing or does not parse is a problem, not
 * a case; everything else is loaded as it stands and judged by corpusProblems().
 * @param {string} [dir]
 */
export function loadCorpus(dir = CORPUS) {
  /** @type {any[]} */
  const cases = []
  /** @type {string[]} */
  const problems = []
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return { cases, problems: [`${dir}: no corpus directory`] }
  }
  for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) {
      problems.push(`${e.name}: not a case directory`)
      continue
    }
    const caseDir = join(dir, e.name)
    const parsed = readCaseJson(caseDir)
    if (typeof parsed === 'string') problems.push(`${e.name}: ${parsed}`)
    else cases.push({ ...parsed, name: e.name, dir: caseDir, overlay: overlayOf(caseDir), edits: parsed.edits ?? [] })
  }
  return { cases, problems }
}

/** The install paths a case writes: its overlay files and the files its edits change. */
export function caseChanges(c) {
  return [...new Set([...(c.overlay ?? []).map((o) => o.path), ...(c.edits ?? []).map((e) => e.path)])].sort()
}

const ANCHORS = ['after', 'before', 'replace']
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!\.harness\/)(?!\.git\/)[^\\:*?"<>|]+$/

/** What is wrong with one edit, one sentence each. */
function editProblems(e) {
  if (e === null || typeof e !== 'object') return ['an edit must be an object']
  const problems = []
  if (typeof e.path !== 'string' || !SAFE_PATH.test(e.path)) problems.push(`edit path ${JSON.stringify(e.path)} is not a safe install path`)
  const anchors = ANCHORS.filter((k) => typeof e[k] === 'string' && e[k].trim() !== '')
  if (anchors.length !== 1) {
    problems.push(`edit ${String(e.path)}: name exactly one anchor, "after", "before" or "replace", as one whole line`)
  }
  if (!Array.isArray(e.lines) || e.lines.length === 0 || !e.lines.every((l) => typeof l === 'string')) {
    problems.push(`edit ${String(e.path)}: "lines" must be a non-empty array of strings`)
  }
  return problems
}

/** The ids of a reviewer's companion rows, or null when the body has no table. */
function rowIdsOf(reviewer, agentsDir) {
  try {
    const table = companionTable(readFileSync(join(agentsDir, `${reviewer}.md`), 'utf8'))
    return table.headingLines.length === 1 && table.problems.length === 0 ? new Set(table.rows.map((r) => r.id)) : null
  } catch {
    return null
  }
}

/** What is wrong with a case's `mustName`, given its verdict and its reviewer's row ids. */
function mustNameProblems(c, ids) {
  const must = c.mustName
  if (!Array.isArray(must) || !must.every((id) => typeof id === 'string')) return ['mustName must be an array of row ids']
  if (c.expect === 'BLOCK' && must.length === 0) return ['a BLOCK case names at least one row id in mustName']
  if (c.expect === 'PASS' && must.length > 0) return ['a PASS case names no row ids: mustName is []']
  if (ids === null) return []
  return must.filter((id) => !ids.has(id)).map((id) => `mustName names ${id}, which is not a row of ${c.reviewer}'s companion table`)
}

/** The fields of one case, judged on their own. */
function fieldProblems(c, agentsDir) {
  const problems = []
  const known = REVIEWER_AGENTS.includes(c.reviewer)
  if (!known) problems.push(`reviewer ${JSON.stringify(c.reviewer)} is not a reviewer agent`)
  if (!KINDS.includes(c.kind)) problems.push(`kind must be one of ${KINDS.join(', ')}`)
  if (!EXPECTS.has(c.expect)) problems.push('expect must be PASS or BLOCK')
  if (typeof c.why !== 'string' || c.why.trim() === '') problems.push('why must say what the case seeds')
  const ids = known ? rowIdsOf(c.reviewer, agentsDir) : null
  if (known && ids === null) problems.push(`${c.reviewer} has no well-formed companion table`)
  return [...problems, ...mustNameProblems(c, ids)]
}

/** The overlay and edits of one case, judged on their own. */
function changeProblems(c) {
  const problems = []
  if (c.overlay.length === 0 && c.edits.length === 0) problems.push('the case changes nothing: add overlay files or edits')
  for (const o of c.overlay) {
    if (!o.stored.endsWith(SUFFIX)) problems.push(`overlay/${o.stored}: stored files end in ${SUFFIX}`)
    if (!SAFE_PATH.test(o.path)) problems.push(`overlay/${o.stored}: ${o.path} is not a safe install path`)
  }
  if (!Array.isArray(c.edits)) return [...problems, 'edits must be an array']
  for (const e of c.edits) problems.push(...editProblems(e))
  return problems
}

/** The twin rule: two cases that name each other, one reviewer, one kind, opposite verdicts. */
function twinProblems(c, byName) {
  const twin = typeof c.twin === 'string' ? byName.get(c.twin) : undefined
  if (twin === undefined) return [`twin ${JSON.stringify(c.twin)} is not a case in the corpus`]
  const problems = []
  if (twin.twin !== c.name) problems.push(`twin ${twin.name} does not name ${c.name} back`)
  if (twin.reviewer !== c.reviewer || twin.kind !== c.kind) problems.push(`twin ${twin.name} is judged by another reviewer or is another kind`)
  if (twin.expect === c.expect) problems.push(`twin ${twin.name} expects the same verdict: one twin BLOCKs, the other PASSes`)
  return problems
}

/**
 * Everything wrong with a corpus, one sentence each, prefixed with the case name: [] when it
 * is whole. Pure apart from reading the reviewer bodies and the trigger table.
 * @param {{ cases: any[], problems: string[] }} corpus
 * @param {{ agentsDir?: string, triggers?: any }} [opts]
 */
export function corpusProblems(corpus, opts = {}) {
  const agentsDir = opts.agentsDir ?? AGENTS_DIR
  const triggers = opts.triggers ?? JSON.parse(readFileSync(TRIGGERS, 'utf8'))
  const byName = new Map(corpus.cases.map((c) => [c.name, c]))
  const problems = [...corpus.problems]
  for (const c of corpus.cases) {
    const own = [...fieldProblems(c, agentsDir), ...changeProblems(c), ...twinProblems(c, byName)]
    const owed = owedByTurn(caseChanges(c), triggers).map((o) => o.agent)
    if (REVIEWER_AGENTS.includes(c.reviewer) && !owed.includes(c.reviewer)) {
      own.push(`its files do not make ${c.reviewer} owed by tools/reviewer-triggers.json`)
    }
    problems.push(...own.map((p) => `${c.name}: ${p}`))
  }
  for (const kind of KINDS) {
    for (const expect of EXPECTS) {
      if (!corpus.cases.some((c) => c.kind === kind && c.expect === expect)) problems.push(`corpus: no ${kind} case that expects ${expect}`)
    }
  }
  return problems
}

// ── applying a case ──────────────────────────────────────────────────────────────────────

/** Write an edit's lines at its anchor. Returns the 1-based line range written, or a problem. */
function applyEdit(e, installDir) {
  const target = join(installDir, e.path)
  let text
  try {
    text = readFileSync(target, 'utf8')
  } catch {
    return `${e.path}: not in the install — an edit changes a file the install already has`
  }
  const kind = ANCHORS.find((k) => typeof e[k] === 'string')
  const anchor = e[kind]
  const lines = text.split('\n')
  const at = lines.flatMap((l, i) => (l.trimEnd() === anchor ? [i] : []))
  if (at.length !== 1) {
    return `${e.path}: the anchor ${JSON.stringify(anchor)} matches ${String(at.length)} lines — it must match exactly one`
  }
  const start = kind === 'after' ? at[0] + 1 : at[0]
  lines.splice(start, kind === 'replace' ? 1 : 0, ...e.lines)
  writeFileSync(target, lines.join('\n'))
  return { path: e.path, from: start + 1, to: start + e.lines.length }
}

/**
 * Write a case into an install: every overlay file as a NEW file (an existing one is a
 * problem, never overwritten) and every edit at its anchor. Returns the paths written, the
 * inserted line ranges, and the problems.
 * @param {any} c @param {string} installDir
 */
export function applyCase(c, installDir) {
  const problems = []
  const written = new Set()
  const inserted = []
  for (const o of c.overlay ?? []) {
    const target = join(installDir, ...o.path.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    try {
      writeFileSync(target, readFileSync(o.source), { flag: 'wx' })
      written.add(o.path)
    } catch (err) {
      problems.push(
        err?.code === 'EEXIST'
          ? `${o.path}: already exists in the install — an overlay adds NEW files; change an existing one with an anchored edit`
          : `${o.path}: could not be written (${String(err?.message ?? err)})`,
      )
    }
  }
  for (const e of c.edits ?? []) {
    const r = applyEdit(e, installDir)
    if (typeof r === 'string') problems.push(r)
    else {
      written.add(e.path)
      inserted.push(r)
    }
  }
  return { changed: [...written].sort(), inserted, problems }
}

// ── scoring ──────────────────────────────────────────────────────────────────────────────

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whether `text` names `id` as a whole id, not as part of a longer one. */
const namesId = (text, id) => new RegExp(`(?<![A-Za-z0-9-])${escapeRe(id)}(?![A-Za-z0-9-])`).test(text)

function scoreOne(c, reply) {
  const replied = typeof reply === 'string'
  const got = replied ? classifyVerdict(reply).verdict : null
  const missing = c.expect === 'BLOCK' ? c.mustName.filter((id) => !(replied && namesId(reply, id))) : []
  return { case: c.name, expect: c.expect, got, hit: got === c.expect && missing.length === 0, missing, replied }
}

/**
 * Score a reply set. A case scores when the reply's verdict is the one it expects and, for a
 * BLOCK, when the reply names every `mustName` id; a missing reply, or one with no verdict
 * classifyVerdict() can read, is a miss.
 * @param {any[]} cases @param {Record<string, string|undefined>} replies
 */
export function scoreReplies(cases, replies) {
  const results = cases.map((c) => scoreOne(c, Object.hasOwn(replies, c.name) ? replies[c.name] : undefined))
  return { hits: results.filter((r) => r.hit).length, total: results.length, results }
}

/** `<dir>/<case>.txt` for each case, when present. */
function readReplies(dir, cases) {
  /** @type {Record<string, string>} */
  const replies = {}
  for (const c of cases) {
    try {
      replies[c.name] = readFileSync(join(dir, `${c.name}.txt`), 'utf8')
    } catch {
      // No reply recorded: scoreReplies counts it as a miss.
    }
  }
  return replies
}

function readLiveRecord(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'live.json'), 'utf8'))
  } catch {
    return null
  }
}

function printScore(cases, dir) {
  const { hits, total, results } = scoreReplies(cases, readReplies(dir, cases))
  const live = readLiveRecord(dir)
  const width = Math.max(...cases.map((c) => c.name.length))
  for (const r of results) {
    const model = live?.cases?.[r.case]?.models?.join(',')
    const detail = [
      `expect ${r.expect}`,
      `got ${r.replied ? String(r.got) : 'no reply'}`,
      r.missing.length > 0 ? `missing ${r.missing.join(', ')}` : '',
      model ? `model ${model}` : '',
    ].filter((s) => s !== '')
    console.log(`${r.hit ? 'HIT ' : 'MISS'} ${r.case.padEnd(width)}  ${detail.join(' · ')}`)
  }
  console.log(`score: ${String(hits)}/${String(total)}`)
}

// ── --live ───────────────────────────────────────────────────────────────────────────────

/** A fresh core-tier install in a new temp directory, with the installer's chatter swallowed. */
async function scratchInstall(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const saved = { log: console.log, warn: console.warn, error: console.error }
  const sink = () => undefined
  Object.assign(console, { log: sink, warn: sink, error: sink })
  try {
    const code = await init({ dir, tier: 'core', yes: true, set: INIT_SET })
    if (code !== 0) throw new Error(`init exited ${String(code)}`)
  } finally {
    Object.assign(console, saved)
  }
  return dir
}

/** The message the reviewer is dispatched with: the whole diff, since there is no history. */
function livePrompt(c, applied) {
  const created = (c.overlay ?? []).map((o) => `- ${o.path}`)
  const edited = applied.inserted.map((r) => `- ${r.path} (lines ${String(r.from)}-${String(r.to)} are new)`)
  return [
    'Review a change to this repository. There is no git history to diff against: the files below are the whole change.',
    '',
    ...(created.length > 0 ? ['New files:', ...created, ''] : []),
    ...(edited.length > 0 ? ['Edited files:', ...edited, ''] : []),
    'Read them, and whatever else your instructions send you to, then review the change as your instructions direct: report every companion row that applies, and end with the verdict line.',
  ].join('\n')
}

/** Run one reviewer over one applied case. Returns the reply and the models that ran it. */
function runReviewer(c, installDir, prompt, claude) {
  const r = spawnSync(
    claude,
    [
      '-p',
      '--agent',
      c.reviewer,
      '--settings',
      JSON.stringify({ disableAllHooks: true }),
      '--strict-mcp-config',
      '--output-format',
      'json',
      '--no-session-persistence',
      prompt,
    ],
    { cwd: installDir, encoding: 'utf8', timeout: LIVE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
  )
  if (r.error) return { error: String(r.error.message) }
  let out
  try {
    out = JSON.parse(r.stdout)
  } catch {
    return { error: `exit ${String(r.status)}, no JSON result: ${(r.stderr || r.stdout).trim().slice(0, 300)}` }
  }
  if (out.is_error || typeof out.result !== 'string') return { error: `the run ended ${String(out.subtype)}` }
  return { reply: out.result, models: Object.keys(out.modelUsage ?? {}) }
}

async function liveCase(c, outDir, claude) {
  const dir = await scratchInstall(`reviewer-eval-live-${c.name}-`)
  try {
    const applied = applyCase(c, dir)
    if (applied.problems.length > 0) return { error: applied.problems.join('; ') }
    const policy = modelPolicy(readFileSync(join(dir, '.claude/agents', `${c.reviewer}.md`), 'utf8'))
    const run = runReviewer(c, dir, livePrompt(c, applied), claude)
    if (run.reply !== undefined) writeFileSync(join(outDir, `${c.name}.txt`), run.reply)
    const models = run.models ?? []
    const onPin = models.length > 0 && models.every((m) => modelMatches(policy?.pin ?? '', m))
    return { reviewer: c.reviewer, pin: policy?.pin ?? null, models, onPin, error: run.error ?? null }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function live(cases, outDir, claude) {
  const probe = spawnSync(claude, ['--version'], { encoding: 'utf8' })
  if (probe.error || probe.status !== 0) {
    console.error(`reviewer-eval: \`${claude} --version\` did not run — --live needs Claude Code (pass --claude <bin>)`)
    return 1
  }
  mkdirSync(outDir, { recursive: true })
  const record = { claudeVersion: probe.stdout.trim(), recordedAt: new Date().toISOString(), cases: {} }
  for (const c of cases) {
    console.log(`reviewer-eval: ${c.name} → ${c.reviewer}`)
    record.cases[c.name] = await liveCase(c, outDir, claude)
    const { error, models, onPin } = record.cases[c.name]
    if (error) console.error(`reviewer-eval: ${c.name}: ${error} — scored as a miss`)
    else if (!onPin) console.error(`reviewer-eval: ${c.name}: ran on ${models.join(', ')}, not on the pin`)
  }
  writeFileSync(join(outDir, 'live.json'), `${JSON.stringify(record, null, 2)}\n`)
  printScore(cases, outDir)
  return 0
}

// ── --check ──────────────────────────────────────────────────────────────────────────────

/** Apply every case to a copy of one fresh install; the problems, prefixed with the case. */
async function applicationProblems(cases) {
  const pristine = await scratchInstall('reviewer-eval-check-')
  const problems = []
  try {
    for (const c of cases) {
      const dir = mkdtempSync(join(tmpdir(), `reviewer-eval-check-${c.name}-`))
      try {
        cpSync(pristine, dir, { recursive: true })
        problems.push(...applyCase(c, dir).problems.map((p) => `${c.name}: ${p}`))
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  } finally {
    rmSync(pristine, { recursive: true, force: true })
  }
  return problems
}

async function check(corpus) {
  const problems = corpusProblems(corpus)
  if (problems.length === 0) problems.push(...(await applicationProblems(corpus.cases)))
  if (problems.length > 0) {
    for (const p of problems) console.error(`reviewer-eval: ${p}`)
    console.error(`reviewer-eval: FAIL — ${String(problems.length)} problem(s) in the corpus`)
    return 1
  }
  const kinds = KINDS.map((k) => `${k} ${String(corpus.cases.filter((c) => c.kind === k).length)}`).join(', ')
  console.log(`reviewer-eval: OK — ${String(corpus.cases.length)} case(s), every absence case with its control twin (${kinds}); every overlay applies to a fresh core-tier install`)
  return 0
}

// ── the command line ─────────────────────────────────────────────────────────────────────

const VALUED = new Set(['--score', '--live', '--corpus', '--case', '--claude'])
const MODES = ['--check', '--score', '--live']

/** @param {string[]} argv @returns {{ opts: Record<string, string[]> }|{ error: string }} */
export function parseArgs(argv) {
  /** @type {Record<string, string[]>} */
  const opts = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (!VALUED.has(a) && a !== '--check') return { error: `unknown argument ${JSON.stringify(a)}` }
    if (VALUED.has(a) && (argv[i + 1] === undefined || argv[i + 1].startsWith('--'))) return { error: `${a} needs a value` }
    opts[a] = [...(opts[a] ?? []), VALUED.has(a) ? argv[(i += 1)] : '']
  }
  const modes = MODES.filter((m) => opts[m] !== undefined)
  if (modes.length !== 1) return { error: 'name exactly one of --check, --score <dir> or --live <dir>' }
  return { opts }
}

function usage(message) {
  console.error(`reviewer-eval: ${message}\n${USAGE}`)
  return 1
}

function selectCases(cases, names) {
  if (names === undefined) return cases
  const unknown = names.filter((n) => !cases.some((c) => c.name === n))
  return unknown.length > 0 ? `no such case: ${unknown.join(', ')}` : cases.filter((c) => names.includes(c.name))
}

/** @param {string[]} argv @returns {Promise<number>} */
export async function main(argv) {
  const parsed = parseArgs(argv)
  if ('error' in parsed) return usage(parsed.error)
  const { opts } = parsed
  const corpus = loadCorpus(opts['--corpus'] ? resolve(opts['--corpus'][0]) : CORPUS)
  if (opts['--check']) return check(corpus)
  const problems = corpusProblems(corpus)
  if (problems.length > 0) {
    for (const p of problems) console.error(`reviewer-eval: ${p}`)
    return 1
  }
  if (opts['--score']) {
    const dir = resolve(opts['--score'][0])
    try {
      readdirSync(dir)
    } catch {
      return usage(`${dir}: not a readable directory of replies`)
    }
    printScore(corpus.cases, dir)
    return 0
  }
  if (process.env.NODE_TEST_CONTEXT) return usage('--live never runs under the test runner: it spends model calls')
  const cases = selectCases(corpus.cases, opts['--case'])
  if (typeof cases === 'string') return usage(cases)
  return live(cases, resolve(opts['--live'][0]), opts['--claude']?.[0] ?? 'claude')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2))
}
