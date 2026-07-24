// Can-fail proofs for the styleguide gate (template/base/tools/check-styleguide-manifest.mjs).
//
// The gate has two legs: (1) a REGEN-DIFF of @app/design-tokens (tsx
// packages/design-tokens/scripts/gen.mjs --check) that needs an install — proven
// end-to-end elsewhere (hand-edit a generated hex -> the gate reds; and the package's
// own render.test.ts drives it), and here exercised only as the LOUD local skip; and
// (2) the SOURCE SCAN + policy validation over apps/mobile, which is pure-node and is
// what every case below falsifies. Fixtures build a scaffold-shaped tree (a committed
// native adapter for the token vocabulary, the policy manifest, the motion seam + the
// touchable base the manifest names), run the real gate with cwd inside it, and assert
// the exact red/green.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(
  new URL('../../template/base/tools/check-styleguide-manifest.mjs', import.meta.url),
)

// Scrubbed env: no CI (so the install-less regen-diff leg takes its LOUD NOTE path, not
// the fail-closed CI path) and no toolchain flag — each case exercises the scan.
function run(dir, extraEnv = {}) {
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  return spawnSync(process.execPath, [GATE], { cwd: dir, encoding: 'utf8', env: { ...env, ...extraEnv } })
}

// The committed RN adapter — its palette IS the token vocabulary the gate reads.
const NATIVE = `export const palettes = {
  dark: {
    canvas: '#0b0e0f',
    surface: '#16191b',
    edge: '#2f3437',
    ink: '#e5e8ea',
    'ink-muted': '#9fa6ab',
    accent: '#6ad8de',
    danger: '#f77972',
    success: '#5abd73',
  },
  light: {
    canvas: '#f4f5f6',
  },
} as const
`

const MANIFEST = {
  accentTokens: ['accent'],
  accentUsageBudget: 10,
  controlPrimitives: {
    tags: ['Pressable', 'TouchableOpacity', 'TextInput', 'Button', 'Switch'],
    home: 'apps/mobile/src/components',
    base: {
      file: 'apps/mobile/src/components/PressableScale.tsx',
      tags: ['Pressable', 'TouchableOpacity', 'Button'],
    },
  },
  motionSeam: 'apps/mobile/src/lib/motion.ts',
  controlAllow: [],
  allow: [],
  statusSurfaces: {
    tokens: ['danger', 'success'],
    signals: ['role="alert"', 'role="status"', 'aria-invalid'],
    allow: [],
  },
}

// The touchable base: styles a Pressable AND references minTouchTarget, so it is a
// valid base (no floor error, no outside-base error — it IS the base file).
const BASE = `import { Pressable } from 'react-native'
import { minTouchTarget } from '@app/design-tokens/native'
const base = { minHeight: minTouchTarget }
export function PressableScale() {
  return <Pressable style={base} />
}
`
const SEAM = `export function usePressScale() { return {} }\n`
const CLEAN_SCREEN = `import { View } from 'react-native'
export default function Home() {
  return <View testID="home" />
}
`

function scaffold({ manifest = MANIFEST, native = NATIVE, sources = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'styleguide-'))
  const put = (rel, content) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  if (manifest !== null) put('tools/styleguide.manifest.json', JSON.stringify(manifest, null, 2))
  if (native !== null) put('packages/design-tokens/src/generated/native.ts', native)
  put('apps/mobile/src/lib/motion.ts', SEAM)
  put('apps/mobile/src/components/PressableScale.tsx', BASE)
  put('apps/mobile/app/index.tsx', CLEAN_SCREEN)
  for (const [rel, content] of Object.entries(sources)) put(rel, content)
  return dir
}

test('GREEN — vocabulary + policy + clean sources pass; regen-diff skips LOUDLY (no install)', () => {
  const r = run(scaffold())
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /styleguide: OK/)
  // The install-less regen-diff leg must announce itself — a skip is never a silent pass.
  assert.match(r.stdout, /regen-diff SKIPPED locally/)
})

test('RED — a raw hex literal in a scanned screen reds naming the file and value', () => {
  const r = run(
    scaffold({ sources: { 'apps/mobile/app/bad.tsx': "const c = { color: '#ff0000' }\n" } }),
  )
  assert.equal(r.status, 1)
  assert.match(r.stderr, /raw hex color '#ff0000'/)
})

test('RED — a raw dimension literal reds (scales live in @app/design-tokens)', () => {
  const r = run(scaffold({ sources: { 'apps/mobile/app/bad.tsx': 'const s = { padding: 13 }\n' } }))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /raw dimension "padding: 13"/)
})

test('RED — an inline style={{…}} numeric outside the components home reds', () => {
  const src = `import { View } from 'react-native'
export default function S() {
  return <View style={{ width: 42 }} />
}
`
  const r = run(scaffold({ sources: { 'apps/mobile/app/inline.tsx': src } }))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /inline style=\{\{ width: 42 \}\}/)
})

test('RED — a home file styling a raw control without minTouchTarget reds on the floor', () => {
  // A TextInput (a control tag, NOT a base tag) styled in the home, no minTouchTarget.
  const src = `import { TextInput } from 'react-native'
export function Field() {
  return <TextInput style={{ borderWidth: 1 }} />
}
`
  const r = run(scaffold({ sources: { 'apps/mobile/src/components/Field.tsx': src } }))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /never references minTouchTarget/)
})

test('RED — a raw <Pressable style=…> outside the components home forks the design system', () => {
  const src = `import { Pressable } from 'react-native'
export default function Screen() {
  return <Pressable style={{ opacity: 1 }} onPress={() => {}} />
}
`
  const r = run(scaffold({ sources: { 'apps/mobile/app/rogue.tsx': src } }))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /raw <Pressable …> carries a style prop outside/)
})

test('RED — a surface announcing status without a status token reds', () => {
  const src = `import { Text } from 'react-native'
export default function Err() {
  return <Text role="alert">Something failed</Text>
}
`
  const r = run(scaffold({ sources: { 'apps/mobile/app/err.tsx': src } }))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /announces status.*references no status token/s)
})

test('RED — accent references over budget red', () => {
  const many = 'const a = palette.accent\n'.repeat(12)
  const r = run(
    scaffold({
      manifest: { ...MANIFEST, accentUsageBudget: 3 },
      sources: { 'apps/mobile/app/accent.tsx': many },
    }),
  )
  assert.equal(r.status, 1)
  assert.match(r.stderr, /accent tokens referenced \d+× \(budget 3\)/)
})

test('RED — accentTokens naming a token no palette carries reds', () => {
  const r = run(scaffold({ manifest: { ...MANIFEST, accentTokens: ['ghost'] } }))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /accentTokens names "ghost", which is not a token/)
})

test('RED — statusSurfaces naming a non-vocabulary token fails closed', () => {
  const r = run(
    scaffold({
      manifest: { ...MANIFEST, statusSurfaces: { ...MANIFEST.statusSurfaces, tokens: ['ghost'] } },
    }),
  )
  assert.equal(r.status, 1)
  assert.match(r.stderr, /statusSurfaces.tokens names "ghost"/)
})

test('RED — a stale controlAllow entry (file exempt but no violation there) reds', () => {
  const r = run(
    scaffold({
      manifest: {
        ...MANIFEST,
        controlAllow: [{ file: 'apps/mobile/app/index.tsx', reason: 'stale' }],
      },
    }),
  )
  assert.equal(r.status, 1)
  assert.match(r.stderr, /controlAllow exempts "apps\/mobile\/app\/index\.tsx".*stale entry/s)
})

test('RED — a malformed accentUsageBudget fails loud', () => {
  const r = run(scaffold({ manifest: { ...MANIFEST, accentUsageBudget: -1 } }))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /accentUsageBudget must be a non-negative number/)
})
