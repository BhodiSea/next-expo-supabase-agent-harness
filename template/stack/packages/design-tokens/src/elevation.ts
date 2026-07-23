// Elevation: two levels, and the ONLY reason it is a token family rather than a class
// is that the two platforms express it with entirely different primitives.
//
// The web has one property (box-shadow) that takes offset, blur and colour. React
// Native has TWO unrelated APIs — shadowColor/shadowOffset/shadowOpacity/shadowRadius
// on iOS, a single `elevation` depth on Android — and no expression maps between them.
// Declaring the DESIGN INTENT here (how far off the surface, how soft, how dark) and
// letting each adapter render it in its own primitive is the only way "raised" means
// the same thing on both, instead of two people picking numbers that look close.
//
// Two levels, not six. Depth is the token family that most invites invention, and a
// screen with four distinct shadow depths does not read as layered — it reads as
// unfinished.
//
// The shadow colour is always black at the declared opacity, on both themes. A tinted
// shadow is a real technique and it is deliberately not available: on a dark canvas a
// tinted shadow is invisible, so a component that relied on it would silently lose its
// elevation in one theme.

/** Canonical ORDER, nearest → furthest from the surface. Generators iterate this. */
export const ELEVATIONS = ['raised', 'overlay'] as const
export type ElevationName = (typeof ELEVATIONS)[number]

export interface Elevation {
  /** Vertical offset in dp/px. Light comes from above, so shadows fall down. */
  readonly offsetY: number
  /** Blur radius in dp/px. */
  readonly blur: number
  /** Shadow alpha, 0..1. */
  readonly opacity: number
  /**
   * Android's `elevation` depth in dp. Not derivable from the other three: Android
   * renders a shadow from a depth value using its own light model, so the mapping is a
   * design judgement about what looks equivalent, not an arithmetic conversion.
   * SOURCE: Android elevation is a dp depth rendered by the platform's own light model,
   * not a shadow specification
   * https://developer.android.com/develop/ui/views/theming/shadows-clipping
   */
  readonly android: number
}

export const elevation: Readonly<Record<ElevationName, Elevation>> = {
  // A card sitting on the canvas. Barely there on purpose — its job is to separate,
  // not to float.
  raised: { offsetY: 1, blur: 3, opacity: 0.18, android: 2 },
  // Anything covering content: sheets, menus, toasts. Deliberately much deeper, so the
  // two levels are never mistaken for each other at a glance.
  overlay: { offsetY: 4, blur: 12, opacity: 0.3, android: 8 },
}
