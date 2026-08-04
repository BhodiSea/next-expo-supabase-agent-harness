import type { Oklch } from './oklch'

// THE color source — the "metal" preset. Every hex on mobile and every `oklch()`
// in the web theme is derived from the numbers in this file — nothing else
// declares a color anywhere in the workspace, which is the whole point of the
// package.
//
// This variant's hues and chromas are vendored from oklch-metal-tokens v0.5.0
// (dist/tokens.json, tag 6bb51e3) — design tokens whose colours are spectral
// integrations of measured material optics. The mapping: neutral is osmium,
// accent is copper (the palette's brand anchor), danger is hematite (iron-oxide
// red), success is verdigris (copper's own corrosion product — chosen upstream
// because a conventional green collides with the red under deuteranopia).
//
// The derivation honours both systems' doctrine — "hue and chroma belong to the
// material; lightness belongs to you": the harness LIGHTNESS curve below is kept
// verbatim (it is what positions the WCAG contract), while per step the hue is a
// piecewise-linear interpolation of the material's measured rungs by lightness
// and the chroma is min(material trajectory at that lightness, the family's
// measured ceiling, 90% of max in-gamut chroma at that lightness and hue),
// rounded DOWN to three decimals so rounding can never exceed a cap.
// SOURCE: CSS Color 4 — OKLCH is the perceptually uniform polar form used for
// palette construction [corpus: csswg/oklch-srgb]

/** Ramp steps, light → dark. Canonical ORDER: the generators iterate this array. */
export const RAMP_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const
export type RampStep = (typeof RAMP_STEPS)[number]

/** Ramp families, in canonical order. One neutral, one accent, two status hues. */
export const RAMP_FAMILIES = ['neutral', 'accent', 'danger', 'success'] as const
export type RampFamily = (typeof RAMP_FAMILIES)[number]

export type ColorRamp = Readonly<Record<RampStep, Oklch>>

// The shared lightness curve — IDENTICAL to the default preset, on purpose. Not
// linear: the ends are compressed (the 50→300 and 800→950 deltas are small)
// because near white and near black a fixed lightness delta reads as a much
// larger perceptual jump, and because the semantic tokens that must clear WCAG
// AAA (ink over canvas, 7:1) land on 100/800 — those two steps are positioned by
// the contrast contract below, not by aesthetics. Keeping this curve is what
// lets a material palette swap in without re-litigating a single contrast floor.
const rampLightness: Readonly<Record<RampStep, number>> = {
  50: 0.97,
  100: 0.93,
  200: 0.88,
  300: 0.82,
  400: 0.72,
  500: 0.6,
  600: 0.47,
  700: 0.32,
  800: 0.25,
  900: 0.21,
  950: 0.16,
}

// Hue per family PER STEP, in degrees. A measured material drifts in hue along
// its own trajectory (copper walks 65 → 59 from sheen into occlusion; osmium
// 258 → 264), so a single per-family hue would flatten exactly the thing the
// measurement captured. Each value is the material's interpolated hue at that
// step's lightness.
const rampHue: Readonly<Record<RampFamily, Readonly<Record<RampStep, number>>>> = {
  neutral: {
    50: 258,
    100: 258,
    200: 258,
    300: 258,
    400: 258,
    500: 256.5,
    600: 255.5,
    700: 260,
    800: 260.2,
    900: 262,
    950: 264,
  },
  accent: {
    50: 65,
    100: 65,
    200: 64.8,
    300: 63.8,
    400: 61.1,
    500: 60.4,
    600: 59.7,
    700: 59,
    800: 59,
    900: 59,
    950: 59,
  },
  danger: {
    50: 23.5,
    100: 23.5,
    200: 23.1,
    300: 23.3,
    400: 23.8,
    500: 25.1,
    600: 28.2,
    700: 32.5,
    800: 32.5,
    900: 32.5,
    950: 32.5,
  },
  success: {
    50: 188.7,
    100: 188.7,
    200: 188.7,
    300: 188.7,
    400: 188.9,
    500: 189.4,
    600: 189.7,
    700: 189.7,
    800: 189.7,
    900: 189.7,
    950: 189.7,
  },
}

// Chroma per family per step: min(material trajectory, measured family ceiling,
// 0.9 × max in-gamut chroma at the step's lightness and hue), floored to 3 dp —
// the headroom is what keeps the ramp inside sRGB after the float round-trip
// through the conversion matrices. The neutral (osmium) family stays under
// 0.03: enough for the greys to read as the cool blue-grey of the metal, far
// too little to read as a color.
const rampChroma: Readonly<Record<RampFamily, Readonly<Record<RampStep, number>>>> = {
  neutral: {
    50: 0.012,
    100: 0.023,
    200: 0.023,
    300: 0.023,
    400: 0.029,
    500: 0.027,
    600: 0.025,
    700: 0.024,
    800: 0.026,
    900: 0.022,
    950: 0.018,
  },
  accent: {
    50: 0.017,
    100: 0.042,
    200: 0.062,
    300: 0.084,
    400: 0.12,
    500: 0.109,
    600: 0.096,
    700: 0.068,
    800: 0.053,
    900: 0.045,
    950: 0.035,
  },
  danger: {
    50: 0.005,
    100: 0.005,
    200: 0.008,
    300: 0.014,
    400: 0.025,
    500: 0.046,
    600: 0.072,
    700: 0.083,
    800: 0.068,
    900: 0.068,
    950: 0.055,
  },
  success: {
    50: 0.038,
    100: 0.095,
    200: 0.134,
    300: 0.128,
    400: 0.112,
    500: 0.093,
    600: 0.073,
    700: 0.049,
    800: 0.039,
    900: 0.033,
    950: 0.025,
  },
}

// Composed explicitly rather than with a reduce + type assertion: `Record<RampStep,
// Oklch>` built by mutation needs an `as` cast to typecheck, and a cast is exactly
// the thing that would let a missing step through silently.
function buildRamp(family: RampFamily): ColorRamp {
  const h = rampHue[family]
  const c = rampChroma[family]
  return {
    50: { l: rampLightness[50], c: c[50], h: h[50] },
    100: { l: rampLightness[100], c: c[100], h: h[100] },
    200: { l: rampLightness[200], c: c[200], h: h[200] },
    300: { l: rampLightness[300], c: c[300], h: h[300] },
    400: { l: rampLightness[400], c: c[400], h: h[400] },
    500: { l: rampLightness[500], c: c[500], h: h[500] },
    600: { l: rampLightness[600], c: c[600], h: h[600] },
    700: { l: rampLightness[700], c: c[700], h: h[700] },
    800: { l: rampLightness[800], c: c[800], h: h[800] },
    900: { l: rampLightness[900], c: c[900], h: h[900] },
    950: { l: rampLightness[950], c: c[950], h: h[950] },
  }
}

/** The four ramps. Consumers style through the SEMANTIC layer below, not these. */
export const ramps: Readonly<Record<RampFamily, ColorRamp>> = {
  neutral: buildRamp('neutral'),
  accent: buildRamp('accent'),
  danger: buildRamp('danger'),
  success: buildRamp('success'),
}

/**
 * The semantic token vocabulary — the ONLY color names a component may reference.
 * Canonical ORDER: both generators iterate this array, so the emitted files are
 * byte-stable regardless of object key ordering.
 *
 * Deliberately eight, and deliberately WITHOUT an "on-accent" ink: the accent is a
 * tint (borders, focus rings, links), never a fill sitting behind text. That single
 * rule is what keeps the contract below at ten pairs instead of the twenty a
 * filled-accent system needs, and it is why no screen can produce an unreadable
 * accent button.
 */
export const SEMANTIC_TOKENS = [
  'canvas',
  'surface',
  'edge',
  'ink',
  'ink-muted',
  'accent',
  'danger',
  'success',
] as const
export type SemanticToken = (typeof SEMANTIC_TOKENS)[number]

/** The two themes. `dark` is the design base; `light` is a full token override. */
export const THEME_NAMES = ['dark', 'light'] as const
export type ThemeName = (typeof THEME_NAMES)[number]

export type SemanticPalette = Readonly<Record<SemanticToken, Oklch>>

// Every semantic token is a RAMP STEP, never a bespoke value: an orphan color is a
// color no one can re-derive, and the light/dark pair stays symmetric (both themes
// pick the same step indices, mirrored around the middle of the ramp).
export const themes: Readonly<Record<ThemeName, SemanticPalette>> = {
  dark: {
    canvas: ramps.neutral[950],
    surface: ramps.neutral[900],
    edge: ramps.neutral[700],
    ink: ramps.neutral[100],
    'ink-muted': ramps.neutral[400],
    accent: ramps.accent[300],
    danger: ramps.danger[400],
    success: ramps.success[400],
  },
  light: {
    canvas: ramps.neutral[50],
    surface: ramps.neutral[100],
    edge: ramps.neutral[300],
    ink: ramps.neutral[800],
    'ink-muted': ramps.neutral[600],
    accent: ramps.accent[600],
    danger: ramps.danger[600],
    success: ramps.success[600],
  },
}

export interface ContrastPair {
  readonly fg: SemanticToken
  readonly bg: SemanticToken
  readonly min: number
}

/**
 * The readability contract, COMPUTED per theme by the generator and re-asserted by
 * this package's tests — never eyeballed, and never checked once at design time and
 * then trusted forever.
 *
 * Tiering: the primary reading pairs (ink over canvas, ink over surface) carry 7:1,
 * the AAA bar for body text, in BOTH themes. Muted text, the accent, and the status
 * hues carry the AA 4.5:1 bar deliberately — pushing them to 7 would collapse the
 * muted/primary distinction that makes a dense screen readable at all.
 *
 * `edge` carries no pair on purpose: it is a divider between two filled surfaces,
 * not text and not a control boundary. The control-boundary role (SC 1.4.11, 3:1
 * against the adjacent surface) is filled by `ink-muted`, which already clears 4.5
 * here — that is why Input borders use ink-muted at rest and edge is never load
 * bearing for identifying a control.
 * SOURCE: WCAG 2.2 SC 1.4.6 (AAA, 7:1 body text), SC 1.4.3 (AA, 4.5:1), SC 1.4.11
 * (3:1 non-text contrast for UI component boundaries) [corpus: wcag/contrast-aa]
 * https://www.w3.org/TR/WCAG22/#contrast-enhanced
 */
export const CONTRAST_CONTRACT: readonly ContrastPair[] = [
  { fg: 'ink', bg: 'canvas', min: 7 },
  { fg: 'ink', bg: 'surface', min: 7 },
  { fg: 'ink-muted', bg: 'canvas', min: 4.5 },
  { fg: 'ink-muted', bg: 'surface', min: 4.5 },
  { fg: 'accent', bg: 'canvas', min: 4.5 },
  { fg: 'accent', bg: 'surface', min: 4.5 },
  { fg: 'danger', bg: 'canvas', min: 4.5 },
  { fg: 'danger', bg: 'surface', min: 4.5 },
  { fg: 'success', bg: 'canvas', min: 4.5 },
  { fg: 'success', bg: 'surface', min: 4.5 },
]
