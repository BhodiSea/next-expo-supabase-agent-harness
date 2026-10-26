import type { Oklch } from './oklch'

// THE color source. Every hex on mobile and every `oklch()` in the web theme is
// derived from the numbers in this file — nothing else declares a color anywhere
// in the workspace, which is the whole point of the package.
//
// Colors are declared in OKLCH, not hex, because OKLCH is perceptually uniform:
// holding chroma and hue fixed and walking LIGHTNESS gives steps that read as
// evenly spaced AND makes the WCAG contrast of any pair predictable from the two
// lightness values. The same ramp expressed in hex is untunable — you cannot
// darken one step without accidentally shifting its hue.
//
// Structure: a shared LIGHTNESS curve across all four families (so `accent.400`
// and `neutral.400` sit at the same visual depth and can be swapped without
// re-checking contrast) and a per-family CHROMA curve peaked in the mid steps
// (sRGB simply cannot hold much chroma near white or black — a flat chroma curve
// would put the ends outside the gamut, and an out-of-gamut token is a generator
// failure here, never a silent clamp).
// SOURCE: CSS Color 4 — OKLCH is the perceptually uniform polar form used for
// palette construction [corpus: csswg/oklch-srgb]

/** Ramp steps, light → dark. Canonical ORDER: the generators iterate this array. */
export const RAMP_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const
export type RampStep = (typeof RAMP_STEPS)[number]

/** Ramp families, in canonical order. One neutral, one accent, two status hues. */
export const RAMP_FAMILIES = ['neutral', 'accent', 'danger', 'success'] as const
export type RampFamily = (typeof RAMP_FAMILIES)[number]

export type ColorRamp = Readonly<Record<RampStep, Oklch>>

// The shared lightness curve. Not linear ON PURPOSE: the ends are compressed (the
// 50→300 and 800→950 deltas are small) because near white and near black a fixed
// lightness delta reads as a much larger perceptual jump, and because the semantic
// tokens that must clear WCAG AAA (ink over canvas, 7:1) land on 100/800 — those
// two steps are positioned by the contrast contract below, not by aesthetics.
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

// Hue per family, in degrees. Near-monochrome UI (one cool neutral) plus a single
// cyan-teal accent and two status hues — a closed set, so "which blue?" is never a
// per-screen decision.
const rampHue: Readonly<Record<RampFamily, number>> = {
  neutral: 240,
  accent: 200,
  danger: 25,
  success: 150,
}

// Chroma per family per step. Every value is <= 90% of the maximum in-gamut chroma
// at its (lightness, hue) — the headroom is what keeps the ramp inside sRGB after
// the float round-trip through the conversion matrices. The neutral family peaks at
// 0.012: enough for the greys to feel cool and intentional, far too little to read
// as a color.
const rampChroma: Readonly<Record<RampFamily, Readonly<Record<RampStep, number>>>> = {
  neutral: {
    50: 0.002,
    100: 0.004,
    200: 0.006,
    300: 0.009,
    400: 0.011,
    500: 0.012,
    600: 0.011,
    700: 0.009,
    800: 0.008,
    900: 0.006,
    950: 0.005,
  },
  accent: {
    50: 0.023,
    100: 0.045,
    200: 0.071,
    300: 0.101,
    400: 0.11,
    500: 0.091,
    600: 0.071,
    700: 0.048,
    800: 0.038,
    900: 0.032,
    950: 0.024,
  },
  danger: {
    50: 0.013,
    100: 0.031,
    200: 0.057,
    300: 0.09,
    400: 0.156,
    500: 0.2,
    600: 0.171,
    700: 0.116,
    800: 0.091,
    900: 0.076,
    950: 0.058,
  },
  success: {
    50: 0.027,
    100: 0.052,
    200: 0.082,
    300: 0.117,
    400: 0.142,
    500: 0.148,
    600: 0.116,
    700: 0.079,
    800: 0.061,
    900: 0.052,
    950: 0.039,
  },
}

// Composed explicitly rather than with a reduce + type assertion: `Record<RampStep,
// Oklch>` built by mutation needs an `as` cast to typecheck, and a cast is exactly
// the thing that would let a missing step through silently.
function buildRamp(family: RampFamily): ColorRamp {
  const h = rampHue[family]
  const c = rampChroma[family]
  return {
    50: { l: rampLightness[50], c: c[50], h },
    100: { l: rampLightness[100], c: c[100], h },
    200: { l: rampLightness[200], c: c[200], h },
    300: { l: rampLightness[300], c: c[300], h },
    400: { l: rampLightness[400], c: c[400], h },
    500: { l: rampLightness[500], c: c[500], h },
    600: { l: rampLightness[600], c: c[600], h },
    700: { l: rampLightness[700], c: c[700], h },
    800: { l: rampLightness[800], c: c[800], h },
    900: { l: rampLightness[900], c: c[900], h },
    950: { l: rampLightness[950], c: c[950], h },
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
