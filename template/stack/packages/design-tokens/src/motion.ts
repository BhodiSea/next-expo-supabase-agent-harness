// The motion vocabulary: three durations, three easing curves, one pressed-state
// scale. Deliberately tiny — motion is the token family where "just this once"
// produces an app whose transitions all feel subtly different.
//
// Durations are milliseconds on both platforms (CSS takes ms, React Native's
// Animated takes ms), so this is the one family that needs no per-platform
// translation at all.
//
// EVERY animation built on these MUST collapse to a static end state when the user
// has asked for reduced motion — `prefers-reduced-motion` on web, the OS reduce-motion
// setting via AccessibilityInfo on native. The tokens cannot enforce that; the
// components do, and it is why the primitives in both design systems animate only
// transform and opacity (the two properties that can be dropped without changing
// layout).
// SOURCE: WCAG 2.2 SC 2.3.3 Animation from Interactions — motion triggered by
// interaction can be disabled unless essential [corpus: wcag/reduced-motion]
// https://www.w3.org/TR/WCAG22/#animation-from-interactions

/** Canonical ORDER, fastest → slowest. The generators iterate this array. */
export const DURATIONS = ['fast', 'base', 'slow'] as const
export type DurationName = (typeof DURATIONS)[number]

// fast: state feedback the user already caused (press, focus) — long enough to be
// seen, short enough that it never gates the next tap.
// base: anything entering or leaving the screen.
// slow: full-surface transitions only; above ~320ms an interface starts to feel
// like it is deciding whether to obey.
export const duration: Readonly<Record<DurationName, number>> = {
  fast: 120,
  base: 200,
  slow: 320,
}

/** Canonical ORDER — the generators iterate this array. */
export const EASINGS = ['standard', 'decelerate', 'accelerate'] as const
export type EasingName = (typeof EASINGS)[number]

/** A CSS cubic-bezier control quad: [x1, y1, x2, y2]. */
export type BezierQuad = readonly [number, number, number, number]

// Both x coordinates stay inside [0,1] — time never runs backwards. The y values may
// leave [0,1] for spring-like overshoot; none of these three do, because overshoot on
// a control that can be tapped again mid-animation reads as lag, not life.
// SOURCE: CSS Easing Functions Level 1 — cubic-bezier() input-progress constraint
// https://www.w3.org/TR/css-easing-1/#cubic-bezier-easing-functions
export const easing: Readonly<Record<EasingName, BezierQuad>> = {
  standard: [0.2, 0, 0, 1],
  decelerate: [0, 0, 0.2, 1],
  accelerate: [0.3, 0, 1, 1],
}

/**
 * The pressed-state scale factor. One number, applied by both platforms' pressable
 * primitive, so "pressed" feels identical everywhere. 0.97 is deliberately small:
 * anything deeper reads as the control moving away from the finger.
 */
export const PRESS_SCALE = 0.97
