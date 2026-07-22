// tools/lib/oklch.mjs — the OKLCH→sRGB→contrast math the styleguide gate uses to
// COMPUTE (never eyeball) the WCAG contrast ratio of every declared token pair.
// Pure and node-builtin-free: OKLCH → OKLab (polar→rectangular) → LMS′ → cube →
// LMS → linear-light sRGB via the CSS Color 4 reference matrices, then WCAG
// relative luminance on the LINEAR channels and the (Lhi+0.05)/(Llo+0.05) ratio.
// OKLCH can name colors OUTSIDE the sRGB gamut, so a caller gamut-checks before
// trusting a ratio — an out-of-gamut token is displayed gamut-mapped, so its
// on-screen contrast is not the one these numbers describe.
// SOURCE: CSS Color 4 OKLCH→sRGB reference conversion (OKLab polar→rectangular,
// cube LMS, matrices to linear-sRGB) [corpus: csswg/oklch-srgb]
// https://www.w3.org/TR/css-color-4/#color-conversion-code
// SOURCE: WCAG 2.2 relative luminance + contrast ratio [corpus: wcag/relative-luminance]
// https://www.w3.org/TR/WCAG22/#dfn-relative-luminance

// oklchToLinearSrgb(l, c, h): l lightness in [0,1], c chroma, h hue in DEGREES →
// linear-light sRGB { r, g, b } (each nominally [0,1]; out-of-gamut inputs fall
// outside). The two constant matrices are the CSS Color 4 reference values.
export function oklchToLinearSrgb(l, c, h) {
  const hr = (h * Math.PI) / 180
  const a = c * Math.cos(hr)
  const b = c * Math.sin(hr)

  // OKLab → LMS′ (linear), then cube each component to LMS.
  const lp = l + 0.3963377774 * a + 0.2158037573 * b
  const mp = l - 0.1055613458 * a - 0.0638541728 * b
  const sp = l - 0.0894841775 * a - 1.291485548 * b
  const L = lp * lp * lp
  const M = mp * mp * mp
  const S = sp * sp * sp

  // LMS → linear-light sRGB.
  return {
    r: 4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    g: -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    b: -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  }
}

// WCAG relative luminance from LINEAR channels. The OKLCH path already produced
// linear light, so the sRGB gamma-decode WCAG applies to 8-bit inputs is done;
// L = 0.2126·R + 0.7152·G + 0.0722·B over those linear channels.
export function relativeLuminance({ r, g, b }) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

// Contrast ratio from two relative luminances: (Lhi + 0.05)/(Llo + 0.05), 1..21.
export function contrastRatio(lumA, lumB) {
  const hi = Math.max(lumA, lumB)
  const lo = Math.min(lumA, lumB)
  return (hi + 0.05) / (lo + 0.05)
}

// A linear-sRGB triplet is in gamut when every channel sits within [0, 1] (± eps
// for float slop). Out of gamut ⇒ the browser gamut-maps it, so its on-screen
// contrast is not the one relativeLuminance/contrastRatio compute here.
export function inSrgbGamut({ r, g, b }, eps = 1e-4) {
  return [r, g, b].every((v) => v >= -eps && v <= 1 + eps)
}
