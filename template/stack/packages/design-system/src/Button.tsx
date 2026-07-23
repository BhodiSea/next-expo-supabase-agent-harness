import { useId } from 'react'
import { cn } from './cn'
import { Spinner } from './Spinner'
import { buttonVariants } from './variants'

export type ButtonVariant = 'solid' | 'outline' | 'ghost'
export type ButtonSize = 'sm' | 'md'

export interface ButtonProps {
  /** BOTH the visible text and the accessible name — one string, so they cannot disagree. */
  readonly label: string
  readonly onPress?: () => void
  readonly variant?: ButtonVariant
  readonly size?: ButtonSize
  readonly disabled?: boolean
  /** In-flight: the control stays focusable and announces busy, rather than vanishing. */
  readonly busy?: boolean
  /** What pressing DOES, when the label alone does not say it. Announced after the name. */
  readonly accessibilityHint?: string
  /** WEB-ONLY: 'submit' inside a form. Native has no form element to submit to. */
  readonly type?: 'button' | 'submit'
  readonly className?: string
  readonly testID?: string
}

// The press handler is `onPress`, not `onClick`, on BOTH platforms. That is not React
// Native leaking into the browser — it is the one prop name that lets a feature move a
// screen between surfaces without a rename pass, and "press" is the accurate word for
// what a touchscreen browser reports anyway. The DOM name is an implementation detail
// of this file.
//
// `busy` deliberately does not swap the label for a spinner. Replacing the text
// collapses the button's width mid-interaction (the layout jumps under the finger that
// is still on it) and destroys the accessible name at the exact moment a screen-reader
// user is waiting to hear what happened. The spinner is additive; the name is constant.
export function Button({
  label,
  onPress,
  variant,
  size,
  disabled = false,
  busy = false,
  accessibilityHint,
  type = 'button',
  className,
  testID,
}: ButtonProps) {
  // The hint is a described-by target, not aria-label: a name says WHAT the control is
  // and a description says what it does. Folding the hint into the name makes every
  // announcement of the button read the whole sentence, including in a list of
  // landmarks where only the name is spoken.
  const hintId = useId()
  return (
    <button
      type={type === 'submit' ? 'submit' : 'button'}
      onClick={onPress}
      // Disabled while busy too: the request is already in flight, so a second press is
      // a duplicate mutation, not impatience the UI should honour.
      disabled={disabled || busy}
      aria-busy={busy}
      aria-describedby={accessibilityHint === undefined ? undefined : hintId}
      data-testid={testID}
      className={cn(buttonVariants({ variant, size }), className)}
    >
      {busy ? <Spinner size="sm" label={label} /> : null}
      {label}
      {accessibilityHint === undefined ? null : (
        <span id={hintId} className="sr-only">
          {accessibilityHint}
        </span>
      )}
    </button>
  )
}
