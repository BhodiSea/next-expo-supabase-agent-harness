// The six complexity families (template/base/tools/lib/complexity.mjs, 2.1.0, #186). Each
// family has a true canary, which must hit with its facts, and a justified canary, which the
// recipe's own exclusion must keep out. A function yields at most one record: its
// highest-precedence family, with the lower matches as `also`.
import assert from 'node:assert/strict'
import { complexityHits } from '../../template/base/tools/lib/complexity.mjs'
import { buildImporters } from '../../template/base/tools/lib/importers.mjs'
import { extractTree } from '../../template/base/tools/lib/shapes.mjs'
import { inTree, pkg, treeTest, ts } from './helpers/single-home.mjs'

const K = 'packages/k/src'

/** Every complexity hit over a fixture tree. @param {Record<string, string>} files */
const hitsOf = (files) =>
  inTree({ 'packages/k/package.json': pkg('@app/k'), [`${K}/store.ts`]: STORE, ...files }, () => {
    const { files: parsed } = extractTree(ts)
    return complexityHits(ts, parsed, buildImporters())
  })

const STORE = 'export function save(id: string, body: string) {\n  const row = { id, body }\n  return [row]\n}\n'

/** The families a callable matched, top first; [] when it has no record. */
function familiesOf(hits, path, name) {
  const own = hits.filter((h) => h.path === path && h.name === name)
  assert.ok(own.length <= 1, `at most one record per function, got ${String(own.length)} for ${name}`)
  return own.length === 0 ? [] : [own[0].family, ...own[0].facts.also]
}

/** The one record of a callable, its `also` dropped. */
function recordOf(hits, path, name) {
  const own = hits.find((h) => h.path === path && h.name === name)
  assert.ok(own !== undefined, `${name} in ${path} has a record`)
  const { also: _also, ...facts } = own.facts
  return { family: own.family, facts }
}

treeTest('complexity: pass-through hits a body that only forwards its own parameters', () => {
  const hits = hitsOf({
    [`${K}/pt.ts`]: "import { save } from './store'\nexport async function persist(id: string, body: string) {\n  return await save(id, body)\n}\n",
    [`${K}/pt2.ts`]: "import { save } from './store'\nexport function reorder(id: string, body: string) {\n  return save(body, id)\n}\n",
  })
  assert.deepEqual(recordOf(hits, `${K}/pt.ts`, 'persist'), {
    family: 'pass-through',
    facts: { callee: 'save', awaited: true, arity: 2 },
  })
  // Arguments out of order are not a pass-through: the wrapper decides something.
  assert.ok(!familiesOf(hits, `${K}/pt2.ts`, 'reorder').includes('pass-through'))
})

treeTest('complexity: pass-through is justified in a tRPC router, a server action and a port adapter', () => {
  const body = "export async function persist(id: string, body: string) {\n  return await save(id, body)\n}\n"
  const hits = hitsOf({
    [`${K}/routers/notes.ts`]: `import { save } from '../store'\n${body}`,
    [`${K}/actions.ts`]: `'use server'\nimport { save } from './store'\n${body}`,
    'packages/verticals/notes/package.json': pkg('@app/notes'),
    'packages/verticals/notes/src/data/port.ts': 'export interface NotesPort { readonly save: (id: string, body: string) => unknown }\n',
    'packages/verticals/notes/src/data/adapter.ts': `import type { NotesPort } from './port'\nimport { save } from '@app/k'\nexport const port: NotesPort | null = null\n${body}`,
    [`${K}/plain.ts`]: `import { save } from './store'\n${body}`,
  })
  assert.equal(familiesOf(hits, `${K}/plain.ts`, 'persist')[0], 'pass-through', 'the control hits')
  for (const path of [`${K}/routers/notes.ts`, `${K}/actions.ts`, 'packages/verticals/notes/src/data/adapter.ts']) {
    assert.ok(!familiesOf(hits, path, 'persist').includes('pass-through'), path)
  }
})

const SPLIT = `function headOf(text: string) {
  const lines = text.split('\\n')
  return lines[0]
}
function tailOf(text: string) {
  const lines = text.split('\\n')
  return lines.slice(1)
}
function joined(a: string, b: string, c: string) {
  const parts = [a, b, c]
  return parts.join('')
}
export function parse(text: string) {
  const head = headOf(text)
  const tail = tailOf(text)
  return { head, tail }
}
export function compose(x: string) {
  const a = x.trim()
  const b = a.toUpperCase()
  return joined(a, b, x)
}
`

treeTest('complexity: helper-split hits two single-call private helpers, or one conjoined helper', () => {
  const hits = hitsOf({ [`${K}/split.ts`]: SPLIT })
  assert.deepEqual(recordOf(hits, `${K}/split.ts`, 'parse'), {
    family: 'helper-split',
    facts: { helpers: 2, conjoined: 0, lines: [1, 5] },
  })
  assert.deepEqual(recordOf(hits, `${K}/split.ts`, 'compose'), {
    family: 'helper-split',
    facts: { helpers: 1, conjoined: 1, lines: [9] },
  })
})

// Each justified canary below has exactly one other single-call helper, so the one exclusion
// it names is all that keeps its function under the two-helper bar.
treeTest('complexity: helper-split is justified when a helper is also passed as a callback', () => {
  const hits = hitsOf({
    [`${K}/split.ts`]: `function headOf(text: string) {
  const lines = text.split('\\n')
  return lines[0]
}
function tailOf(text: string) {
  const lines = text.split('\\n')
  return lines.slice(1)
}
export function parseAll(texts: string[]) {
  const first = headOf(texts[0] ?? '')
  const heads = texts.map(headOf)
  const tail = tailOf(texts[0] ?? '')
  return { first, heads, tail }
}
`,
    [`${K}/control.ts`]: SPLIT,
  })
  // headOf is called once, like a split helper, but is also passed by reference.
  assert.ok(!familiesOf(hits, `${K}/split.ts`, 'parseAll').includes('helper-split'))
  assert.equal(familiesOf(hits, `${K}/control.ts`, 'parse')[0], 'helper-split', 'the control hits')
})

treeTest('complexity: helper-split is justified when a helper is called twice', () => {
  const hits = hitsOf({
    [`${K}/split.ts`]: `function tailOf(text: string) {
  const lines = text.split('\\n')
  return lines.slice(1)
}
function twice(text: string) {
  const lines = text.split('\\n')
  return lines.length
}
export function countAll(texts: string[]) {
  const tail = tailOf(texts[0] ?? '')
  return { tail, n: twice('a') + twice('b') }
}
`,
    [`${K}/control.ts`]: SPLIT,
  })
  assert.ok(!familiesOf(hits, `${K}/split.ts`, 'countAll').includes('helper-split'))
  assert.equal(familiesOf(hits, `${K}/control.ts`, 'parse')[0], 'helper-split', 'the control hits')
})

treeTest('complexity: intent-hiding hits a short one-expression function with at most two call sites', () => {
  const hits = hitsOf({ [`${K}/hide.ts`]: 'export const isBlank = (s: string) => s.trim().length === 0\n' })
  assert.deepEqual(recordOf(hits, `${K}/hide.ts`, 'isBlank'), {
    family: 'intent-hiding',
    facts: { tokens: 9, calls: 0, words: 2 },
  })
})

treeTest('complexity: intent-hiding is justified for a type guard, a hook, and a function with three call sites', () => {
  const hits = hitsOf({
    [`${K}/hide.ts`]: `export interface Note { readonly id: string }
export const isNote = (x: unknown): x is Note => typeof x === 'object' && x !== null
export const useStamp = () => Date.now()
export const trimmed = (s: string) => s.trim()
export function three(a: string) {
  const b = trimmed(a)
  const c = trimmed(b)
  return [b, c, trimmed(c)]
}
export const isBlank = (s: string) => s.trim().length === 0
`,
  })
  for (const name of ['isNote', 'useStamp', 'trimmed']) {
    assert.ok(!familiesOf(hits, `${K}/hide.ts`, name).includes('intent-hiding'), name)
  }
  assert.equal(familiesOf(hits, `${K}/hide.ts`, 'isBlank')[0], 'intent-hiding', 'the control hits')
})

treeTest('complexity: single-consumer hits an export with exactly one non-test importing file', () => {
  const hits = hitsOf({
    [`${K}/shape.ts`]: `export interface Draft { readonly title: string }
export function draftOf(title: string) {
  const clean = title.trim()
  return { title: clean }
}
`,
    [`${K}/use.ts`]: "import { type Draft, draftOf } from './shape'\nexport const d: Draft = draftOf('x')\n",
    [`${K}/shape.test.ts`]: "import { draftOf } from './shape'\nexport const t = draftOf('y')\n",
  })
  assert.deepEqual(recordOf(hits, `${K}/shape.ts`, 'Draft'), {
    family: 'single-consumer',
    facts: { importers: 1, kind: 'interface', importer: `${K}/use.ts` },
  })
  assert.deepEqual(recordOf(hits, `${K}/shape.ts`, 'draftOf'), {
    family: 'single-consumer',
    facts: { importers: 1, kind: 'function', importer: `${K}/use.ts` },
  })
  assert.equal(hits.find((h) => h.name === 'Draft')?.subject, '@app/k#Draft')
})

treeTest('complexity: single-consumer is justified for a port, packages/shared, and two importers', () => {
  const draft = 'export interface Draft { readonly title: string }\n'
  const hits = hitsOf({
    'packages/verticals/notes/package.json': pkg('@app/notes'),
    'packages/verticals/notes/src/data/port.ts': draft,
    'packages/verticals/notes/src/data/a.ts': "import type { Draft } from './port'\nexport const a: Draft | null = null\n",
    'packages/shared/concept/package.json': pkg('@app/concept'),
    'packages/shared/concept/src/draft.ts': draft,
    'packages/shared/concept/src/a.ts': "import type { Draft } from './draft'\nexport const a: Draft | null = null\n",
    [`${K}/draft.ts`]: draft,
    [`${K}/a.ts`]: "import type { Draft } from './draft'\nexport const a: Draft | null = null\n",
    [`${K}/b.ts`]: "import type { Draft } from './draft'\nexport const b: Draft | null = null\n",
    [`${K}/solo.ts`]: draft,
    [`${K}/c.ts`]: "import type { Draft } from './solo'\nexport const c: Draft | null = null\n",
  })
  // Only the control, with its one importer, hits.
  assert.deepEqual(
    hits.filter((h) => h.family === 'single-consumer').map((h) => h.path),
    [`${K}/solo.ts`],
  )
})

const SELECT = `export function label(n: number, short: boolean) {
  if (short) return String(n)
  const text = String(n)
  return text.padStart(4, '0')
}
export function render(x: string, loud: boolean) {
  const y = x.trim()
  return loud ? y.toUpperCase() : y
}
export const both = [render('a', true), render('b', false)]
`

treeTest('complexity: bool-selector hits a boolean that is the top-level split, or passed as a literal twice', () => {
  const hits = hitsOf({ [`${K}/select.ts`]: SELECT })
  assert.deepEqual(recordOf(hits, `${K}/select.ts`, 'label'), {
    family: 'bool-selector',
    facts: { param: 'short', index: 1, split: true, literalSites: 0 },
  })
  assert.deepEqual(recordOf(hits, `${K}/select.ts`, 'render'), {
    family: 'bool-selector',
    facts: { param: 'loud', index: 1, split: false, literalSites: 2 },
  })
})

treeTest('complexity: bool-selector is justified for a function that returns JSX', () => {
  const hits = hitsOf({
    [`${K}/badge.tsx`]: `export function Badge(props: { on: boolean }, compact: boolean) {
  if (compact) return <b>{props.on}</b>
  const wide = props.on
  return <i>{wide}</i>
}
export function caption(on: boolean, compact: boolean) {
  if (compact) return String(on)
  const wide = String(on)
  return wide.padEnd(8, ' ')
}
`,
  })
  assert.ok(!familiesOf(hits, `${K}/badge.tsx`, 'Badge').includes('bool-selector'))
  assert.equal(familiesOf(hits, `${K}/badge.tsx`, 'caption')[0], 'bool-selector', 'the control hits')
})

const GUARD = `export function names(list: { name: string }[]) {
  if (list.length === 0) return []
  return list.map((x) => x.name)
}
export function total(xs: number[]) {
  if (xs.length === 0) return 0
  let sum = 0
  for (const x of xs) sum += x
  return sum
}
export function upper(list: string[] | undefined) {
  if (list === undefined) return undefined
  return list?.map((x) => x.toUpperCase())
}
`

treeTest('complexity: edge-guard hits an early return the general path already yields', () => {
  const hits = hitsOf({ [`${K}/guard.ts`]: GUARD })
  assert.deepEqual(recordOf(hits, `${K}/guard.ts`, 'names'), {
    family: 'edge-guard',
    facts: { returns: 'empty-array', generalLine: 3, generalKind: 'map' },
  })
  assert.deepEqual(recordOf(hits, `${K}/guard.ts`, 'total'), {
    family: 'edge-guard',
    facts: { returns: 'zero', generalLine: 8, generalKind: 'for-of' },
  })
  // After a null test, only an optional-chained general path yields the guard's undefined.
  assert.deepEqual(recordOf(hits, `${K}/guard.ts`, 'upper'), {
    family: 'edge-guard',
    facts: { returns: 'undefined', generalLine: 13, generalKind: 'map' },
  })
})

treeTest('complexity: edge-guard is justified when the general path would yield something else', () => {
  const hits = hitsOf({
    [`${K}/guard.ts`]: `export function firstNames(list: { name: string }[]) {
  if (list.length === 0) return null
  return list.map((x) => x.name)
}
export function maybe(list: string[] | null) {
  if (list === null) return undefined
  return list.map((x) => x.trim())
}
export function seeded(xs: number[]) {
  if (xs.length === 0) return 0
  return xs.reduce((a, b) => a + b, 1)
}
`,
    [`${K}/control.ts`]: GUARD,
  })
  for (const name of ['firstNames', 'maybe', 'seeded']) {
    assert.ok(!familiesOf(hits, `${K}/guard.ts`, name).includes('edge-guard'), name)
  }
  assert.equal(familiesOf(hits, `${K}/control.ts`, 'names')[0], 'edge-guard', 'the control hits')
})

treeTest('complexity: edge-guard is justified for `!x?.length`, which a null x also takes', () => {
  const hits = hitsOf({
    [`${K}/guard.ts`]: `export function names(list?: { name: string }[] | null) {
  if (!list?.length) return []
  return list.map((x) => x.name)
}
export function sized(list?: { name: string }[] | null) {
  if (list?.length === 0) return []
  return list.map((x) => x.name)
}
`,
  })
  // Without its guard, names(undefined) throws where the guard returns [].
  assert.ok(!familiesOf(hits, `${K}/guard.ts`, 'names').includes('edge-guard'))
  // `x?.length === 0` is false for a null x, so only an empty list takes that guard.
  assert.equal(familiesOf(hits, `${K}/guard.ts`, 'sized')[0], 'edge-guard', 'the control hits')
})

treeTest('complexity: edge-guard is justified when a statement past the guard can change the outcome', () => {
  const hits = hitsOf({
    [`${K}/guard.ts`]: `export function firsts(rows: { id: string }[]) {
  if (rows.length === 0) return []
  const head = rows[0]!.id.toUpperCase()
  return rows.map((r) => r.id + head)
}
export function pick(xs: string[], mode: string) {
  if (xs.length === 0) return []
  if (mode === 'none') return null
  return xs.filter(Boolean)
}
export function sum(xs: number[]) {
  if (xs.length === 0) return 0
  let total = 0
  for (const x of xs) total += x
  total = 100
  return total
}
export function preset(xs: number[]) {
  let total = 0
  total = 100
  if (xs.length === 0) return 0
  for (const x of xs) total += x
  return total
}
`,
    // A declaration of a literal, before or after the guard, changes nothing on that input.
    [`${K}/control.ts`]: `export function counted(xs: number[]) {
  let total = 0
  if (xs.length === 0) return 0
  const scale = 2
  for (const x of xs) total += x * scale
  return total
}
export function listed(list: { name: string }[]) {
  if (list.length === 0) return []
  const sep = ', '
  return list.map((x) => x.name + sep)
}
`,
  })
  // On an empty input without the guard: firsts throws, pick can return null, sum and preset
  // return 100.
  for (const name of ['firsts', 'pick', 'sum', 'preset']) {
    assert.ok(!familiesOf(hits, `${K}/guard.ts`, name).includes('edge-guard'), name)
  }
  assert.deepEqual(recordOf(hits, `${K}/control.ts`, 'counted'), {
    family: 'edge-guard',
    facts: { returns: 'zero', generalLine: 5, generalKind: 'for-of' },
  })
  assert.deepEqual(recordOf(hits, `${K}/control.ts`, 'listed'), {
    family: 'edge-guard',
    facts: { returns: 'empty-array', generalLine: 11, generalKind: 'map' },
  })
})

treeTest('complexity: a function matching three recipes is one record, the rest as `also`', () => {
  const hits = hitsOf({
    [`${K}/pt.ts`]: "import { save } from './store'\nexport function persist(id: string, body: string) {\n  return save(id, body)\n}\n",
    [`${K}/use.ts`]: "import { persist } from './pt'\nexport const u = persist('a', 'b')\n",
  })
  assert.deepEqual(familiesOf(hits, `${K}/pt.ts`, 'persist'), ['pass-through', 'intent-hiding', 'single-consumer'])
})
