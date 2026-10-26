// OKLCH → linear sRGB → gamma-encoded hex, plus the WCAG relative-luminance and
// contrast-ratio pair. Pure math, zero dependencies, zero platform assumptions —
// this file is what lets the token module DECLARE colors perceptually (OKLCH) and
// still hand every consumer a value its renderer can actually paint.
//
// This is the single, canonical implementation of that conversion. The styleguide
// and tokens gates no longer recompute colors in a parallel gate-side copy — they
// regen-diff the committed generated output (packages/design-tokens/src/generated/*)
// against this package, so the CSS Color 4 reference conversion lives in exactly one
// place. The constants are pinned by a test in this package, so an edit that changes
// a matrix coefficient reds rather than silently shifting every shipped color.
// SOURCE: CSS Color 4 OKLCH→sRGB reference conversion (OKLab polar→rectangular,
// cube LMS, matrices to linear-sRGB) [corpus: csswg/oklch-srgb]
// https://www.w3.org/TR/css-color-4/#color-conversion-code
// SOURCE: WCAG 2.2 relative luminance + contrast ratio [corpus: wcag/relative-luminance]
// https://www.w3.org/TR/WCAG22/#dfn-relative-luminance

/** A color declared perceptually: lightness in [0,1], chroma, hue in DEGREES. */
export interface Oklch {
  readonly l: number
  readonly c: number
  readonly h: number
}

/** Linear-light sRGB. Nominally [0,1] per channel; out-of-gamut inputs fall outside. */
export interface LinearSrgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

// The two constant matrices below are the CSS Color 4 reference values, transcribed
// verbatim. They are pinned by oklch.test.ts: a "cleanup" that rounds a coefficient
// would move every hex this package emits by an invisible amount and pass review.
export function oklchToLinearSrgb({ l, c, h }: Oklch): LinearSrgb {
  const hr = (h * Math.PI) / 180
  const a = c * Math.cos(hr)
  const b = c * Math.sin(hr)

  // OKLab → LMS′ (linear), then cube each component to LMS.
  const lp = l + 0.3963377774 * a + 0.2158037573 * b
  const mp = l - 0.1055613458 * a - 0.0638541728 * b
  const sp = l - 0.0894841775 * a - 1.291485548 * b
  const lms = lp * lp * lp
  const mms = mp * mp * mp
  const sms = sp * sp * sp

  // LMS → linear-light sRGB.
  return {
    r: 4.0767416621 * lms - 3.3077115913 * mms + 0.2309699292 * sms,
    g: -1.2684380046 * lms + 2.6097574011 * mms - 0.3413193965 * sms,
    b: -0.0041960863 * lms - 0.7034186147 * mms + 1.707614701 * sms,
  }
}

// WCAG relative luminance over LINEAR channels. The OKLCH path already produced
// linear light, so the sRGB gamma-decode WCAG prescribes for 8-bit inputs is
// already done; applying it again here would double-decode and inflate every ratio.
export function relativeLuminance({ r, g, b }: LinearSrgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Contrast ratio from two relative luminances: (Lhi + 0.05)/(Llo + 0.05), 1..21. */
export function contrastRatio(lumA: number, lumB: number): number {
  const hi = Math.max(lumA, lumB)
  const lo = Math.min(lumA, lumB)
  return (hi + 0.05) / (lo + 0.05)
}

// A linear-sRGB triplet is in gamut when every channel sits inside [0,1] (± eps for
// float slop). OKLCH can name colors OUTSIDE sRGB: the platform gamut-maps those on
// screen, so every contrast number computed for them describes a color nobody sees.
// The generator treats out-of-gamut as a hard failure rather than clamping.
export function inSrgbGamut({ r, g, b }: LinearSrgb, eps = 1e-4): boolean {
  return [r, g, b].every((v) => v >= -eps && v <= 1 + eps)
}

// Linear-light channel → 8-bit gamma-encoded sRGB (the CSS Color 4 transfer
// function). Callers gamut-check FIRST; the clamp here is float-slop insurance,
// not a substitute for that check.
function channelToByte(v: number): number {
  const clamped = Math.min(1, Math.max(0, v))
  const encoded = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055
  return Math.round(encoded * 255)
}

/**
 * `#rrggbb` for an OKLCH color. THROWS when the color is outside the sRGB gamut —
 * React Native has no OKLCH parser and no gamut mapping, so a clamped value would
 * ship a different color to mobile than the browser paints from the same token.
 */
export function oklchToHex(color: Oklch): string {
  const linear = oklchToLinearSrgb(color)
  if (!inSrgbGamut(linear)) {
    throw new Error(
      `oklch(${color.l} ${color.c} ${color.h}) is outside the sRGB gamut — retune the ramp value`,
    )
  }
  const bytes = [linear.r, linear.g, linear.b].map(channelToByte)
  return `#${bytes.map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

/** WCAG contrast ratio between two OKLCH colors — the number, never an eyeball. */
export function contrastOf(fg: Oklch, bg: Oklch): number {
  return contrastRatio(
    relativeLuminance(oklchToLinearSrgb(fg)),
    relativeLuminance(oklchToLinearSrgb(bg)),
  )
}
