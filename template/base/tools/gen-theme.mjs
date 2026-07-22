#!/usr/bin/env node
// tools/gen-theme.mjs — emit the committed token module from the styleguide manifest.
//
// tools/styleguide.manifest.json is the OKLCH source of truth; this script converts
// every theme's tokens OKLCH -> linear sRGB -> gamma-encoded hex (tools/lib/oklch.mjs,
// the same math the styleguide gate uses to COMPUTE contrast) and writes
// apps/mobile/src/theme/tokens.gen.ts: the palettes plus the fontWeight/text/radius/
// spacing scales from `families`. The output is deterministic and byte-stable (token
// order comes from the manifest's canonical `tokens` array, family keys are sorted,
// formatting is fixed) so the styleguide gate can regen-diff the committed file.
//
// The motion/elevation/sizing/fontScaleCap families are OPTIONAL and content-
// conditional: the manifest is SEEDED (update never rewrites it), so each block is
// emitted only when its family is declared — an older manifest renders byte-
// identically — and a present-but-malformed family THROWS (fail-closed): silently
// skipping a typo'd family would ship a module missing tokens the components expect.
//
// An out-of-gamut OKLCH token is a hard FAIL, never a silent clamp: the platform
// would gamut-map it on screen, so every computed contrast number would describe a
// color nobody sees. Retune the manifest value instead.
// SOURCE: CSS Color 4 OKLCH->sRGB reference conversion + sRGB transfer function
// https://www.w3.org/TR/css-color-4/#color-conversion-code
//   usage: node tools/gen-theme.mjs           (regenerate the committed file)
//          node tools/gen-theme.mjs --check   (exit 2 when the committed file drifts)
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { contrastRatio, inSrgbGamut, oklchToLinearSrgb, relativeLuminance } from './lib/oklch.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MANIFEST = new URL('./styleguide.manifest.json', import.meta.url)
const OUT_REL = 'apps/mobile/src/theme/tokens.gen.ts'

// Linear-light channel -> 8-bit gamma-encoded sRGB (the CSS Color 4 transfer
// function), after the gamut check has guaranteed v in [0,1] (± float slop).
function channelToByte(v) {
  const clamped = Math.min(1, Math.max(0, v))
  const encoded = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055
  return Math.round(encoded * 255)
}

export function oklchToHex({ l, c, h }) {
  const linear = oklchToLinearSrgb(l, c, h)
  if (!inSrgbGamut(linear)) {
    throw new Error(`oklch(${l} ${c} ${h}) is outside the sRGB gamut — retune the manifest value`)
  }
  const bytes = [linear.r, linear.g, linear.b].map(channelToByte)
  return `#${bytes.map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

// Quote a key only when it is not a valid bare TS identifier ('ink-muted', '2xl').
function tsKey(name) {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : `'${name}'`
}

// Regeneration is FAIL-CLOSED on the manifest's own contract: every declared
// contrast pair must clear its minimum in every theme BEFORE any token is
// emitted, so a retuned value that breaks readability can never reach the
// committed module (the styleguide gate re-asserts the same numbers in the
// validate chain — same math, two moments).
export function assertContrast(manifest) {
  const failures = []
  for (const [theme, { tokens }] of Object.entries(manifest.themes)) {
    for (const pair of manifest.contrast) {
      const fg = tokens[pair.fg]
      const bg = tokens[pair.bg]
      const ratio = contrastRatio(
        relativeLuminance(oklchToLinearSrgb(fg.l, fg.c, fg.h)),
        relativeLuminance(oklchToLinearSrgb(bg.l, bg.c, bg.h)),
      )
      if (ratio < pair.min) {
        failures.push(`${theme}: ${pair.fg}/${pair.bg} = ${ratio.toFixed(2)} < ${pair.min}`)
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`contrast contract violated:\n  ${failures.join('\n  ')}`)
  }
}

const isFiniteNumber = (n) => typeof n === 'number' && Number.isFinite(n)
const isPositiveNumber = (n) => isFiniteNumber(n) && n > 0
const isNonEmptyNumberMap = (obj, valueOk) =>
  obj !== null &&
  typeof obj === 'object' &&
  !Array.isArray(obj) &&
  Object.keys(obj).length > 0 &&
  Object.values(obj).every(valueOk)

// A CSS cubic-bezier control quad: [x1, y1, x2, y2] with both x coordinates in
// [0, 1] (time never runs backwards); y may overshoot for spring-like curves.
// SOURCE: CSS Easing Functions Level 1 cubic-bezier() input-progress constraint
// https://www.w3.org/TR/css-easing-1/#cubic-bezier-easing-functions
const isBezierQuad = (e) =>
  Array.isArray(e) &&
  e.length === 4 &&
  e.every(isFiniteNumber) &&
  e[0] >= 0 &&
  e[0] <= 1 &&
  e[2] >= 0 &&
  e[2] <= 1

function emitMotion(lines, motion) {
  if (motion === undefined) return
  const ok =
    motion !== null &&
    typeof motion === 'object' &&
    isNonEmptyNumberMap(motion.duration, isPositiveNumber) &&
    isNonEmptyNumberMap(motion.easing, isBezierQuad) &&
    isPositiveNumber(motion.pressScale) &&
    motion.pressScale <= 1
  if (!ok) {
    throw new Error(
      `families.motion must be { "duration": { <role>: positive ms }, "easing": { <role>: [x1,y1,x2,y2] with x1/x2 in [0,1] }, "pressScale": number in (0,1] } — got ${JSON.stringify(motion)}`,
    )
  }
  lines.push(
    '/** Motion vocabulary: durations (ms), cubic-bezier easings, pressed-state scale. */',
    'export const motion = {',
    '  duration: {',
  )
  for (const k of Object.keys(motion.duration).sort()) {
    lines.push(`    ${tsKey(k)}: ${motion.duration[k]},`)
  }
  lines.push('  },', '  easing: {')
  for (const k of Object.keys(motion.easing).sort()) {
    lines.push(`    ${tsKey(k)}: [${motion.easing[k].join(', ')}],`)
  }
  lines.push('  },', `  pressScale: ${motion.pressScale},`, '} as const', '')
}

function emitElevation(lines, elevation) {
  if (elevation === undefined) return
  const levelOk = (l) =>
    l !== null &&
    typeof l === 'object' &&
    isFiniteNumber(l.offsetY) &&
    isFiniteNumber(l.blur) &&
    l.blur >= 0 &&
    isFiniteNumber(l.opacity) &&
    l.opacity >= 0 &&
    l.opacity <= 1 &&
    Number.isInteger(l.android) &&
    l.android >= 0
  if (!isNonEmptyNumberMap(elevation, levelOk)) {
    throw new Error(
      `families.elevation must be { <level>: { "offsetY": number, "blur": number >= 0, "opacity": number in [0,1], "android": integer >= 0 } } — got ${JSON.stringify(elevation)}`,
    )
  }
  lines.push(
    '/** Elevation levels — spread one onto a surface style ({ ...elevation.raised }). */',
    'export const elevation = {',
  )
  for (const k of Object.keys(elevation).sort()) {
    const l = elevation[k]
    lines.push(
      `  ${tsKey(k)}: {`,
      "    shadowColor: '#000000',",
      `    shadowOffset: { width: 0, height: ${l.offsetY} },`,
      `    shadowOpacity: ${l.opacity},`,
      `    shadowRadius: ${l.blur},`,
      `    elevation: ${l.android},`,
      '  },',
    )
  }
  lines.push('} as const', '')
}

function emitSizing(lines, sizing) {
  if (sizing === undefined) return
  const ok =
    sizing !== null &&
    typeof sizing === 'object' &&
    isPositiveNumber(sizing.minTarget) &&
    isNonEmptyNumberMap(sizing.icon, isPositiveNumber)
  if (!ok) {
    throw new Error(
      `families.sizing must be { "minTarget": positive dp, "icon": { <size>: positive dp } } — got ${JSON.stringify(sizing)}`,
    )
  }
  lines.push(
    '/** Structural sizes (dp): the minimum hit target and the closed icon scale. */',
    'export const sizes = {',
    '  icon: {',
  )
  for (const k of Object.keys(sizing.icon).sort()) {
    lines.push(`    ${tsKey(k)}: ${sizing.icon[k]},`)
  }
  lines.push('  },', `  minTarget: ${sizing.minTarget},`, '} as const', '')
}

function emitFontScaleCap(lines, caps) {
  if (caps === undefined) return
  if (!isNonEmptyNumberMap(caps, (n) => isFiniteNumber(n) && n >= 1)) {
    throw new Error(
      `families.fontScaleCap must be { <role>: number >= 1 } — got ${JSON.stringify(caps)}`,
    )
  }
  lines.push(
    '/** maxFontSizeMultiplier caps: OS font scaling is honored up to these factors. */',
    'export const fontScaleCap = {',
  )
  for (const k of Object.keys(caps).sort()) {
    lines.push(`  ${tsKey(k)}: ${caps[k]},`)
  }
  lines.push('} as const', '')
}

export function renderTokensModule(manifest) {
  assertContrast(manifest)
  const themeNames = Object.keys(manifest.themes).sort()
  const lines = [
    '// GENERATED by tools/gen-theme.mjs — do not edit.',
    '// Source of truth: tools/styleguide.manifest.json (OKLCH). Regenerate with',
    '// `node tools/gen-theme.mjs`; the styleguide gate regen-diffs this file, so a',
    '// hand edit here is a red gate, not a design change.',
    '',
    'export const palettes = {',
  ]
  for (const theme of themeNames) {
    const tokens = manifest.themes[theme].tokens
    // Completeness is structural: every theme carries exactly the canonical token
    // set, in the manifest's canonical order — a theme missing a token would paint
    // the other theme's value on its canvas.
    const declared = Object.keys(tokens).sort().join(',')
    const canonical = [...manifest.tokens].sort().join(',')
    if (declared !== canonical) {
      throw new Error(`theme "${theme}" tokens (${declared}) != manifest token set (${canonical})`)
    }
    lines.push(`  ${tsKey(theme)}: {`)
    for (const name of manifest.tokens) {
      lines.push(`    ${tsKey(name)}: '${oklchToHex(tokens[name])}',`)
    }
    lines.push('  },')
  }
  lines.push(
    '} as const',
    '',
    'export type ResolvedThemeName = keyof typeof palettes',
    `export type TokenName = keyof (typeof palettes)['${themeNames[0]}']`,
    "/** One theme's token set, widened to plain strings for style factories. */",
    'export type Palette = Readonly<Record<TokenName, string>>',
    '',
  )
  const families = manifest.families
  const sortedKeys = (obj) => Object.keys(obj).sort()
  lines.push('export const fontWeight = {')
  for (const k of sortedKeys(families.fontWeight)) {
    lines.push(`  ${tsKey(k)}: '${families.fontWeight[k]}',`)
  }
  lines.push('} as const', '', 'export const typeScale = {')
  for (const k of sortedKeys(families.text)) {
    const { fontSize, lineHeight } = families.text[k]
    lines.push(`  ${tsKey(k)}: { fontSize: ${fontSize}, lineHeight: ${lineHeight} },`)
  }
  lines.push('} as const', '', 'export const radius = {')
  for (const k of sortedKeys(families.radius)) {
    lines.push(`  ${tsKey(k)}: ${families.radius[k]},`)
  }
  lines.push(
    '} as const',
    '',
    '/** Spacing base unit (dp). Multiply it — never hand-write raw offsets. */',
    `export const spacing = ${families.spacing.unit}`,
    '',
  )
  // Optional, content-conditional families — fixed emission order; absent keys
  // emit nothing so an older seeded manifest renders byte-identically.
  emitMotion(lines, families.motion)
  emitElevation(lines, families.elevation)
  emitSizing(lines, families.sizing)
  emitFontScaleCap(lines, families.fontScaleCap)
  return lines.join('\n')
}

// CLI wrapper — only when executed directly, so the styleguide gate (and tests)
// can import the pure render/convert functions without touching the filesystem.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const rendered = renderTokensModule(manifest)
  const outPath = `${ROOT}${OUT_REL}`

  if (process.argv.includes('--check')) {
    let current = null
    try {
      current = readFileSync(outPath, 'utf8')
    } catch {
      // missing counts as drift below
    }
    if (current !== rendered) {
      console.error(
        `GEN-THEME: DRIFT — ${OUT_REL} does not match the manifest; run: node tools/gen-theme.mjs`,
      )
      process.exit(2)
    }
    console.log(`GEN-THEME: CLEAN (${OUT_REL} matches the manifest)`)
  } else {
    writeFileSync(outPath, rendered)
    console.log(`GEN-THEME: wrote ${OUT_REL}`)
  }
}
