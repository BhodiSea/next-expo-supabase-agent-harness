// The type ramp: six sizes, each with its line height BOUND TO IT.
//
// Size and leading travel together because they are one decision. A ramp that ships
// only font sizes leaves leading to the component author, and the result is the same
// 16px body text set at 20 on one screen and 28 on another — the single most common
// way a design system stops looking like one.
//
// Sizes and leadings are unitless; web divides by 16 to get rem, native uses them as
// dp directly. Leadings are absolute (not multipliers) because React Native's
// `lineHeight` is absolute — expressing the ramp as ratios would make the native
// adapter do float math and land a half-pixel off the web rendering.

/** Canonical ORDER, smallest → largest. The generators iterate this array. */
export const TYPE_STEPS = ['xs', 'sm', 'base', 'lg', 'xl', '2xl'] as const
export type TypeStep = (typeof TYPE_STEPS)[number]

export interface TypeStyle {
  readonly fontSize: number
  readonly lineHeight: number
}

export const typeScale: Readonly<Record<TypeStep, TypeStyle>> = {
  xs: { fontSize: 12, lineHeight: 16 },
  sm: { fontSize: 14, lineHeight: 20 },
  base: { fontSize: 16, lineHeight: 24 },
  lg: { fontSize: 18, lineHeight: 28 },
  xl: { fontSize: 20, lineHeight: 28 },
  '2xl': { fontSize: 24, lineHeight: 32 },
}

/** Canonical ORDER, lightest → heaviest. */
export const FONT_WEIGHTS = ['normal', 'medium', 'semibold', 'bold'] as const
export type FontWeightName = (typeof FONT_WEIGHTS)[number]

// Numeric here, stringified by the native adapter: React Native's TextStyle types
// `fontWeight` as a string union ('400' | '500' | …), so emitting numbers into the
// native theme would force every call site into a cast.
export const fontWeight: Readonly<Record<FontWeightName, number>> = {
  normal: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
}

/** The two font-scaling roles. */
export const FONT_SCALE_CAPS = ['default', 'dense'] as const
export type FontScaleRole = (typeof FONT_SCALE_CAPS)[number]

/**
 * Caps on OS text scaling, as multipliers of the ramp size.
 *
 * NATIVE-ONLY BY CONSTRUCTION: these feed React Native's `maxFontSizeMultiplier`,
 * which has no web counterpart — browser zoom scales the whole layout, so the web
 * side needs no cap and the generated web theme deliberately does not emit these.
 *
 * `default` (2x) is the reading-surface cap: honour the user's setting far past the
 * point of comfort before clipping anything. `dense` (1.3x) applies only where the
 * row height is fixed by a virtualised list — there, uncapped scaling does not make
 * text bigger, it makes text invisible behind a clipped row.
 */
export const fontScaleCap: Readonly<Record<FontScaleRole, number>> = {
  default: 2,
  dense: 1.3,
}
