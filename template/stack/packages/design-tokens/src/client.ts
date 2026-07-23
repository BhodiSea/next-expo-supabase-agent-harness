// @app/design-tokens — the SINGLE SOURCE for every visual constant in the workspace.
//
// THE TOKEN ARROW IS ONE-WAY: TypeScript → both platforms.
//
//   src/*.ts  (OKLCH colors, unitless ramps — this barrel)
//        │
//        ├── scripts/gen.mjs ──▶ src/generated/web.css     Tailwind v4 @theme
//        └── scripts/gen.mjs ──▶ src/generated/native.ts    the RN theme object
//
// Never the reverse, and never a hand edit of a generated file. Both outputs are
// COMMITTED and regen-diffed, so the tree always carries the artifact a fresh
// generate would produce; the freshness assertion is a unit test in this package
// (tests compare the render functions' output to the committed bytes), which is why
// it runs on every `vitest` and not only when someone remembers to regenerate.
//
// The inverted arrow is the point. In the codebase this lineage descends from, the
// TypeScript token module was DERIVED from the stylesheet and a test asserted the
// mirror — which meant the CSS could be edited freely and the "source" quietly
// followed. Here the stylesheet is an artifact and editing it reds a gate.
//
// WHY THE PLATFORMS CANNOT SHARE MORE THAN THIS: web is Tailwind v4 (CSS-first
// @theme, no config file) and mobile is pinned to Tailwind v3 because NativeWind 4
// requires it. A shared tailwind.config or a shared CSS token file is not a design
// choice this workspace declined — it is structurally impossible across those two
// majors. Sharing THE NUMBERS, one level up, is what actually works.
//
// This module is framework-neutral by construction: no React, no Tailwind, no CSS,
// no react-native, no dependencies at all. That is what lets a gate script, a Next
// server component, and a Metro-bundled screen all read the same values.
//
// This file is the whole public surface; src/index.ts adds nothing to it. The split
// exists because the workspace's export walls give every dual-surface package a
// `./client` key — a package with no server-only half still needs the key so the
// mobile import wall has a name to allow.

export type {
  ColorRamp,
  ContrastPair,
  RampFamily,
  RampStep,
  SemanticPalette,
  SemanticToken,
  ThemeName,
} from './color'
export {
  CONTRAST_CONTRACT,
  RAMP_FAMILIES,
  RAMP_STEPS,
  SEMANTIC_TOKENS,
  THEME_NAMES,
  ramps,
  themes,
} from './color'
export type { Elevation, ElevationName } from './elevation'
export { ELEVATIONS, elevation } from './elevation'
export type { BezierQuad, DurationName, EasingName } from './motion'
export { DURATIONS, EASINGS, PRESS_SCALE, duration, easing } from './motion'
export type { LinearSrgb, Oklch } from './oklch'
export {
  contrastOf,
  contrastRatio,
  inSrgbGamut,
  oklchToHex,
  oklchToLinearSrgb,
  relativeLuminance,
} from './oklch'
export type { RadiusStep } from './radius'
export { RADIUS_FULL, RADIUS_STEPS, radius } from './radius'
// assertTokenContract is exported deliberately: a consumer gate (or a design review)
// can re-run the gamut + contrast preflight without shelling out to the generator.
export { assertTokenContract } from './render'
export type { IconSize, SpaceStep } from './space'
export { ICON_SIZES, MIN_TOUCH_TARGET, SPACE_STEPS, SPACE_UNIT, iconSize, space } from './space'
export type { FontScaleRole, FontWeightName, TypeStep, TypeStyle } from './typography'
export {
  FONT_SCALE_CAPS,
  FONT_WEIGHTS,
  TYPE_STEPS,
  fontScaleCap,
  fontWeight,
  typeScale,
} from './typography'
