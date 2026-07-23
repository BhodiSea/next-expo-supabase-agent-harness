import { cn } from './cn'
import { spinnerVariants } from './variants'

export type SpinnerSize = 'sm' | 'md' | 'lg'

export interface SpinnerProps {
  readonly size?: SpinnerSize
  /** REQUIRED accessible name — "Loading", "Saving changes". There is no default. */
  readonly label: string
  readonly className?: string
  readonly testID?: string
}

// `label` is required, with no default, for one reason: a spinner is the only thing on
// screen at the moment it matters, and an unlabelled one announces nothing at all —
// the page simply goes quiet for a screen-reader user while everyone else watches an
// animation. Defaulting it to "Loading" would be worse than requiring it, because
// "Loading" is almost never the useful sentence ("Saving changes" is).
//
// role="status" (a polite live region), not role="progressbar": there is no determinate
// value to report, and a progressbar without aria-valuenow is announced as 0%.
//
// The spin is motion-safe. Under reduced motion the ring stops but stays a visibly
// PARTIAL ring — the busy state is still legible without the animation, which is what
// separates honouring the setting from breaking the component.
export function Spinner({ size, label, className, testID }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      data-testid={testID}
      className={cn(spinnerVariants({ size }), className)}
    />
  )
}
