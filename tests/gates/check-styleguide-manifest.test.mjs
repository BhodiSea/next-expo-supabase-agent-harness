// Can-fail proofs for the styleguide gate (template/base/tools/check-styleguide-manifest.mjs).
// Fixture strategy: cpSync the REAL template tools/ dir into the fixture (the gate
// spawns `node tools/gen-theme.mjs --check`, which needs gen-theme + lib/oklch.mjs
// beside the manifest), overwrite tools/styleguide.manifest.json per case, and plant
// the SHIPPED committed tokens module — so the GREEN case also proves the template's
// manifest and generated module are in byte lockstep (template drift reds here).
// Pins: schema violations loud, the regen-diff, bidirectional token closure, COMPUTED
// contrast (AAA and AA tiers, ratio printed to 2dp), the raw-value source scans
// (hex / rgb() / named colors / dimension literals / inline style objects), the
// primitive boundary (controlPrimitives + controlAllow, stale/malformed fail closed,
// keyless self-disables with the adoption NOTE), the status-surface colour channel
// (signals, comment blindness, allow escape, fail-closed key), and the accent budget.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { renderTokensModule } from '../../template/base/tools/gen-theme.mjs'

const GATE = fileURLToPath(
  new URL('../../template/base/tools/check-styleguide-manifest.mjs', import.meta.url),
)
const TOOLS = fileURLToPath(new URL('../../template/base/tools', import.meta.url))
const SHIPPED_MANIFEST = readFileSync(join(TOOLS, 'styleguide.manifest.json'), 'utf8')
const SHIPPED_TOKENS = readFileSync(
  fileURLToPath(
    new URL('../../template/stack/apps/mobile/src/theme/tokens.gen.ts', import.meta.url),
  ),
  'utf8',
)

const asText = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2))

/** @param {{ manifest?: any, tokensModule?: any, sources?: Record<string, string>, srcDir?: boolean }} [opts] */
function fixture({
  manifest = SHIPPED_MANIFEST,
  tokensModule = SHIPPED_TOKENS,
  sources = {},
  srcDir = true,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-styleguide-'))
  cpSync(TOOLS, join(dir, 'tools'), { recursive: true })
  if (manifest === null) rmSync(join(dir, 'tools/styleguide.manifest.json'))
  else writeFileSync(join(dir, 'tools/styleguide.manifest.json'), asText(manifest))
  if (srcDir) {
    mkdirSync(join(dir, 'apps/mobile/src'), { recursive: true })
    if (tokensModule !== null) {
      mkdirSync(join(dir, 'apps/mobile/src/theme'), { recursive: true })
      writeFileSync(join(dir, 'apps/mobile/src/theme/tokens.gen.ts'), tokensModule)
    }
    // The shipped manifest names a motion seam and a touchable base — plant
    // minimal stand-ins by default so their existence checks hold, exactly
    // like the tokens module above. Tests override them via `sources`.
    const seamAndBase = {
      'apps/mobile/src/lib/motion.ts': 'export const seam = true\n',
      'apps/mobile/src/components/PressableScale.tsx':
        'const base = { minHeight: sizes.minTarget }\nexport const PressableScale = () => <Pressable style={base}>x</Pressable>\n',
    }
    for (const [rel, content] of Object.entries(seamAndBase)) {
      if (sources[rel] === undefined) {
        const abs = join(dir, rel)
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, content)
      }
    }
  }
  for (const [rel, content] of Object.entries(sources)) {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return dir
}

function withManifest(mutate) {
  const m = JSON.parse(SHIPPED_MANIFEST)
  mutate(m)
  return m
}

function runGate(dir, { ci = true } = {}) {
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  delete env.GITHUB_BASE_REF
  if (ci) env.CI = 'true'
  const res = spawnSync(process.execPath, [GATE], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('the SHIPPED manifest renders byte-identically to the COMMITTED tokens module (template lockstep)', () => {
  assert.equal(renderTokensModule(JSON.parse(SHIPPED_MANIFEST)), SHIPPED_TOKENS)
})

test('GREEN: shipped manifest + module + clean sources pass with no NOTE', () => {
  const r = runGate(
    fixture({
      sources: {
        'apps/mobile/src/features/notes/Panel.tsx':
          'export function Panel({ styles }) {\n  return <View style={styles.panel}>ok</View>\n}\n',
      },
    }),
  )
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('styleguide: OK'), r.out)
  assert.ok(r.out.includes('in lockstep'), r.out)
  assert.ok(r.out.includes('accent 0/10'), r.out)
  assert.ok(r.out.includes('primitive boundary held'), r.out)
  assert.ok(!r.out.includes('NOTE'), r.out)
})

// ---- 1: schema ------------------------------------------------------------------

test('RED: schema violations are loud — tokens shape, OKLCH value shape, contrast pair shape', () => {
  const badTokens = runGate(fixture({ manifest: withManifest((m) => (m.tokens = [])) }))
  assert.equal(badTokens.code, 1, badTokens.out)
  assert.ok(badTokens.out.includes('tokens must be a non-empty array'), badTokens.out)

  const badValue = runGate(
    fixture({ manifest: withManifest((m) => (m.themes.dark.tokens.accent = { l: 'x' })) }),
  )
  assert.equal(badValue.code, 1, badValue.out)
  assert.ok(badValue.out.includes('must be { "l": number, "c": number, "h": number }'), badValue.out)

  const badPair = runGate(
    fixture({ manifest: withManifest((m) => m.contrast.push({ fg: 'ink' })) }),
  )
  assert.equal(badPair.code, 1, badPair.out)
  assert.ok(badPair.out.includes('contrast entries must be'), badPair.out)
})

test('RED: an out-of-gamut OKLCH token is contrast-unverifiable', () => {
  const r = runGate(
    fixture({ manifest: withManifest((m) => (m.themes.dark.tokens.accent.c = 0.4)) }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('outside the sRGB gamut'), r.out)
  assert.ok(r.out.includes('unverifiable'), r.out)
})

// ---- 1b: optional families (motion / elevation / sizing / fontScaleCap) ----------
// Content-conditional like controlPrimitives: absent families emit nothing (an
// older seeded manifest renders byte-identically), present-but-malformed families
// THROW in the generator, which the gate surfaces through the regen-diff spawn.

test('the shipped manifest declares the optional families and the module carries their blocks', () => {
  const m = JSON.parse(SHIPPED_MANIFEST)
  for (const family of ['motion', 'elevation', 'sizing', 'fontScaleCap']) {
    assert.ok(m.families[family] !== undefined, `families.${family} missing from shipped manifest`)
  }
  for (const block of ['export const motion', 'export const elevation', 'export const sizes', 'export const fontScaleCap']) {
    assert.ok(SHIPPED_TOKENS.includes(block), `${block} missing from shipped tokens module`)
  }
})

test('GREEN backward-compat: a manifest WITHOUT the optional families renders the legacy module shape', () => {
  const m = withManifest((man) => {
    delete man.families.motion
    delete man.families.elevation
    delete man.families.sizing
    delete man.families.fontScaleCap
  })
  const rendered = renderTokensModule(m)
  assert.ok(!rendered.includes('export const motion'), 'motion must not emit without its family')
  assert.ok(!rendered.includes('export const elevation'), 'elevation must not emit without its family')
  assert.ok(rendered.endsWith('export const spacing = 4\n'), 'legacy module must still end at spacing')
  const r = runGate(fixture({ manifest: m, tokensModule: rendered }))
  assert.equal(r.code, 0, r.out)
})

test('RED: a present-but-malformed optional family FAILS CLOSED (generator throws, gate reds)', () => {
  const badMotion = runGate(
    fixture({ manifest: withManifest((m) => (m.families.motion.pressScale = 0)) }),
  )
  assert.equal(badMotion.code, 1, badMotion.out)
  assert.ok(badMotion.out.includes('families.motion must be'), badMotion.out)

  const badEasing = runGate(
    fixture({ manifest: withManifest((m) => (m.families.motion.easing.standard = [2, 0, 0, 1])) }),
  )
  assert.equal(badEasing.code, 1, badEasing.out)
  assert.ok(badEasing.out.includes('families.motion must be'), badEasing.out)

  const badElevation = runGate(
    fixture({ manifest: withManifest((m) => (m.families.elevation.raised.opacity = 1.5)) }),
  )
  assert.equal(badElevation.code, 1, badElevation.out)
  assert.ok(badElevation.out.includes('families.elevation must be'), badElevation.out)

  const badSizing = runGate(
    fixture({ manifest: withManifest((m) => (m.families.sizing.minTarget = -1)) }),
  )
  assert.equal(badSizing.code, 1, badSizing.out)
  assert.ok(badSizing.out.includes('families.sizing must be'), badSizing.out)

  const badCap = runGate(
    fixture({ manifest: withManifest((m) => (m.families.fontScaleCap.dense = 0.5)) }),
  )
  assert.equal(badCap.code, 1, badCap.out)
  assert.ok(badCap.out.includes('families.fontScaleCap must be'), badCap.out)
})

// ---- 2: regen-diff --------------------------------------------------------------

test('RED: a hand-edited tokens.gen.ts is a regen-diff drift, not a design change', () => {
  const tokensModule = SHIPPED_TOKENS.replace("canvas: '#0b0e10'", "canvas: '#0b0e11'")
  assert.notEqual(tokensModule, SHIPPED_TOKENS, 'fixture replacement must hit')
  const r = runGate(fixture({ tokensModule }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('drifted from tools/styleguide.manifest.json (regen-diff)'), r.out)
  assert.ok(r.out.includes('GEN-THEME: DRIFT'), r.out)
  assert.ok(r.out.includes('hand edit'), r.out)
})

test('RED: a MISSING tokens module is generated data gone absent', () => {
  const r = runGate(fixture({ tokensModule: null }))
  assert.equal(r.code, 1, r.out)
  assert.ok(
    r.out.includes('apps/mobile/src/theme/tokens.gen.ts missing — the committed token module is generated data'),
    r.out,
  )
})

// ---- 3: token closure, both ways ------------------------------------------------

test('RED closure: a manifest token no theme/module declares reds BOTH sides', () => {
  const r = runGate(fixture({ manifest: withManifest((m) => m.tokens.push('phantom')) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('theme "dark" does not declare token "phantom"'), r.out)
  assert.ok(r.out.includes('documents token "phantom"'), r.out)
  assert.ok(r.out.includes('no longer declares it'), r.out)
})

test('RED closure: a module token the manifest does not document is a hand-grown palette', () => {
  const tokensModule = SHIPPED_TOKENS.replace(
    "    canvas: '#0b0e10',",
    "    canvas: '#0b0e10',\n    phantom: '#123456',",
  )
  assert.notEqual(tokensModule, SHIPPED_TOKENS, 'fixture replacement must hit')
  const r = runGate(fixture({ tokensModule }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('palettes.dark.phantom exists in apps/mobile/src/theme/tokens.gen.ts but is not documented'), r.out)
})

// ---- 4: computed contrast -------------------------------------------------------

test('RED: an AAA (min 7) reading pair reds printing the computed ratio to 2dp', () => {
  // Lighten the light ink: still past AA 4.5, short of AAA 7 — only the raised
  // per-pair min in the manifest DATA can produce this red.
  const r = runGate(
    fixture({ manifest: withManifest((m) => (m.themes.light.tokens.ink.l = 0.47)) }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('theme "light" contrast ink on'), r.out)
  assert.ok(/ink on \w+ = \d+\.\d{2}:1 \(min 7:1\)/.test(r.out), r.out)
  assert.ok(r.out.includes('FIX: retune'), r.out)
})

test('RED: an AA (min 4.5) accent pair below its min reds in-gamut', () => {
  const r = runGate(
    fixture({ manifest: withManifest((m) => (m.themes.light.tokens.accent.l = 0.65)) }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('theme "light" contrast accent on'), r.out)
  assert.ok(r.out.includes('(min 4.5:1)'), r.out)
})

// ---- 5a: raw color/dimension values ---------------------------------------------

test('RED: a raw hex string literal in a scanned file reds naming file and value', () => {
  const rel = 'apps/mobile/src/features/bad/Swatch.tsx'
  const r = runGate(fixture({ sources: { [rel]: "export const c = '#ff0000'\n" } }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(rel), r.out)
  assert.ok(r.out.includes('raw hex color'), r.out)
  assert.ok(r.out.includes('#ff0000'), r.out)
})

test('RED: rgb()/named colors red in color positions; transparent is the one allowed keyword', () => {
  const fn = runGate(
    fixture({ sources: { 'apps/mobile/src/lib/c.ts': "export const c = 'rgb(20 20 20)'\n" } }),
  )
  assert.equal(fn.code, 1, fn.out)
  assert.ok(fn.out.includes('raw rgb() color'), fn.out)

  const named = runGate(
    fixture({
      sources: { 'apps/mobile/src/features/x/T.tsx': "const s = { color: 'tomato' }\nexport default s\n" },
    }),
  )
  assert.equal(named.code, 1, named.out)
  assert.ok(named.out.includes('named color "tomato" on color'), named.out)

  const transparent = runGate(
    fixture({
      sources: {
        'apps/mobile/src/features/x/T.tsx': "const s = { backgroundColor: 'transparent' }\nexport default s\n",
      },
    }),
  )
  assert.equal(transparent.code, 0, transparent.out)
})

test('dimension keys: a bare numeric literal reds; 0 and token arithmetic are green', () => {
  const red = runGate(
    fixture({
      sources: { 'apps/mobile/src/features/x/s.ts': 'export const s = { padding: 12 }\n' },
    }),
  )
  assert.equal(red.code, 1, red.out)
  assert.ok(red.out.includes('raw dimension "padding: 12"'), red.out)

  const green = runGate(
    fixture({
      sources: {
        'apps/mobile/src/features/x/s.ts':
          'export const s = { padding: 0, gap: spacing * 2, fontSize: 2 * spacing }\n',
      },
    }),
  )
  assert.equal(green.code, 0, green.out)
})

test('inline style objects: a raw numeric outside the components home reds; inside it passes', () => {
  const body = 'export const Box = () => <View style={{ width: 13 }} />\n'
  const red = runGate(fixture({ sources: { 'apps/mobile/app/settings.tsx': body } }))
  assert.equal(red.code, 1, red.out)
  assert.ok(red.out.includes('inline style={{ width: 13 }}'), red.out)
  assert.ok(red.out.includes('useThemedStyles factory'), red.out)

  const home = runGate(fixture({ sources: { 'apps/mobile/src/components/Box.tsx': body } }))
  assert.equal(home.code, 0, home.out)
})

test('GREEN: .test.tsx files are excluded from the source scans', () => {
  const r = runGate(
    fixture({
      sources: {
        'apps/mobile/src/features/x/Widget.test.tsx':
          "export const c = '#ff0000'\nconst s = { padding: 12 }\nexport default s\n",
      },
    }),
  )
  assert.equal(r.code, 0, r.out)
})

test('allow (raw-value escape): a reviewed entry exempts the file; a malformed entry fails LOUD', () => {
  const rel = 'apps/mobile/src/features/vendor/logo.tsx'
  const allowed = runGate(
    fixture({
      manifest: withManifest((m) =>
        m.allow.push({ file: rel, reason: 'vendor brand mark, colors fixed by the vendor' }),
      ),
      sources: { [rel]: "export const brand = '#ff8800'\n" },
    }),
  )
  assert.equal(allowed.code, 0, allowed.out)

  const malformed = runGate(
    fixture({ manifest: withManifest((m) => m.allow.push({ file: rel })) }),
  )
  assert.equal(malformed.code, 1, malformed.out)
  assert.ok(malformed.out.includes('allow entry must be'), malformed.out)
})

// ODDITY (pinned current behavior, inherited from the desktop original): the raw-value
// `allow` list is fail-closed on MALFORMED entries but has NO staleness check — an
// entry whose file is gone (or no longer trips any scan) passes silently, unlike
// controlAllow and statusSurfaces.allow, which both red stale entries so their lists
// "can only shrink to reality". If the gate ever grows the staleness check, flip this
// assertion to red.
test('ODDITY: a STALE raw-value allow entry (file does not exist) currently passes the gate', () => {
  const r = runGate(
    fixture({
      manifest: withManifest((m) =>
        m.allow.push({ file: 'apps/mobile/src/features/x/Gone.tsx', reason: 'stale test' }),
      ),
    }),
  )
  assert.equal(r.code, 0, r.out)
})

// ---- 5b: primitive boundary -----------------------------------------------------

const RAW_PRESSABLE =
  'export const Bad = () => (\n  <Pressable style={styles.btn} onPress={go}>\n    Go\n  </Pressable>\n)\n'

test('RED: a raw styled control outside the primitives home reds with the FIX line', () => {
  const rel = 'apps/mobile/src/features/x/Row.tsx'
  const r = runGate(fixture({ sources: { [rel]: RAW_PRESSABLE } }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(`${rel}: raw <Pressable …> carries a style prop outside apps/mobile/src/components`), r.out)
  assert.ok(r.out.includes('FIX: render it through the Button primitive'), r.out)
  assert.ok(r.out.includes('controlAllow'), r.out)

  const input = runGate(
    fixture({
      sources: {
        'apps/mobile/app/form.tsx':
          'export const F = () => <TextInput style={s.field} value={v} />\n',
      },
    }),
  )
  assert.equal(input.code, 1, input.out)
  assert.ok(input.out.includes('the Input primitive'), input.out)
})

test('GREEN: the touchable BASE file is where raw pressables live by design (0.1.2: base supersedes home-wide)', () => {
  const r = runGate(
    fixture({
      sources: {
        'apps/mobile/src/components/PressableScale.tsx':
          'const s = { b: { minHeight: sizes.minTarget } }\nexport const Base = () => (\n  <Pressable style={s.b} onPress={go}>\n    Go\n  </Pressable>\n)\n',
      },
    }),
  )
  assert.equal(r.code, 0, r.out)
})

test('controlAllow: a live violation is exempted; missing-file and no-match entries are STALE reds', () => {
  const rel = 'apps/mobile/src/features/grid/Cell.tsx'
  const live = runGate(
    fixture({
      manifest: withManifest((m) =>
        m.controlAllow.push({ file: rel, reason: 'per-row hot-path control, reviewed' }),
      ),
      sources: { [rel]: RAW_PRESSABLE },
    }),
  )
  assert.equal(live.code, 0, live.out)

  const gone = runGate(
    fixture({
      manifest: withManifest((m) =>
        m.controlAllow.push({ file: 'apps/mobile/src/features/x/Gone.tsx', reason: 'stale' }),
      ),
    }),
  )
  assert.equal(gone.code, 1, gone.out)
  assert.ok(gone.out.includes('does not exist — stale entry'), gone.out)

  const noMatch = runGate(
    fixture({
      manifest: withManifest((m) => m.controlAllow.push({ file: rel, reason: 'stale' })),
      sources: { [rel]: 'export const Clean = () => <View>ok</View>\n' },
    }),
  )
  assert.equal(noMatch.code, 1, noMatch.out)
  assert.ok(noMatch.out.includes('matches there anymore'), noMatch.out)
})

test('RED: a malformed controlPrimitives key FAILS CLOSED; a keyless manifest self-disables with the NOTE', () => {
  const malformed = runGate(
    fixture({
      manifest: withManifest((m) => {
        m.controlPrimitives = { tags: [], home: 'apps/mobile/src/components' }
      }),
    }),
  )
  assert.equal(malformed.code, 1, malformed.out)
  assert.ok(malformed.out.includes('controlPrimitives must be'), malformed.out)
  assert.ok(malformed.out.includes('cannot silently disarm'), malformed.out)

  const keyless = runGate(
    fixture({
      manifest: withManifest((m) => {
        delete m.controlPrimitives
        delete m.controlAllow
      }),
      sources: { 'apps/mobile/src/features/x/Row.tsx': RAW_PRESSABLE },
    }),
  )
  assert.equal(keyless.code, 0, keyless.out) // the violation is withheld — the scan is off
  assert.ok(keyless.out.includes('styleguide: NOTE'), keyless.out)
  assert.ok(keyless.out.includes('no "controlPrimitives" key'), keyless.out)
  assert.ok(keyless.out.includes('update --refresh-seeded tools/styleguide.manifest.json'), keyless.out)
})

// ---- 5c: status surfaces --------------------------------------------------------

const ALERT_NO_TOKEN =
  'export function Banner() {\n  return <View role="alert">Could not load notes.</View>\n}\n'
const ALERT_WITH_TOKEN =
  'export function Banner({ palette }) {\n  return <View role="alert" style={{ borderColor: palette.danger }}>Could not load notes.</View>\n}\n'

test('status: a role=alert surface with no status token reds; the danger-inked one passes', () => {
  const rel = 'apps/mobile/src/features/x/Banner.tsx'
  const red = runGate(fixture({ sources: { [rel]: ALERT_NO_TOKEN } }))
  assert.equal(red.code, 1, red.out)
  assert.ok(red.out.includes(`${rel}: announces status (role="alert")`), red.out)
  assert.ok(red.out.includes('references no status token'), red.out)

  const green = runGate(fixture({ sources: { [rel]: ALERT_WITH_TOKEN } }))
  assert.equal(green.code, 0, green.out)
})

test('status: a token named ONLY in a comment does not count (comments are blanked first)', () => {
  const rel = 'apps/mobile/src/features/x/Banner.tsx'
  const commented = `// palette.danger is the right ink here\n/* variant="success" would fool a naive scan */\n${ALERT_NO_TOKEN}`
  const r = runGate(fixture({ sources: { [rel]: commented } }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('announces status'), r.out)
})

test('status: allow is the reviewed escape and its entries must stay LIVE', () => {
  const rel = 'apps/mobile/src/features/x/Banner.tsx'
  const allowed = withManifest((m) => {
    m.statusSurfaces.allow = [{ file: rel, reason: 'legacy surface, redesign scheduled' }]
  })
  const live = runGate(fixture({ manifest: allowed, sources: { [rel]: ALERT_NO_TOKEN } }))
  assert.equal(live.code, 0, live.out)

  const stale = runGate(fixture({ manifest: allowed, sources: { [rel]: ALERT_WITH_TOKEN } }))
  assert.equal(stale.code, 1, stale.out)
  assert.ok(stale.out.includes('no longer announces status'), stale.out)
  assert.ok(stale.out.includes('stale entry'), stale.out)
})

test('status: a declared token absent from tokens[] and a malformed key both FAIL CLOSED', () => {
  const bogusToken = runGate(
    fixture({
      manifest: withManifest((m) => {
        m.statusSurfaces.tokens = ['danger', 'warning']
      }),
    }),
  )
  assert.equal(bogusToken.code, 1, bogusToken.out)
  assert.ok(bogusToken.out.includes('not in tokens[]'), bogusToken.out)

  const malformed = runGate(
    fixture({
      manifest: withManifest((m) => {
        m.statusSurfaces = { tokens: [], signals: [] }
      }),
    }),
  )
  assert.equal(malformed.code, 1, malformed.out)
  assert.ok(malformed.out.includes('cannot silently disarm'), malformed.out)
})

test('status: a keyless manifest self-disables with the adoption NOTE', () => {
  const r = runGate(
    fixture({
      manifest: withManifest((m) => {
        delete m.statusSurfaces
      }),
      sources: { 'apps/mobile/src/features/x/Banner.tsx': ALERT_NO_TOKEN },
    }),
  )
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('no "statusSurfaces" key'), r.out)
  assert.ok(r.out.includes('refresh-seeded'), r.out)
})

// ---- 5d/5e/5f: motion discipline, elevation keys, the hit-target floor -----------

test('RED 5d: a literal duration/delay outside the motion tokens reds; 0 and token refs pass', () => {
  const red = runGate(
    fixture({
      sources: {
        'apps/mobile/src/features/x/anim.ts': 'export const cfg = { duration: 250 }\n',
      },
    }),
  )
  assert.equal(red.code, 1, red.out)
  assert.ok(red.out.includes('literal motion value "duration: 250"'), red.out)

  const green = runGate(
    fixture({
      sources: {
        'apps/mobile/src/features/x/anim.ts':
          'export const cfg = { duration: motion.duration.base, delay: 0 }\n',
      },
    }),
  )
  assert.equal(green.code, 0, green.out)
})

test('RED 5d: a raw Animated/Easing reference outside the seam and the home reds; both allowed homes pass', () => {
  const body = 'export const spin = () => Animated.timing(v, { toValue: 1 })\n'
  const red = runGate(fixture({ sources: { 'apps/mobile/src/features/x/spin.ts': body } }))
  assert.equal(red.code, 1, red.out)
  assert.ok(red.out.includes('raw Animated. reference outside the motion seam'), red.out)
  assert.ok(red.out.includes('apps/mobile/src/lib/motion.ts'), red.out)

  const inSeam = runGate(fixture({ sources: { 'apps/mobile/src/lib/motion.ts': body } }))
  assert.equal(inSeam.code, 0, inSeam.out)

  const inHome = runGate(fixture({ sources: { 'apps/mobile/src/components/Spinny.tsx': body } }))
  assert.equal(inHome.code, 0, inHome.out)
})

test('RED 5d: a motionSeam naming a missing file is stale, and a malformed key fails CLOSED', () => {
  const stale = runGate(
    fixture({ manifest: withManifest((m) => (m.motionSeam = 'apps/mobile/src/lib/gone.ts')) }),
  )
  assert.equal(stale.code, 1, stale.out)
  assert.ok(stale.out.includes('but the file does not exist'), stale.out)
  assert.ok(stale.out.includes('the one animation door is gone'), stale.out)

  const malformed = runGate(fixture({ manifest: withManifest((m) => (m.motionSeam = '  ')) }))
  assert.equal(malformed.code, 1, malformed.out)
  assert.ok(malformed.out.includes('motionSeam must be a non-empty file path'), malformed.out)
})

test('RED 5e: a raw shadow/elevation style key outside the tokens module reds', () => {
  const r = runGate(
    fixture({
      sources: {
        'apps/mobile/src/features/x/depth.ts': 'export const s = { shadowOpacity: 0.3 }\n',
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('raw elevation key "shadowOpacity:"'), r.out)
  assert.ok(r.out.includes('...elevation.raised'), r.out)
})

const STYLED_PRESSABLE_NO_TARGET =
  'export const Chip = () => <Pressable style={s.chip} onPress={go}>x</Pressable>\n'

test('RED 5f: a home file styling a raw control without minTarget reds; referencing it passes', () => {
  const rel = 'apps/mobile/src/components/Chip.tsx'
  const red = runGate(fixture({ sources: { [rel]: STYLED_PRESSABLE_NO_TARGET } }))
  assert.equal(red.code, 1, red.out)
  assert.ok(red.out.includes('never references sizes.minTarget'), red.out)

  const green = runGate(
    fixture({
      sources: {
        [rel]:
          'const s = { chip: { minHeight: sizes.minTarget } }\nexport const Chip = () => <Pressable style={s.chip} onPress={go}>x</Pressable>\n',
      },
    }),
  )
  // Still red — the BASE check: a pressable styled outside the declared base.
  assert.equal(green.code, 1, green.out)
  assert.ok(green.out.includes('styled outside the touchable base'), green.out)
})

test('RED base: a second raw pressable primitive in the home reds naming the base; TextInput files stay per-home rules', () => {
  const pressable = runGate(
    fixture({
      sources: {
        'apps/mobile/src/components/AltButton.tsx':
          'const s = { b: { minHeight: sizes.minTarget } }\nexport const AltButton = () => <Pressable style={s.b} onPress={go}>x</Pressable>\n',
      },
    }),
  )
  assert.equal(pressable.code, 1, pressable.out)
  assert.ok(pressable.out.includes('styled outside the touchable base'), pressable.out)
  assert.ok(pressable.out.includes('PressableScale.tsx'), pressable.out)

  // A styled TextInput in its own home file is NOT a base violation (the base
  // tags are the pressable class) — it only owes the minTarget reference.
  const input = runGate(
    fixture({
      sources: {
        'apps/mobile/src/components/AltInput.tsx':
          'const s = { f: { minHeight: sizes.minTarget } }\nexport const AltInput = () => <TextInput style={s.f} />\n',
      },
    }),
  )
  assert.equal(input.code, 0, input.out)
})

test('RED base: malformed controlPrimitives.base fails CLOSED; a base tag outside controlPrimitives.tags too', () => {
  const malformed = runGate(
    fixture({
      manifest: withManifest((m) => {
        m.controlPrimitives.base = { file: '', tags: ['Pressable'] }
      }),
    }),
  )
  assert.equal(malformed.code, 1, malformed.out)
  assert.ok(malformed.out.includes('controlPrimitives.base must be'), malformed.out)

  const alienTag = runGate(
    fixture({
      manifest: withManifest((m) => {
        m.controlPrimitives.base.tags = ['Pressable', 'ScrollView']
      }),
    }),
  )
  assert.equal(alienTag.code, 1, alienTag.out)
  assert.ok(alienTag.out.includes('subset of controlPrimitives.tags'), alienTag.out)
})

test('keyless design-depth manifest self-disables with ONE combined adoption NOTE', () => {
  const r = runGate(
    fixture({
      manifest: withManifest((m) => {
        delete m.motionSeam
        delete m.families.elevation
        delete m.families.sizing
        delete m.controlPrimitives.base
      }),
      // Regenerate the module for the shrunken manifest so regen-diff stays green.
      tokensModule: renderTokensModule(
        withManifest((m) => {
          delete m.families.elevation
          delete m.families.sizing
        }),
      ),
      sources: {
        // All three violations are withheld — the scans are off.
        'apps/mobile/src/features/x/loose.ts':
          'export const cfg = { duration: 250, shadowOpacity: 0.3 }\n',
        'apps/mobile/src/components/Chip.tsx': STYLED_PRESSABLE_NO_TARGET,
      },
    }),
  )
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('design-depth checks OFF'), r.out)
  assert.ok(r.out.includes('motionSeam'), r.out)
  assert.ok(r.out.includes('families.elevation'), r.out)
  assert.ok(r.out.includes('refresh-seeded'), r.out)
})

// ---- 6: accent budget -----------------------------------------------------------

test('RED: exceeding the accent usage budget reds with the total and the per-file count', () => {
  const rel = 'apps/mobile/src/features/loud/Loud.tsx'
  const refs = Array.from({ length: 11 }, () => 'p.accent').join(', ')
  const r = runGate(fixture({ sources: { [rel]: `export const loud = (p) => [${refs}]\n` } }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('accent tokens referenced 11× (budget 10)'), r.out)
  assert.ok(r.out.includes(`${rel}: 11`), r.out)
})

// ---- prerequisites --------------------------------------------------------------

test('RED: a missing or unparseable manifest fails loud — the design contract is never optional', () => {
  const missing = runGate(fixture({ manifest: null }))
  assert.equal(missing.code, 1, missing.out)
  assert.ok(missing.out.includes('tools/styleguide.manifest.json missing'), missing.out)

  const broken = runGate(fixture({ manifest: '{ nope' }))
  assert.equal(broken.code, 1, broken.out)
  assert.ok(broken.out.includes('not valid JSON'), broken.out)
})

test('skip asymmetry: no apps/mobile/src → loud local SKIP (exit 0), CI fail-closed (exit 1)', () => {
  const dir = fixture({ srcDir: false })
  const local = runGate(dir, { ci: false })
  assert.equal(local.code, 0, local.out)
  assert.ok(local.out.includes('SKIPPED'), local.out)
  const ci = runGate(dir, { ci: true })
  assert.equal(ci.code, 1, ci.out)
})
