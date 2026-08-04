'use client'

// 'use client': useId + useMemo are hooks, and hooks cannot run in a Server Component.

import * as Label from '@radix-ui/react-label'
import { type ReactNode, useId, useMemo } from 'react'
import { cn } from './cn'
import { FieldContextProvider } from './field-context'
import { textVariants } from './variants'

export interface FieldProps {
  /** The visible label AND the control's accessible name — one string, one truth. */
  readonly label: string
  /** Standing guidance ("we never share this"). Always present, always described-by. */
  readonly hint?: string
  /** The current validation failure. Presence is what puts the control in its error state. */
  readonly error?: string
  readonly required?: boolean
  readonly children: ReactNode
  readonly className?: string
  readonly testID?: string
}

// The label/hint/error wrapper. It owns the ids and hands them to the control through
// context, so a form's markup stays `<Field label="Email"><Input …/></Field>` and the
// wiring that makes a screen reader announce "Email, invalid, that address is already
// registered" cannot be forgotten at a call site.
//
// Radix's Label rather than a bare <label>: the native element re-fires a click on its
// control, so double-clicking a label to select its text also toggles a checkbox, and
// text selection inside a label drags focus. Radix suppresses exactly that. Everything
// else here is a <div> — a primitive earns a dependency when the DOM behaviour is
// subtle, and nothing about a paragraph of hint text is.
export function Field({
  label,
  hint,
  error,
  required = false,
  children,
  className,
  testID,
}: FieldProps) {
  const controlId = useId()
  const hintId = `${controlId}-hint`
  const errorId = `${controlId}-error`
  const invalid = error !== undefined

  // Both ids when both are present: an error must not silence the hint, because the
  // hint is usually the thing that explains how to fix the error.
  const describedBy = useMemo(() => {
    const ids = [hint === undefined ? null : hintId, invalid ? errorId : null].filter(
      (id): id is string => id !== null,
    )
    return ids.length > 0 ? ids.join(' ') : undefined
  }, [hint, invalid, hintId, errorId])

  const context = useMemo(
    () => ({ controlId, describedBy, invalid, label }),
    [controlId, describedBy, invalid, label],
  )

  return (
    <div className={cn('flex flex-col gap-1.5', className)} data-testid={testID}>
      <Label.Root htmlFor={controlId} className="text-sm font-medium text-ink">
        {label}
        {/* The asterisk is decorative — aria-hidden, because "Email star" is not a
            field name. The real signal is `required` on the control itself. */}
        {required ? (
          <span aria-hidden="true" className="text-danger">
            {' *'}
          </span>
        ) : null}
      </Label.Root>
      <FieldContextProvider value={context}>{children}</FieldContextProvider>
      {/* Hint and error are plain elements, not <Text>: they are the one place in the
          system that must carry a DOM id, and putting an `id` prop on Text would add a
          web-only prop to a component whose whole job is to be identical on both
          platforms. They still paint through the type ramp. */}
      {hint === undefined ? null : (
        <p id={hintId} className={cn(textVariants({ size: 'sm', tone: 'muted' }))}>
          {hint}
        </p>
      )}
      {/* role="alert" so a validation failure that appears AFTER the user left the
          field is still announced. Without it the message is silent for exactly the
          users who cannot see the red border. */}
      {error === undefined ? null : (
        <p id={errorId} role="alert" className={cn(textVariants({ size: 'sm', tone: 'danger' }))}>
          {error}
        </p>
      )}
    </div>
  )
}
