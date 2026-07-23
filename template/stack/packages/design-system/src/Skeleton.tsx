import type { RadiusStep } from '@app/design-tokens'
import { cn } from './cn'
import { skeletonVariants } from './variants'

export interface SkeletonProps {
  /** Explicit width in px. Omit and pass `fullWidth` to fill the container instead. */
  readonly width?: number
  readonly height?: number
  readonly fullWidth?: boolean
  readonly rounded?: RadiusStep
  readonly className?: string
  readonly testID?: string
}

// aria-hidden, always. A skeleton is a picture of content that does not exist yet;
// exposing it to the accessibility tree announces a screenful of empty boxes. The
// loading state is announced ONCE, by the Spinner or by the region's own aria-busy —
// never by the placeholders.
//
// Width and height are inline styles rather than utility classes because they are
// caller data, not design decisions: a skeleton matches the shape of the content it
// stands in for, and that shape is measured at the call site. Everything the design
// system does own here — the surface colour, the radius, the pulse — comes from tokens.
export function Skeleton({ width, height, fullWidth, rounded, className, testID }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      data-testid={testID}
      style={{ width, height }}
      className={cn(skeletonVariants({ rounded, fullWidth }), className)}
    />
  )
}
