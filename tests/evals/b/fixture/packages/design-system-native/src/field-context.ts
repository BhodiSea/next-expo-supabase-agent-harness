import { createContext, useContext } from 'react'

/**
 * What a `Field` hands down to the control it wraps — the same shape, the same field
 * names, as the web design system's field context.
 *
 * The shape is identical on purpose even though half of it is inert here.
 * `controlId` and `describedBy` are DOM concepts: React Native associates a label with
 * a control through `accessibilityLabel`/`accessibilityHint` on the control itself,
 * not through an id reference. Keeping the two contexts congruent is what lets a form's
 * markup logic move between surfaces unchanged; dropping the two fields on this side
 * would mean any shared form helper had to branch on platform.
 *
 * `controlId` is still a real, stable value here (React's useId) — it is just not read
 * by the native controls. `describedBy` is always `undefined`.
 */
export interface FieldContextValue {
  readonly controlId: string
  /** WEB-ONLY in effect: always `undefined` on this platform. */
  readonly describedBy: string | undefined
  readonly invalid: boolean
  readonly label: string
}

// `null`, not a default object, so `useFieldContext` can tell "outside a Field" from
// "inside a Field with nothing to describe" — the two need different behaviour.
const FieldContext = createContext<FieldContextValue | null>(null)

export const FieldContextProvider = FieldContext.Provider

/** The wrapping Field's contract, or `null` when the control stands alone. */
export function useFieldContext(): FieldContextValue | null {
  return useContext(FieldContext)
}
