// Canary tests for the i18n gate (template/base/tools/check-i18n.mjs): spawn the real gate
// against a temp tree and assert a hardcoded user-facing string reds (JSX text, RN a11y
// attributes, copy-carrying object literals — in BOTH apps/mobile/src and the expo-router
// apps/mobile/app tree), the Intl/toLocale*/toFixed boundary reds, a dead catalog key reds,
// the reviewed allowlist mutes a finding, a malformed/stale allowlist fails CLOSED, the gate
// self-disables when the seam is not adopted — and the mobile-only check that is NEW in this
// port: the @formatjs polyfill/locale-data closure, asserted BOTH ways, with the LOCALES
// array parse failing closed.
// Dropped vs SRC: the pre-0.1.6 rampNote legs — this gate is turn-fatal from the first
// release (the catalog ships with init), so the DST gate has no ramp path at all.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(new URL('../../template/base/tools/check-i18n.mjs', import.meta.url))
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
 *           locales?: string[], localesRaw?: string|null, allow?: unknown }} [opts]
 */
function fixture({
  files = {},
  appFiles = {},
  i18nFiles = {},
  catalog = ['a.key'],
  locales = ['en'],
  localesRaw,
  allow = null,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-i18n-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
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

function runGate(dir, { ci = false } = {}) {
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  delete env.GITHUB_BASE_REF
  if (ci) env.CI = 'true'
  const res = spawnSync('node', [GATE], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
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

test('i18n: a hardcoded JSX text child reds, naming the string', () => {
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

test('i18n: the expo-router app/ tree is scanned too — copy in a screen file reds', () => {
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

test('i18n: a hardcoded user-facing ATTRIBUTE reds — the RN a11y names included', () => {
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

test('i18n: copy in an OBJECT literal reds — data modules and navigator options hold copy too', () => {
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

test('i18n: machine-facing literals are NOT copy (a path, a token, a kebab id)', () => {
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

test('i18n: TypeScript generics are not JSX — a .ts file with <T> reds nothing', () => {
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

test('i18n: an arrow function is not a tag — `=>` never opens JSX text', () => {
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

test('i18n: Intl / toLocale* / toFixed outside apps/mobile/src/i18n reds', () => {
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

test('i18n: .toFixed(2) reds with the reason — it hardcodes the decimal mark', () => {
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

test('i18n: the reviewed allowlist mutes findings (copy AND boundary); malformed FAILS CLOSED', () => {
  const files = {
    'Widget.tsx': 'export function Widget() {\n  return <h2>Ready to build</h2>\n}\n',
    'fmt.ts': 'export const x = value.toFixed(2)\n',
    'Uses.tsx': USES(['a.key']),
  }
  const muted = runGate(
    fixture({
      files,
      allow: {
        comment: 'x',
        allow: [
          { site: `${SRC}/Widget.tsx:2`, reason: 'a brand name' },
          { site: `${SRC}/fmt.ts:1`, reason: 'feeds a machine-readable export' },
        ],
      },
    }),
  )
  assert.equal(muted.code, 0, muted.out)

  // Malformed shape (no reason) must never open the gate.
  const noReason = runGate(fixture({ files, allow: { allow: [{ site: `${SRC}/Widget.tsx:2` }] } }))
  assert.equal(noReason.code, 1, noReason.out)
  assert.ok(noReason.out.includes('every entry must be'), noReason.out)

  // Not even an object with an `allow` array.
  const wrongShape = runGate(fixture({ files, allow: [{ site: 'x:1', reason: 'y' }] }))
  assert.equal(wrongShape.code, 1, wrongShape.out)

  // Unparseable JSON fails closed rather than being ignored.
  const broken = runGate(fixture({ files, allow: '{ not json' }))
  assert.equal(broken.code, 1, broken.out)
  assert.ok(broken.out.includes('not valid JSON'), broken.out)
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

test('i18n: no mobile surface at all — loud local skip, CI fail-closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-i18n-nosrc-'))
  const local = runGate(dir, { ci: false })
  assert.equal(local.code, 0, local.out)
  assert.ok(local.out.includes('apps/mobile/src not found'), local.out)
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
  assert.ok(r.out.includes('closed over 1 polyfill(s)'), r.out)
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
  assert.ok(r.out.includes('no hardcoded copy'), r.out)
})
