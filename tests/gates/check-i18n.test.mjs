// Canary tests for the i18n gate (template/base/tools/check-i18n.mjs): spawn the real gate
// against a temp tree and assert a hardcoded user-facing string reds (JSX text, RN a11y
// attributes, copy-carrying object literals — in BOTH apps/mobile/src and the expo-router
// apps/mobile/app tree), the Intl/toLocale*/toFixed boundary reds, a dead catalog key reds,
// the reviewed allowlist mutes a finding by its content key, a malformed or stale entry
// fails CLOSED, the gate self-disables when the seam is not adopted — and the mobile-only
// @formatjs polyfill/locale-data closure, asserted BOTH ways, with the LOCALES array parse
// failing closed.
//
// THE SYNTAX-TREE WALK (1.1.0, #76), AND ONLY THE WALK (2.0.0). 1.1.0 ran two scans and
// reported their union, the 1.0.x regular expressions and a walk of the TypeScript syntax tree
// (tools/lib/i18n-tree.mjs, whose own tests are tests/gates/i18n-tree.test.mjs), behind two
// rampNote calls due 1.2.0. 1.2.0 was never cut, so they fell due at 2.0.0, and 2.0.0 retired
// what they carried: the regular expressions and the file:line `site` entry. The walk is now
// the one scan, with no ramp, on every install. So every test that needs a finding runs
// through treeTest below: selftest.yml's installer-unit runs this suite with no install, so
// there `typescript` cannot load and they skip loudly, and lint.yml's machinery-lint, which
// installs the root, runs them with HARNESS_TEST_REQUIRE_TYPESCRIPT=1, where a missing
// parser is a failure. The parser-absent path is exercised everywhere, by running a copy of
// the gate from a temp directory where `typescript` cannot resolve.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(new URL('../../template/base/tools/check-i18n.mjs', import.meta.url))
const TOOLS = dirname(GATE)

// Whether the tree walk can run here: the gate's lib resolves `typescript` from the
// repository root, exactly as this file does.
let TS_AVAILABLE = true
try {
  await import('typescript')
} catch {
  TS_AVAILABLE = false
}
const REQUIRE_TS = process.env.HARNESS_TEST_REQUIRE_TYPESCRIPT === '1'

/**
 * A test that needs the syntax-tree walk. Where `typescript` is not installed it SKIPS,
 * loudly and by name; under HARNESS_TEST_REQUIRE_TYPESCRIPT=1 (lint.yml's machinery-lint)
 * a missing parser is a failure instead, so the lane that exists to run these can never
 * pass them by skipping.
 * @param {string} name @param {() => void} fn
 */
function treeTest(name, fn) {
  if (TS_AVAILABLE) return test(name, fn)
  if (REQUIRE_TS) {
    return test(name, () =>
      assert.fail('typescript cannot be imported, and HARNESS_TEST_REQUIRE_TYPESCRIPT=1 says this lane runs the tree walk'),
    )
  }
  return test(name, {
    skip: 'typescript is not installed here (selftest.yml installer-unit runs with no install); lint.yml machinery-lint runs this test with the parser',
  }, fn)
}

// The content key the gate prints and matches: the first 12 hex characters of a sha256
// over the JSON array [POSIX path, finding kind, attribute or property name, text with its
// whitespace collapsed]. Computed here independently, so the formula itself is pinned.
/** @param {string} file @param {string} kind @param {string} name @param {string} text */
const keyOf = (file, kind, name, text) =>
  createHash('sha256')
    .update(JSON.stringify([file, kind, name, text.replace(/\s+/g, ' ').trim()]))
    .digest('hex')
    .slice(0, 12)

// A manifest as `update` leaves it on an install seeded at 1.0.3 and now running 2.0.0: the
// vintage the retired 1.1.0 ramps used to carry.
const UPDATED_FROM_103 = { harnessVersion: '2.0.0', baseVersion: '1.0.3', files: {} }
const SRC = 'apps/mobile/src'
const APP = 'apps/mobile/app'

// The gate reads its message keys out of the catalog TEXT (`'key':`), exactly as it ships.
const CATALOG = (keys) => `export const en = {
${keys.map((k) => `  '${k}': 'copy for ${k}',`).join('\n')}
} as const
export type MessageKey = keyof typeof en
`

// The locale seam's ONE reviewable locale list — the closure check parses this fail-closed.
const LOCALES_MODULE = (locales) => `export const LOCALES: readonly string[] = [${locales
  .map((l) => `'${l}'`)
  .join(', ')}]
export function useI18n() {
  return { t: (k: string) => k }
}
`

/**
 * @param {{ files?: Record<string,string>, appFiles?: Record<string,string>,
 *           i18nFiles?: Record<string,string>, catalog?: string[]|null,
 *           locales?: string[], localesRaw?: string|null, allow?: unknown,
 *           manifest?: object|null }} [opts]
 */
function fixture({
  files = {},
  appFiles = {},
  i18nFiles = {},
  catalog = ['a.key'],
  locales = ['en'],
  localesRaw,
  allow = null,
  manifest = null,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-i18n-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  if (manifest !== null) {
    mkdirSync(join(dir, '.harness'), { recursive: true })
    writeFileSync(join(dir, '.harness/manifest.json'), JSON.stringify(manifest))
  }
  mkdirSync(join(dir, SRC), { recursive: true })
  if (catalog !== null) {
    mkdirSync(join(dir, `${SRC}/i18n`), { recursive: true })
    writeFileSync(join(dir, `${SRC}/i18n/catalog.ts`), CATALOG(catalog))
    const index = localesRaw === undefined ? LOCALES_MODULE(locales) : localesRaw
    if (index !== null) writeFileSync(join(dir, `${SRC}/i18n/index.ts`), index)
  }
  for (const [rel, body] of Object.entries(i18nFiles)) {
    mkdirSync(join(dir, `${SRC}/i18n`), { recursive: true })
    writeFileSync(join(dir, `${SRC}/i18n`, rel), body)
  }
  const write = (root, tree) => {
    for (const [rel, body] of Object.entries(tree)) {
      const abs = join(dir, root, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, body)
    }
  }
  write(SRC, files)
  write(APP, appFiles)
  if (allow !== null) {
    writeFileSync(
      join(dir, 'tools/i18n-allow.json'),
      typeof allow === 'string' ? allow : JSON.stringify(allow),
    )
  }
  return dir
}

/** @param {string} dir @param {{ ci?: boolean, gate?: string }} [opts] */
function runGate(dir, { ci = false, gate = GATE } = {}) {
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  delete env.GITHUB_BASE_REF
  if (ci) env.CI = 'true'
  const res = spawnSync('node', [gate], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

/**
 * A copy of the gate and every tools/lib module, placed in the fixture's own tools/, where
 * `typescript` cannot resolve: the parser is genuinely absent, with nothing injected.
 * Returns null when it CAN resolve from there (a node_modules above the temp dir), and the
 * caller skips rather than asserting over a parser that loaded.
 * @param {string} dir
 */
function gateWithoutParser(dir) {
  mkdirSync(join(dir, 'tools/lib'), { recursive: true })
  copyFileSync(GATE, join(dir, 'tools/check-i18n.mjs'))
  for (const f of readdirSync(join(TOOLS, 'lib')).filter((n) => n.endsWith('.mjs'))) {
    copyFileSync(join(TOOLS, 'lib', f), join(dir, 'tools/lib', f))
  }
  try {
    createRequire(join(dir, 'tools/lib/gate.mjs')).resolve('typescript')
    return null
  } catch {
    return join(dir, 'tools/check-i18n.mjs')
  }
}

// A component that renders every key it is given, so the dead-key check stays satisfied
// and the rule under examination is the only thing that can red.
const USES = (keys) =>
  `import { useI18n } from '../i18n'
export function Widget() {
  const { t } = useI18n()
  return <div>{${keys.map((k) => `t('${k}')`).join('}{')}}</div>
}
`

treeTest('i18n: a hardcoded JSX text child reds, naming the string', () => {
  const dir = fixture({
    files: {
      'Widget.tsx': `export function Widget() {
  return <h2 className="x">Ready to build</h2>
}
`,
      'Uses.tsx': USES(['a.key']),
    },
  })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('"Ready to build"'), r.out)
  assert.ok(r.out.includes('JSX text'), r.out)
})

treeTest('i18n: the expo-router app/ tree is scanned too — copy in a screen file reds', () => {
  const dir = fixture({
    files: { 'Uses.tsx': USES(['a.key']) },
    appFiles: {
      'index.tsx': `export default function Home() {
  return <h2>Welcome home</h2>
}
`,
    },
  })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('"Welcome home"'), r.out)
  assert.ok(r.out.includes('apps/mobile/app/index.tsx'), r.out)
})

treeTest('i18n: a hardcoded user-facing ATTRIBUTE reds — the RN a11y names included', () => {
  for (const attr of [
    'accessibilityLabel',
    'accessibilityHint',
    'aria-label',
    'aria-description',
    'title',
    'placeholder',
    'label',
    'alt',
  ]) {
    const dir = fixture({
      files: {
        'Widget.tsx': `export function Widget() {
  return <input ${attr}="Search commands" />
}
`,
        'Uses.tsx': USES(['a.key']),
      },
    })
    const r = runGate(dir)
    assert.equal(r.code, 1, `${attr} must red\n${r.out}`)
    assert.ok(r.out.includes('"Search commands"'), r.out)
    assert.ok(r.out.includes(`${attr} attribute`), r.out)
  }
})

treeTest('i18n: copy in an OBJECT literal reds — data modules and navigator options hold copy too', () => {
  for (const key of ['label', 'title', 'subtitle', 'description']) {
    const dir = fixture({
      files: {
        'routes.ts': `export const ROUTES = [{ id: 'home', ${key}: 'Home screen' }]\n`,
        'Uses.tsx': USES(['a.key']),
      },
    })
    const r = runGate(dir)
    assert.equal(r.code, 1, `${key}: must red\n${r.out}`)
    assert.ok(r.out.includes('"Home screen"'), r.out)
    assert.ok(r.out.includes(`${key}: property`), r.out)
  }
})

treeTest('i18n: machine-facing literals are NOT copy (a path, a token, a kebab id)', () => {
  const dir = fixture({
    files: {
      'Widget.tsx': `export function Widget() {
  return <a href="/healthz" title="/matrix" className="text-ink" testID="home-empty" />
}
`,
      'Uses.tsx': USES(['a.key']),
    },
  })
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
})

treeTest('i18n: TypeScript generics are not JSX — a .ts file with <T> reds nothing', () => {
  const dir = fixture({
    files: {
      'useListQuery.ts': `export function useListQuery<T>(fetcher: ListFetcher<T>): T | null {
  return null
}
`,
      'Uses.tsx': USES(['a.key']),
    },
  })
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
})

treeTest('i18n: an arrow function is not a tag — `=>` never opens JSX text', () => {
  const dir = fixture({
    files: {
      'Widget.tsx': `const keys = SHORTCUTS.map((shortcut) => [shortcut.id, shortcut.keys])
export function Widget() {
  return <div />
}
`,
      'Uses.tsx': USES(['a.key']),
    },
  })
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
})

treeTest('i18n: Intl / toLocale* / toFixed outside apps/mobile/src/i18n reds', () => {
  for (const call of [
    'new Intl.NumberFormat("en").format(1)',
    'value.toLocaleString()',
    'value.toFixed(2)',
  ]) {
    const dir = fixture({
      files: { 'fmt.ts': `export const x = ${call}\n`, 'Uses.tsx': USES(['a.key']) },
    })
    const r = runGate(dir)
    assert.equal(r.code, 1, `${call} must red\n${r.out}`)
    assert.ok(r.out.includes('outside apps/mobile/src/i18n/'), r.out)
  }
})

treeTest('i18n: .toFixed(2) reds with the reason — it hardcodes the decimal mark', () => {
  const dir = fixture({
    files: { 'fmt.ts': 'export const x = value.toFixed(2)\n', 'Uses.tsx': USES(['a.key']) },
  })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('0,75'), r.out) // the German reader in the message
})

test('i18n: a DEAD catalog key reds — copy nothing renders is copy that rots', () => {
  const dir = fixture({
    catalog: ['a.key', 'orphan.key'],
    files: { 'Uses.tsx': USES(['a.key']) },
  })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("'orphan.key' is never rendered"), r.out)
})

test('i18n: a dynamically-built key resolves by its static PREFIX (no false dead-key)', () => {
  const dir = fixture({
    catalog: ['theme.switch.light', 'theme.switch.dark', 'theme.switch.system'],
    files: {
      'Uses.tsx': `import { useI18n } from '../i18n'
export function Widget({ next }: { next: string }) {
  const { t } = useI18n()
  return <div>{t(\`theme.switch.\${next}\`)}</div>
}
`,
    },
  })
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
})

test('i18n: an EMPTY catalog fails — the seam cannot be adopted and vacuous at once', () => {
  const dir = fixture({ catalog: [] })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('declares no message keys'), r.out)
})

treeTest('i18n: the reviewed allowlist mutes findings by content KEY (copy AND boundary); malformed FAILS CLOSED', () => {
  const files = {
    'Widget.tsx': 'export function Widget() {\n  return <h2>Ready to build</h2>\n}\n',
    'fmt.ts': 'export const x = value.toFixed(2)\n',
    'Uses.tsx': USES(['a.key']),
  }
  const keys = {
    copy: keyOf(`${SRC}/Widget.tsx`, 'jsx-text', '', 'Ready to build'),
    // A boundary finding's text is the matched expression's source: the member access
    // from its dot through the call's closing parenthesis.
    boundary: keyOf(`${SRC}/fmt.ts`, 'intl', '', '.toFixed(2)'),
  }
  const muted = runGate(
    fixture({
      files,
      allow: {
        comment: 'x',
        allow: [
          { key: keys.copy, reason: 'a brand name' },
          { key: keys.boundary, reason: 'feeds a machine-readable export' },
        ],
      },
    }),
  )
  assert.equal(muted.code, 0, muted.out)

  // Unmuted, each FAIL line prints the entry that mutes it, ready to paste.
  const red = runGate(fixture({ files }))
  assert.equal(red.code, 1, red.out)
  assert.ok(red.out.includes(`{"key": "${keys.copy}", "reason": `), red.out)
  assert.ok(red.out.includes(`{"key": "${keys.boundary}", "reason": `), red.out)

  // Malformed shape (no reason) must never open the gate.
  const noReason = runGate(fixture({ files, allow: { allow: [{ key: keys.copy }] } }))
  assert.equal(noReason.code, 1, noReason.out)
  assert.ok(noReason.out.includes('every entry must be'), noReason.out)

  // A key is 12 lowercase hex characters, nothing else.
  const badKey = runGate(fixture({ files, allow: { allow: [{ key: 'Widget.tsx:2', reason: 'r' }] } }))
  assert.equal(badKey.code, 1, badKey.out)
  assert.ok(badKey.out.includes('every entry must be'), badKey.out)

  // Not even an object with an `allow` array.
  const wrongShape = runGate(fixture({ files, allow: [{ key: keys.copy, reason: 'y' }] }))
  assert.equal(wrongShape.code, 1, wrongShape.out)

  // Unparseable JSON fails closed rather than being ignored.
  const broken = runGate(fixture({ files, allow: '{ not json' }))
  assert.equal(broken.code, 1, broken.out)
  assert.ok(broken.out.includes('not valid JSON'), broken.out)
})

treeTest('i18n: a content key stays on its string when a line is inserted above it', () => {
  const before = 'export function Widget() {\n  return <h2>Ready to build</h2>\n}\n'
  const after = `export const inserted = 1\n${before}`
  const key = keyOf(`${SRC}/Widget.tsx`, 'jsx-text', '', 'Ready to build')
  const allow = { comment: 'x', allow: [{ key, reason: 'a brand name' }] }
  for (const body of [before, after]) {
    const r = runGate(fixture({ files: { 'Widget.tsx': body, 'Uses.tsx': USES(['a.key']) }, allow }))
    assert.equal(r.code, 0, r.out)
  }
})

test('i18n: the gate SELF-DISABLES when the locale seam is not adopted', () => {
  const dir = fixture({
    catalog: null,
    files: { 'Widget.tsx': 'export function Widget() {\n  return <h2>Ready to build</h2>\n}\n' },
  })
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('SKIPPED'), r.out)
  assert.ok(r.out.includes('--refresh-seeded'), r.out)
})

test('i18n: NO product surface at all — loud local skip, CI fail-closed', () => {
  // 0.6.0 widened the subject from one surface to two, so the skip condition widened with
  // it: the gate steps aside only when NEITHER apps/mobile nor apps/web exists. A tree with
  // one of them present is a tree this gate has something to say about.
  const dir = mkdtempSync(join(tmpdir(), 'epah-i18n-nosrc-'))
  const local = runGate(dir, { ci: false })
  assert.equal(local.code, 0, local.out)
  assert.ok(local.out.includes('neither apps/mobile nor apps/web found'), local.out)
  const ci = runGate(dir, { ci: true })
  assert.equal(ci.code, 1, ci.out)
})

// ── the @formatjs polyfill/locale-data closure (NEW in the mobile port) ───────────

test('i18n: LOCALES unparseable (or index.ts absent) FAILS CLOSED — the closure cannot be checked', () => {
  const noArray = runGate(
    fixture({ localesRaw: "export const locale = 'en'\n", files: { 'Uses.tsx': USES(['a.key']) } }),
  )
  assert.equal(noArray.code, 1, noArray.out)
  assert.ok(noArray.out.includes('no parseable LOCALES array'), noArray.out)

  const noModule = runGate(
    fixture({ localesRaw: null, files: { 'Uses.tsx': USES(['a.key']) } }),
  )
  assert.equal(noModule.code, 1, noModule.out)
  assert.ok(noModule.out.includes('no parseable LOCALES array'), noModule.out)
})

test('i18n: an installed data-consuming polyfill without locale-data for a catalog language reds', () => {
  const dir = fixture({
    files: { 'Uses.tsx': USES(['a.key']) },
    i18nFiles: { 'polyfills.ts': "import '@formatjs/intl-pluralrules/polyfill-force'\n" },
  })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('has no `@formatjs/intl-pluralrules/locale-data/en` import'), r.out)
  assert.ok(r.out.includes('root-locale CLDR rules'), r.out)
})

test('i18n: polyfill + matching locale-data closes the loop — green', () => {
  const dir = fixture({
    files: { 'Uses.tsx': USES(['a.key']) },
    i18nFiles: {
      'polyfills.ts': [
        "import '@formatjs/intl-pluralrules/polyfill-force'",
        "import '@formatjs/intl-pluralrules/locale-data/en'",
        '',
      ].join('\n'),
    },
  })
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
  // The summary counts across every ADOPTED surface now, so it reads "N polyfill(s) closed
  // over" rather than "closed over N polyfill(s)". The fixture is mobile-only, so N is 1.
  assert.ok(r.out.includes('1 polyfill(s) closed over'), r.out)
  // And the un-judged surface is NAMED, never silently dropped — the property that makes a
  // green line readable as "what actually ran" instead of "everything".
  assert.ok(r.out.includes('mobile adopted'), r.out)
})

test('i18n: locale-data no catalog locale resolves to is dead bundle weight — reds the other way', () => {
  const dir = fixture({
    files: { 'Uses.tsx': USES(['a.key']) },
    i18nFiles: {
      'polyfills.ts': [
        "import '@formatjs/intl-pluralrules/polyfill-force'",
        "import '@formatjs/intl-pluralrules/locale-data/en'",
        "import '@formatjs/intl-pluralrules/locale-data/de'",
        '',
      ].join('\n'),
    },
  })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("locale-data import for 'de' but no catalog locale resolves"), r.out)
  assert.ok(r.out.includes('dead bundle weight'), r.out)
})

test('i18n: a pseudo-locale (en-XA) resolves through its BASE language — /en data suffices', () => {
  const dir = fixture({
    locales: ['en', 'en-XA'],
    files: { 'Uses.tsx': USES(['a.key']) },
    i18nFiles: {
      'polyfills.ts': [
        "import '@formatjs/intl-pluralrules/polyfill-force'",
        "import '@formatjs/intl-pluralrules/locale-data/en'",
        '',
      ].join('\n'),
    },
  })
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
})

test('i18n: data-free polyfills (getcanonicallocales, intl-locale) need no locale-data', () => {
  const dir = fixture({
    files: { 'Uses.tsx': USES(['a.key']) },
    i18nFiles: {
      'polyfills.ts': [
        "import '@formatjs/intl-getcanonicallocales/polyfill'",
        "import '@formatjs/intl-locale/polyfill'",
        '',
      ].join('\n'),
    },
  })
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
})

test('i18n: a polyfill inlined into app/_layout.tsx is still seen — the closure covers the root layout', () => {
  const dir = fixture({
    files: { 'Uses.tsx': USES(['a.key']) },
    appFiles: {
      '_layout.tsx': [
        "import '@formatjs/intl-pluralrules/polyfill-force'",
        'export default function Layout() {',
        '  return null',
        '}',
        '',
      ].join('\n'),
    },
  })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('has no `@formatjs/intl-pluralrules/locale-data/en` import'), r.out)
})

test('i18n: a clean tree passes and reports what it scanned', () => {
  const dir = fixture({ files: { 'Uses.tsx': USES(['a.key']) } })
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
  // Since 2.0.0 (#86) the copy check is the syntax-tree walk's alone. Where `typescript` is
  // not installed (selftest.yml installer-unit installs nothing, and check-canary-coverage
  // runs this file there as the gate's red proof) the OK line names what it did NOT judge;
  // with the parser it says it found none. Either way it reports what it scanned.
  assert.ok(
    r.out.includes(TS_AVAILABLE ? 'no hardcoded copy' : 'hardcoded copy and the Intl boundary NOT judged'),
    r.out,
  )
  assert.match(r.out, /1 message key\(s\), .*1 locale\(s\)/)
})

// ── the syntax-tree walk (1.1.0, #76) ──────────────────────────────────────────────
// Four shapes every regular expression above misses. Each passed the gate at v1.0.3.

treeTest('i18n: a string in an expression container reds — accessibilityLabel={\'Close dialog\'}', () => {
  const r = runGate(
    fixture({
      files: {
        'Dialog.tsx': "import { Text } from 'react-native'\nexport const Close = () => <Text accessibilityLabel={'Close dialog'} />\n",
        'Uses.tsx': USES(['a.key']),
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('"Close dialog" (accessibilityLabel attribute)'), r.out)
})

treeTest('i18n: a template literal with no substitutions reds — title: `Settings` in a .ts module', () => {
  const r = runGate(
    fixture({
      files: { 'routes.ts': 'export const ROUTES = [{ id: \'settings\', title: `Settings` }]\n', 'Uses.tsx': USES(['a.key']) },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('"Settings" (title: property)'), r.out)
})

treeTest('i18n: a double-quoted object value reds — label: "Don\'t have an account?" in a .ts module', () => {
  const r = runGate(
    fixture({
      files: { 'auth.ts': 'export const LINKS = [{ id: \'signup\', label: "Don\'t have an account?" }]\n', 'Uses.tsx': USES(['a.key']) },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('"Don\'t have an account?" (label: property)'), r.out)
})

treeTest('i18n: JSX text holding $ reds — <h2>Plans from $5</h2>', () => {
  const r = runGate(
    fixture({
      files: {
        'Pricing.tsx': 'export function Pricing() {\n  return <h2>Plans from $5</h2>\n}\n',
        'Uses.tsx': USES(['a.key']),
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('"Plans from $5" (JSX text)'), r.out)
})

treeTest('i18n: a key entry that matches no finding is STALE and reds', () => {
  const stale = keyOf(`${SRC}/Gone.tsx`, 'jsx-text', '', 'Copy that was deleted')
  const r = runGate(
    fixture({
      files: { 'Uses.tsx': USES(['a.key']) },
      allow: { comment: 'x', allow: [{ key: stale, reason: 'it used to be a brand name' }] },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(`"${stale}" matches no finding`), r.out)
})

treeTest('i18n: 2.0.0 — a shape the 1.0.x expressions missed is hard on every install, a 1.0.3 vintage included, with no ramp', () => {
  // 1.1.0 ramped a finding only the tree walk saw (a NOTE below baseVersion 1.1.0, until
  // 1.2.0). 1.2.0 arrived at the 2.0.0 cut, and 2.0.0 retired the ramp with the expressions it
  // was measured against: there is one scan, so there is nothing "only" it sees.
  const files = {
    'Dialog.tsx': "export const Close = () => <Text accessibilityLabel={'Close dialog'} />\n",
    'Uses.tsx': USES(['a.key']),
  }
  const key = keyOf(`${SRC}/Dialog.tsx`, 'attribute', 'accessibilityLabel', 'Close dialog')
  for (const manifest of [UPDATED_FROM_103, null]) {
    const r = runGate(fixture({ files, manifest }))
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.includes('"Close dialog" (accessibilityLabel attribute)'), r.out)
    assert.ok(r.out.includes(`{"key": "${key}", "reason": `), r.out)
    assert.doesNotMatch(r.out, /RAMP EXPIRED|i18n: NOTE|ramp: live|syntax-tree walk only/)
  }
})

treeTest('i18n: 2.0.0 — the retired expressions own shape no longer reds: `title = "…"` in a .ts module is an assignment, not copy', () => {
  // The attribute expression matched `title = "…"` anywhere; the walk reads an assignment as
  // what it is. 1.1.0 kept it hard and tagged it as retiring in 1.2.0, and 2.0.0 retired it.
  const r = runGate(
    fixture({
      files: { 'page.ts': 'let title = "Account settings"\nexport { title }\n', 'Uses.tsx': USES(['a.key']) },
    }),
  )
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /Account settings|regular expressions only/)
})

test('i18n: 2.0.0 — a 1.0.x {"site"} entry is malformed on every install, a 1.0.3 vintage included, and names what replaces it', () => {
  // The second 1.1.0 ramp kept a file:line entry muting its line below baseVersion 1.1.0 until
  // 1.2.0. 2.0.0 retired the shape: the list fails closed on it, as on any malformed entry, and
  // the message says where the replacement key comes from.
  const files = {
    'Widget.tsx': 'export function Widget() {\n  return <h2>Ready to build</h2>\n}\n',
    'Uses.tsx': USES(['a.key']),
  }
  const allow = { comment: 'x', allow: [{ site: `${SRC}/Widget.tsx:2`, reason: 'a brand name' }] }
  for (const manifest of [UPDATED_FROM_103, null]) {
    const r = runGate(fixture({ files, allow, manifest }))
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.includes('every entry must be'), r.out)
    assert.ok(r.out.includes(`"site":"${SRC}/Widget.tsx:2"`), r.out)
    assert.match(r.out, /retired at 2\.0\.0/)
    assert.match(r.out, /prints the \{"key"\} entry that replaces it/)
    assert.doesNotMatch(r.out, /RAMP EXPIRED|ramp: live/)
  }
})

test('i18n: with the parser ABSENT, checks 1 and 2 are not judged, the output says so, and CI fails closed', (t) => {
  // Since 2.0.0 the walk is the only scan, so a missing `typescript` leaves the copy and
  // Intl-boundary checks unjudged. Locally that is a loud NOTE, never a silent pass; in CI a
  // failure. The dead-key and locale-data checks do not need the parser and still judge.
  const red = fixture({
    files: {
      'Widget.tsx': 'export function Widget() {\n  return <h2>Ready to build</h2>\n}\n',
      'Uses.tsx': USES(['a.key']),
    },
  })
  const redGate = gateWithoutParser(red)
  if (redGate === null) {
    t.skip('typescript resolves from the temp directory, so the parser cannot be made absent here')
    return
  }
  const local = runGate(red, { gate: redGate })
  assert.equal(local.code, 0, local.out)
  assert.match(local.out, /i18n: NOTE — the syntax-tree walk did not run/)
  assert.match(local.out, /Hardcoded copy and the Intl boundary were NOT judged/)
  assert.doesNotMatch(local.out, /Ready to build|regular expressions/)

  const dead = fixture({ catalog: ['a.key', 'orphan.key'], files: { 'Uses.tsx': USES(['a.key']) } })
  const deadGate = gateWithoutParser(dead)
  assert.ok(deadGate)
  const deadLocal = runGate(dead, { gate: deadGate })
  assert.equal(deadLocal.code, 1, deadLocal.out)
  assert.ok(deadLocal.out.includes("'orphan.key' is never rendered"), deadLocal.out)

  const ci = runGate(red, { gate: redGate, ci: true })
  assert.equal(ci.code, 1, ci.out)
  assert.ok(ci.out.includes('syntax-tree walk did not run'), ci.out)
})

treeTest('i18n: a clean tree reports that the syntax-tree walk ran, and nothing else', () => {
  const r = runGate(fixture({ files: { 'Uses.tsx': USES(['a.key']) } }))
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('(the syntax-tree walk ran)'), r.out)
  assert.doesNotMatch(r.out, /regular expressions/)
})
