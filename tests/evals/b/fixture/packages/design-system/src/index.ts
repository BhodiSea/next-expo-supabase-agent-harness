// @app/design-system — the WEB component vocabulary. Tailwind v4 + Radix over
// @app/design-tokens.
//
// HARD CONSTRAINT: this package MUST NOT import react-native, react-native-web, or
// @app/design-system-native. It renders DOM elements and is compiled into a Next
// bundle; a react-native import here would either fail Metro-less bundling outright or
// (worse, via react-native-web) succeed and ship a second, silently divergent styling
// engine into the browser.
//
// Its mobile twin, @app/design-system-native, carries the SAME component names and the
// SAME prop vocabulary wherever the concept exists on both platforms — `onPress`,
// `onChangeText`, `label`, `variant`, `testID` — so a feature has a matching surface on
// each surface and a screen can be ported without a rename pass. What the two share is
// TOKENS and API SHAPE. They share no implementation and no component layer: Tailwind
// v4 (here) and the v3 NativeWind requires do not share a class vocabulary, and a DOM
// tree and an RN view tree do not share a box model.
//
// Where a concept exists on only one platform it is marked WEB-ONLY on the prop and
// says why. There are exactly three: `Text.as` (element vocabulary), `Button.type`
// (form submission), and the `controlId`/`describedBy` half of the field context (DOM
// ids).

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
export { Text, type TextElement, type TextProps, type TextTone } from './Text'
export { ThemeProvider, type ThemeProviderProps, useTheme } from './ThemeProvider'
// The class-string factories are exported so an app-level composite (a data table, a
// dialog) can wear the same variants without re-deriving them — and so the parity gate
// can compare variant NAMES across the two design systems without rendering anything.
export {
  buttonVariants,
  cardVariants,
  emptyStateVariants,
  inputVariants,
  skeletonVariants,
  spinnerVariants,
  textVariants,
} from './variants'
