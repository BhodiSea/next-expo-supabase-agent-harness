// Unit tests for the i18n gate's syntax-tree scanner (template/base/tools/lib/i18n-tree.mjs,
// 1.1.0, #76). In-process, so the tools/lib coverage floor measures the module.
//
// TWO JOBS BEFORE THE REGULAR EXPRESSIONS RETIRE AT 1.2.0 (the design record's guard):
//   1. FIXTURE PARITY. The tree walk ALONE finds every string tests/gates/check-i18n.test.mjs
//      reds, and finds nothing in its not-copy fixtures. When 1.2.0 deletes the regular
//      expressions, this is the proof that nothing they caught is lost.
//   2. THE ABSENT PARSER. loadParser takes an injected loader, and a loader that throws,
//      rejects or hands back something that is not the compiler yields null, never a scan.
//
// The tests that need the compiler run through treeTest: where `typescript` is not
// installed (selftest.yml's installer-unit runs the suite with no install) they skip
// loudly, and under HARNESS_TEST_REQUIRE_TYPESCRIPT=1 (lint.yml's machinery-lint, which
// installs the root and holds this module's coverage floor) a missing parser fails.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import * as tree from '../../template/base/tools/lib/i18n-tree.mjs'

const { findingKey, loadParser, looksMachineFacing, scanSource, TEXT_ATTRS } = tree

const ts = await loadParser()
const REQUIRE_TS = process.env.HARNESS_TEST_REQUIRE_TYPESCRIPT === '1'

/** @param {string} name @param {() => void | Promise<void>} fn */
function treeTest(name, fn) {
  if (ts !== null) return test(name, fn)
  if (REQUIRE_TS) {
    return test(name, () =>
      assert.fail('typescript cannot be imported, and HARNESS_TEST_REQUIRE_TYPESCRIPT=1 says this lane runs the tree walk'),
    )
  }
  return test(name, {
    skip: 'typescript is not installed here (selftest.yml installer-unit runs with no install); lint.yml machinery-lint runs this test with the parser',
  }, fn)
}

/** @param {string} file @param {string} text */
const scan = (file, text) => scanSource(ts, file, text)
/** @param {ReturnType<typeof scanSource>} findings */
const summary = (findings) => findings.map((f) => `${f.line}|${f.kind}|${f.name}|${f.text}`)

// ── the absent parser ─────────────────────────────────────────────────────────────

test('loadParser: a loader that throws, rejects or returns no compiler yields null', async () => {
  assert.equal(
    await loadParser(() => {
      throw new Error('Cannot find package typescript')
    }),
    null,
  )
  assert.equal(await loadParser(() => Promise.reject(new Error('ERR_MODULE_NOT_FOUND'))), null)
  assert.equal(await loadParser(() => Promise.resolve({ default: { version: '6.0.3' } })), null)
  assert.equal(await loadParser(() => Promise.resolve(null)), null)
})

test('loadParser: a CommonJS default export and a namespace both load', async () => {
  const fake = { createSourceFile() {}, SyntaxKind: {}, ScriptKind: {}, ScriptTarget: {} }
  assert.equal(await loadParser(() => Promise.resolve({ default: fake })), fake)
  assert.equal(await loadParser(() => Promise.resolve(fake)), fake)
})

treeTest('loadParser: with no loader it imports the installed compiler', () => {
  assert.equal(typeof ts?.createSourceFile, 'function')
})

// ── the key ───────────────────────────────────────────────────────────────────────

test('findingKey: 12 hex characters of a sha256 over [path, kind, name, collapsed text]', () => {
  const expected = createHash('sha256')
    .update(JSON.stringify(['apps/mobile/src/a.tsx', 'jsx-text', '', 'Ready to build']))
    .digest('hex')
    .slice(0, 12)
  assert.equal(findingKey('apps/mobile/src/a.tsx', 'jsx-text', '', 'Ready to build'), expected)
  assert.match(expected, /^[0-9a-f]{12}$/)
})

test('findingKey: a CRLF checkout and a reflowed run give the same key; a Windows path is made POSIX', () => {
  const lf = findingKey('apps/web/app/page.tsx', 'jsx-text', '', 'Ready\n    to build')
  assert.equal(findingKey('apps/web/app/page.tsx', 'jsx-text', '', '  Ready\r\n    to build '), lf)
  assert.equal(findingKey('apps\\web\\app\\page.tsx', 'jsx-text', '', 'Ready to build'), lf)
})

test('findingKey: one text, of one kind, under one name, in one file', () => {
  const base = findingKey('apps/mobile/src/a.tsx', 'attribute', 'title', 'Search')
  assert.notEqual(findingKey('apps/mobile/src/b.tsx', 'attribute', 'title', 'Search'), base)
  assert.notEqual(findingKey('apps/mobile/src/a.tsx', 'property', 'title', 'Search'), base)
  assert.notEqual(findingKey('apps/mobile/src/a.tsx', 'attribute', 'label', 'Search'), base)
  assert.notEqual(findingKey('apps/mobile/src/a.tsx', 'attribute', 'title', 'Search again'), base)
})

// ── the filters the regular expressions apply, moved here ──────────────────────────

test('looksMachineFacing: a path, a lowercase token and a kebab id are not copy; prose is', () => {
  for (const s of ['', '  ', '/healthz', '#main', '.foo', 'gridcell', 'mod-k', 'home-empty']) {
    assert.equal(looksMachineFacing(s), true, s)
  }
  for (const s of ['Ready to build', 'Settings', 'close dialog', 'OK']) {
    assert.equal(looksMachineFacing(s), false, s)
  }
})

test('TEXT_ATTRS: the attributes a human reads, and no machine-facing one', () => {
  assert.deepEqual(TEXT_ATTRS, [
    'accessibilityLabel',
    'accessibilityHint',
    'aria-label',
    'aria-description',
    'title',
    'placeholder',
    'label',
    'alt',
  ])
  for (const machine of ['testID', 'accessibilityRole', 'nativeID', 'id', 'key', 'name', 'href']) {
    assert.ok(!TEXT_ATTRS.includes(machine), machine)
  }
})

// ── fixture parity: every red fixture string in check-i18n.test.mjs ────────────────

treeTest('parity: JSX text children in a component and in an expo-router screen', () => {
  assert.deepEqual(
    summary(scan('apps/mobile/src/Widget.tsx', 'export function Widget() {\n  return <h2 className="x">Ready to build</h2>\n}\n')),
    ['2|jsx-text||Ready to build'],
  )
  assert.deepEqual(
    summary(scan('apps/mobile/app/index.tsx', 'export default function Home() {\n  return <h2>Welcome home</h2>\n}\n')),
    ['2|jsx-text||Welcome home'],
  )
  // Canary 16's injection, as selftest.yml writes it.
  assert.deepEqual(
    summary(
      scan(
        'apps/mobile/src/oops-i18n.tsx',
        'import { AppText } from "../components/AppText"\n\nexport const Oops = () => <AppText>Hardcoded canary copy</AppText>\n',
      ),
    ),
    ['3|jsx-text||Hardcoded canary copy'],
  )
})

treeTest('parity: every user-facing attribute, in double quotes', () => {
  for (const attr of TEXT_ATTRS) {
    assert.deepEqual(
      summary(scan('apps/mobile/src/Widget.tsx', `export function Widget() {\n  return <input ${attr}="Search commands" />\n}\n`)),
      [`2|attribute|${attr}|Search commands`],
      attr,
    )
  }
})

treeTest('parity: copy-carrying object literals', () => {
  for (const key of ['label', 'title', 'subtitle', 'description']) {
    assert.deepEqual(
      summary(scan('apps/mobile/src/routes.ts', `export const ROUTES = [{ id: 'home', ${key}: 'Home screen' }]\n`)),
      [`1|property|${key}|Home screen`],
      key,
    )
  }
})

treeTest('parity: Intl, toLocale* and toFixed — the text is the matched expression', () => {
  assert.deepEqual(summary(scan('apps/mobile/src/fmt.ts', 'export const x = new Intl.NumberFormat("en").format(1)\n')), [
    '1|intl||Intl.NumberFormat',
  ])
  assert.deepEqual(summary(scan('apps/mobile/src/fmt.ts', 'export const x = value.toLocaleString()\n')), [
    '1|intl||.toLocaleString()',
  ])
  assert.deepEqual(summary(scan('apps/mobile/src/fmt.ts', 'export const x = value.toFixed(2)\n')), [
    '1|intl||.toFixed(2)',
  ])
  // A comment inside the call is blanked before the text is taken, as the regular
  // expressions see it, and the whitespace collapses: one key either way.
  assert.deepEqual(summary(scan('apps/mobile/src/fmt.ts', 'export const x = value.toFixed(/* two */ 2)\n')), [
    '1|intl||.toFixed( 2)',
  ])
  // A type that names Intl is a finding too: the regular expression has always redded it.
  assert.deepEqual(summary(scan('apps/mobile/src/fmt.ts', 'export type O = Intl.DateTimeFormatOptions\n')), [
    '1|intl||Intl.DateTimeFormatOptions',
  ])
})

treeTest('parity: the four shapes the regular expressions miss', () => {
  assert.deepEqual(
    summary(scan('apps/mobile/src/Dialog.tsx', "export const Close = () => <Text accessibilityLabel={'Close dialog'} />\n")),
    ['1|attribute|accessibilityLabel|Close dialog'],
  )
  assert.deepEqual(summary(scan('apps/mobile/src/routes.ts', "export const R = [{ id: 'settings', title: `Settings` }]\n")), [
    '1|property|title|Settings',
  ])
  assert.deepEqual(
    summary(scan('apps/mobile/src/auth.ts', `export const L = [{ id: 'signup', label: "Don't have an account?" }]\n`)),
    ["1|property|label|Don't have an account?"],
  )
  assert.deepEqual(summary(scan('apps/web/app/pricing/page.tsx', 'export default function P() {\n  return <h2>Plans from $5</h2>\n}\n')), [
    '2|jsx-text||Plans from $5',
  ])
})

treeTest('the walk reads a value through parentheses, `as const` and `satisfies`', () => {
  assert.deepEqual(
    summary(
      scan(
        'apps/mobile/src/nav.tsx',
        "export const a = { title: 'Home screen' as const }\nexport const b = <X label={('Go back')} />\nexport const c = { subtitle: `Welcome back` satisfies string }\n",
      ),
    ),
    ['1|property|title|Home screen', '2|attribute|label|Go back', '3|property|subtitle|Welcome back'],
  )
})

treeTest('JSX text beside an expression is two runs, each judged, and the line is the tag close', () => {
  assert.deepEqual(
    summary(scan('apps/web/app/page.tsx', 'export const P = ({ n }: { n: string }) => (\n  <p>\n    Hello {n}, welcome back\n  </p>\n)\n')),
    ['2|jsx-text||Hello', '3|jsx-text||, welcome back'],
  )
})

// ── fixture parity: the not-copy fixtures find nothing ──────────────────────────────

treeTest('parity: machine-facing literals are not copy (a path, a token, a kebab id)', () => {
  assert.deepEqual(
    scan(
      'apps/mobile/src/Widget.tsx',
      'export function Widget() {\n  return <a href="/healthz" title="/matrix" className="text-ink" testID="home-empty" />\n}\n',
    ),
    [],
  )
})

treeTest('parity: TypeScript generics in a .ts module are not JSX', () => {
  assert.deepEqual(
    scan('apps/mobile/src/useListQuery.ts', 'export function useListQuery<T>(fetcher: ListFetcher<T>): T | null {\n  return null\n}\n'),
    [],
  )
})

treeTest('parity: an arrow function is not a tag', () => {
  assert.deepEqual(
    scan(
      'apps/mobile/src/Widget.tsx',
      'const keys = SHORTCUTS.map((shortcut) => [shortcut.id, shortcut.keys])\nexport function Widget() {\n  return <div />\n}\n',
    ),
    [],
  )
})

treeTest('parity: the generic shapes the web surface tripped the regular expressions on are not copy', () => {
  assert.deepEqual(
    scan(
      'apps/web/app/form.tsx',
      [
        "import { useState } from 'react'",
        'export function Form() {',
        '  const [error, setError] = useState<AppError | null>(null)',
        '  async function submit(e: React.FormEvent<HTMLFormElement>): Promise<void> {',
        '    e.preventDefault()',
        '  }',
        '  return <form onSubmit={submit}>{error?.code}</form>',
        '}',
        '',
      ].join('\n'),
    ),
    [],
  )
})

treeTest('a comment, a catalog call and a whitespace-only run are not copy', () => {
  assert.deepEqual(
    scan(
      'apps/mobile/src/Widget.tsx',
      "// <h2>Ready to build</h2>\nexport function Widget() {\n  /* title: 'Home screen' */\n  return (\n    <View>\n      <Text>{t('home.title')}</Text> ✕\n    </View>\n  )\n}\n",
    ),
    [],
  )
})

treeTest('an attribute or property outside the lists, and a value that is not a literal, are not findings', () => {
  assert.deepEqual(
    scan(
      'apps/mobile/src/Widget.tsx',
      "export const a = { heading: 'Home screen', title: t('home.title'), label: `Hello ${name}` }\nexport const b = <X testID=\"Close dialog\" title={t('x')} label={`Hi ${n}`} />\n",
    ),
    [],
  )
})
