// Building eval A's corpus and plantings from eval B's frozen fixture (2.1.0, #188). Runs
// once, by hand (`node scripts/eval-a.mjs --build-corpus`); the output is committed and the
// harness only reads it. lib/eval-a-cases.mjs says what the two files hold.
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { extractTree } from '../../template/base/tools/lib/shapes.mjs'
import { statementSpans } from '../../template/base/tools/lib/sql-parse.mjs'
import { FLOOR, SMALL_FLOOR } from '../../template/base/tools/lib/sweep.mjs'
import { prng } from './eval-a-mutators.mjs'
import { cmp, materialise, removeTree } from './evals.mjs'

/** How many helpers each token band contributes: the band around FLOOR is populated. */
const BANDS = Object.freeze([
  { from: SMALL_FLOOR, to: FLOOR + 4, ts: 8 },
  { from: FLOOR + 4, to: 70, ts: 13 },
  { from: 70, to: 300, ts: 13 },
])
const SQL_HELPERS = 6

/** The names the plantings use, kept out of the helpers so no case doubles another. */
const PLANTED_NAMES = new Set([
  'invalidCursor', 'emptyPatch', 'unreadableWrite', 'contractDrift', 'invalidExportCursor',
  'formatDate', 'useTheme', 'useFieldContext', 'noteCreated', 'noteDeleted', 'noteUpdated',
])

/** A TS callable's declaration text, from its node. */
const tsText = (c) => c.file.src.slice(c.node.getStart(c.file.sf), c.node.end)

/** A SQL callable's statement text: the span holding its line, with its semicolon. */
function sqlText(c) {
  const raw = readFileSync(c.path, 'utf8')
  const offset = raw.split('\n').slice(0, c.line - 1).join('\n').length
  const span = statementSpans(raw).find((s) => s.end > offset && /create\s/i.test(raw.slice(s.start, s.end)))
  const text = raw.slice(span.start, span.end).trim()
  return `${text.endsWith(';') ? text : `${text};`}\n`
}

const isHelper = (ts) => (c) =>
  c.lang === 'ts' &&
  c.kind === 'function' &&
  c.topLevel === true &&
  c.node !== undefined &&
  ts.isFunctionDeclaration(c.node) &&
  !c.dataShaped &&
  c.jsxShare <= 0.5 &&
  !PLANTED_NAMES.has(c.name)

/** `n` of `pool`, drawn by the generator, in pool order. */
function draw(pool, n, rand) {
  const left = [...pool]
  const out = []
  while (out.length < n && left.length > 0) out.push(...left.splice(Math.floor(rand() * left.length), 1))
  return out.sort((a, b) => cmp(a.subject, b.subject))
}

function helperOf(c, i, text) {
  const ext = c.lang === 'sql' ? 'sql' : c.path.endsWith('.tsx') ? 'tsx' : 'ts'
  const id = `h${String(i + 1).padStart(2, '0')}`
  return { id, lang: c.lang, ext, name: c.name, from: `${c.path}:${String(c.line)}`, tokens: c.tokens, dataShaped: c.dataShaped, text }
}

/** The corpus helpers from an extracted fixture. */
function selectHelpers(ts, callables, seed) {
  const rand = prng(seed)
  const unique = callables.filter((c) => callables.filter((d) => d.alpha === c.alpha).length === 1)
  const picked = BANDS.flatMap((b) => draw(unique.filter(isHelper(ts)).filter((c) => c.tokens >= b.from && c.tokens < b.to), b.ts, rand))
  const sql = draw(unique.filter((c) => c.lang === 'sql' && c.tokens >= SMALL_FLOOR && !c.dataShaped), SQL_HELPERS, rand)
  return [...picked, ...sql].map((c, i) => helperOf(c, i, c.lang === 'sql' ? sqlText(c) : `${tsText(c)}\n`))
}

/** The text of a fixture function by path and name. */
function fnText(callables, path, name) {
  const c = callables.find((x) => x.path === path && x.name === name)
  if (c === undefined) throw new Error(`the fixture has no ${name} in ${path}`)
  return `${tsText(c)}\n`
}

/**
 * Several fixture functions written into one file each (functions of one path joined).
 * @param {any[]} callables @param {[string, string, string?][]} picks [path, name, as?]
 */
function filesOf(callables, picks) {
  const out = {}
  for (const [path, name, as] of picks) out[as ?? path] = `${out[as ?? path] ?? ''}${fnText(callables, path, name)}`
  return out
}

/** A fixture file whole. */
const whole = (path) => ({ [path]: readFileSync(path, 'utf8') })

/** A fixture workspace manifest, so a planted file keeps its real package. */
const manifests = (...dirs) => Object.assign({}, ...dirs.map((d) => whole(`${d}/package.json`)))

const NOTES = 'packages/verticals/notes'
const PUSH = 'packages/verticals/push'

const pkg = (name) => `${JSON.stringify({ name, private: true, type: 'module', exports: { '.': './src/index.ts' }, dependencies: {} }, null, 2)}\n`
const TASKS_PKG = pkg('@app/tasks')
const HOME_PKG = pkg('@eval/home')

/** The decoys and v3's plantings, read from the fixture or planted. */
function exactPlantings(callables) {
  const decoy = (id, why, files) => ({ id, why, verdict: 'decoy', expect: null, files })
  return [
    decoy('seam-constructors', 'Per-vertical seam constructors, their push equivalent and the real invalidExportCursor mirror: one answer per vertical by design (plan v2 §11 A).', {
      ...manifests(NOTES, PUSH, 'packages/api'),
      ...filesOf(callables, [
        [`${NOTES}/src/data/errors.ts`, 'invalidCursor'], [`${NOTES}/src/data/errors.ts`, 'emptyPatch'],
        [`${NOTES}/src/data/errors.ts`, 'unreadableWrite'], [`${NOTES}/src/data/errors.ts`, 'contractDrift'],
        [`${PUSH}/src/data/push-tokens.ts`, 'contractDrift'], ['packages/api/src/export.ts', 'invalidExportCursor'],
      ]),
    }),
    decoy('format-date', 'Local and UTC formatDate: the web formats in UTC, mobile in local time.', {
      ...manifests('apps/web', 'apps/mobile'),
      ...filesOf(callables, [['apps/web/lib/i18n/index.ts', 'formatDate'], ['apps/mobile/src/i18n/index.ts', 'formatDate']]),
    }),
    decoy('design-system-mirror', 'The web and native design systems mirror one API on purpose.', {
      ...manifests('packages/design-system', 'packages/design-system-native'),
      ...filesOf(callables, [
        ['packages/design-system/src/ThemeProvider.tsx', 'useTheme'], ['packages/design-system-native/src/ThemeProvider.tsx', 'useTheme'],
        ['packages/design-system/src/field-context.ts', 'useFieldContext'], ['packages/design-system-native/src/field-context.ts', 'useFieldContext'],
      ]),
    }),
    decoy('i18n-catalogs', 'The web and mobile i18n catalogs: one shape, two surfaces.', {
      ...manifests('apps/web', 'apps/mobile'), ...whole('apps/web/lib/i18n/catalog.ts'), ...whole('apps/mobile/src/i18n/catalog.ts'),
    }),
    decoy('zod-tables', 'The contracts zod tables: shared shapes, each schema its own fact.', {
      ...manifests('packages/contracts'), ...whole('packages/contracts/src/index.ts'),
    }),
    decoy('route-conventions', 'Route-convention files: every page.meta.ts has the same shape by convention.', {
      ...manifests('apps/web'),
      ...whole('apps/web/app/(protected)/o/page.meta.ts'), ...whole('apps/web/app/(protected)/security/page.meta.ts'),
      ...whole('apps/web/app/(protected)/o/[orgSlug]/notes/page.meta.ts'),
    }),
    decoy('cents', 'toCents and fromCents: inverse conversions that look alike (planted; not in the tree).', {
      'packages/home/package.json': HOME_PKG,
      'packages/home/src/money.ts': `export function toCents(amount: number): number {\n  if (!Number.isFinite(amount)) throw new RangeError('amount must be finite')\n  return Math.round(amount * 100)\n}\n\nexport function fromCents(cents: number): number {\n  if (!Number.isFinite(cents)) throw new RangeError('cents must be finite')\n  return Math.round(cents) / 100\n}\n`,
    }),
    decoy('tiny-same-name', 'Tiny same-name functions with different bodies (planted).', {
      ...manifests(NOTES, PUSH),
      [`${NOTES}/src/util.ts`]: 'export function isBlank(s: string): boolean {\n  return s.trim().length === 0\n}\n\nexport function clamp(n: number, lo: number, hi: number): number {\n  return Math.min(hi, Math.max(lo, n))\n}\n',
      [`${PUSH}/src/util.ts`]: 'export function isBlank(token: string | null): boolean {\n  return token === null || token === \'\'\n}\n\nexport function clamp(n: number, max: number): number {\n  return n > max ? max : n\n}\n',
    }),
    decoy('shorthand', "v3's shorthand planting: a second vertical's taskCreated(origin, taskId, occurredAt) beside noteCreated must not form a class (its payload key differs).", {
      ...manifests(NOTES), 'packages/verticals/tasks/package.json': TASKS_PKG,
      ...filesOf(callables, [[`${NOTES}/src/events.ts`, 'noteCreated']]),
      'packages/verticals/tasks/src/events.ts': fnText(callables, `${NOTES}/src/events.ts`, 'noteCreated').replaceAll('noteCreated', 'taskCreated').replaceAll('noteId', 'taskId').replaceAll('NoteEvent', 'TaskEvent').replace("'notes.created'", "'tasks.created'"),
    }),
    decoy('silent', "v3's silent decoy: another vertical's constructor keyed by a different id (`id: taskId`) beside noteDeleted.", {
      ...manifests(NOTES), 'packages/verticals/tasks/package.json': TASKS_PKG,
      ...filesOf(callables, [[`${NOTES}/src/events.ts`, 'noteDeleted']]),
      'packages/verticals/tasks/src/events.ts': fnText(callables, `${NOTES}/src/events.ts`, 'noteDeleted').replaceAll('noteDeleted', 'taskRemoved').replace('noteId,', 'id: noteId,').replaceAll('noteId', 'taskId').replaceAll('NoteEvent', 'TaskEvent').replace("'notes.deleted'", "'tasks.removed'"),
    }),
    {
      id: 'tag-only-twin',
      why: "v3's owed same-file tag-only twin (N2, Dogfood #23): noteCreated and noteDeleted differ only in the event name.",
      verdict: 'true',
      expect: { rule: 'exact', tier: 'owed' },
      files: { ...manifests(NOTES), ...filesOf(callables, [[`${NOTES}/src/events.ts`, 'noteCreated'], [`${NOTES}/src/events.ts`, 'noteDeleted']]) },
    },
  ]
}

/**
 * Build the corpus and the plantings from a frozen fixture directory.
 * @param {any} ts @param {string} fixture @param {number} seed
 */
export function buildCorpus(ts, fixture, seed) {
  const dir = materialise(fixture)
  const cwd = process.cwd()
  try {
    process.chdir(dir)
    const { callables } = extractTree(ts)
    return {
      helpers: selectHelpers(ts, callables, seed),
      plantings: { exact: exactPlantings(callables), 'wire-orphan': [] },
    }
  } finally {
    process.chdir(cwd)
    removeTree(dir)
  }
}
