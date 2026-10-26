// @app/design-system-native — the MOBILE component vocabulary. NativeWind (Tailwind v3)
// over @app/design-tokens, painting React Native views.
//
// HARD CONSTRAINT: this package MUST NOT import @app/design-system. There is no shared
// component layer between the two design systems and there is not going to be one — what
// they share is TOKENS and API SHAPE, nothing else. Tailwind v4 (the web) and the v3 that
// NativeWind requires do not share a class vocabulary, and a DOM tree and an RN view tree do
// not share a box model, so a "universal" component satisfying both would be a third
// implementation wearing the costume of a shortcut. An import here would also drag DOM
// element types into a Metro bundle, where a <div> typechecks cleanly and then renders
// nothing on a device: a failure found by a human holding a phone instead of by tsc.
// SOURCE: tools/exports-walls.json (the single census the `exports` walls, the workspace
// manifests and dependency-cruiser all derive from) — there is no shared React component
// layer, and the layering law design-system-native ↛ design-system is enforced three times over.
//
// The mirror of this rule lives in the web twin's index.ts: that package must not import
// react-native, react-native-web, or this one.
//
// @app/design-system carries the SAME component names and the SAME prop vocabulary wherever
// the concept exists on both platforms — `onPress`, `onChangeText`, `label`, `variant`,
// `testID` — so a feature has a matching surface on each and a screen ports without a rename
// pass. `onPress` on the web is not React Native leaking into the browser; it is the one prop
// name that makes that true.
//
// Where a concept exists on only one platform it says NATIVE-ONLY where it is declared, and
// says why. There are exactly three: `Text.scaleRole` (OS text scaling, which the web meets
// with browser zoom), the `palette` half of `useTheme()` (the RN APIs that take a colour
// STRING rather than a class — ActivityIndicator's `color`, TextInput's
// `placeholderTextColor`), and `useReduceMotion` (the web gets the same gate for free from
// Tailwind's `motion-safe:` variant). The traffic runs the other way exactly once, in
// field-context.ts, where `describedBy` is kept in the shape and is always `undefined`.
//
// preset.ts is deliberately NOT re-exported. It is the build-time Tailwind adapter — it
// RENDERS the committed preset from the tokens — and a barrel that exported it would put a
// code generator inside the import graph of every screen.

export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from './Button'
export { Card, type CardPadding, type CardProps } from './Card'
export { cn } from './cn'
export { EmptyState, type EmptyStateProps } from './EmptyState'
export { Field, type FieldProps } from './Field'
export type { FieldContextValue } from './field-context'
export { useFieldContext } from './field-context'
export { Input, type InputKeyboard, type InputProps } from './Input'
export { Skeleton, type SkeletonProps } from './Skeleton'
export { Spinner, type SpinnerProps, type SpinnerSize } from './Spinner'
export { Text, type TextProps, type TextScaleRole, type TextTone } from './Text'
export { ThemeProvider, type ThemeProviderProps, useTheme } from './ThemeProvider'
// NATIVE-ONLY, and exported rather than kept private: an app-level animation has to obey the
// same OS setting as the primitives, and a second subscription hand-rolled at a call site is
// how one screen keeps moving after the user asked everything to stop.
export { useReduceMotion } from './useReduceMotion'
// The class-string factories are exported so an app-level composite (a list row, a bottom
// sheet) can wear the same variants without re-deriving them — and so the parity gate can
// compare variant NAMES across the two design systems without rendering anything.
// buttonLabelVariants is the one factory with no web counterpart: RN's Text does not inherit
// colour from its parent, so the label's colour is a second class string here instead of a
// property of the button's own.
export {
  buttonLabelVariants,
  buttonVariants,
  cardVariants,
  emptyStateVariants,
  inputVariants,
  skeletonVariants,
  spinnerVariants,
  textVariants,
} from './variants'
