'use client'

// 'use client' because this module calls createContext/useContext. Without it, ANY server
// module importing the @app/design-system barrel fails the build — Next traces the barrel's
// re-exports and refuses a React context in the RSC graph. The directive does not make the
// consumer a client component; it marks THIS module as a client boundary the server may
// reference. Text/Card/EmptyState/Skeleton/Spinner deliberately stay universal, so a page
// that only needs copy and layout still renders entirely on the server.

import { createContext, useContext } from 'react'

/**
 * What a `Field` hands down to the control it wraps.
 *
 * A context rather than a render prop or cloneElement: the call site stays the shape a
 * reader expects — `<Field label="Email"><Input …/></Field>` — while the control still
 * receives the ids that make the label and the error message part of its accessible
 * description. Wiring those by hand at every call site is the version of this that
 * looks fine and ships an unlabelled input on the one screen nobody re-tested.
 *
 * `controlId` and `describedBy` are DOM concepts and are consumed only on this side of
 * the workspace; the native design system carries the same context with the same field
 * names, where `describedBy` is `undefined` and the association is made through
 * accessibilityLabel/accessibilityHint instead. Keeping the shape identical is what
 * lets a feature move a form between platforms without rewriting its markup logic.
 */
export interface FieldContextValue {
  readonly controlId: string
  /** Space-separated id list for aria-describedby; `undefined` when there is nothing to describe. */
  readonly describedBy: string | undefined
  readonly invalid: boolean
  readonly label: string
}

// `null` (not a default object) so `useFieldContext` can tell "outside a Field" from
// "inside a Field that happens to have no hint" — the two need different behaviour and
// a default object silently merges them.
const FieldContext = createContext<FieldContextValue | null>(null)

export const FieldContextProvider = FieldContext.Provider

/** The wrapping Field's contract, or `null` when the control stands alone. */
export function useFieldContext(): FieldContextValue | null {
  return useContext(FieldContext)
}
