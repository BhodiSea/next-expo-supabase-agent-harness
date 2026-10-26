import type { FontWeightName, TypeStep } from '@app/design-tokens'
import type { ReactNode } from 'react'
import { cn } from './cn'
import { textVariants } from './variants'

/** The tone vocabulary — closed on purpose; a sixth colour is a token change. */
export type TextTone = 'default' | 'muted' | 'accent' | 'danger' | 'success'

/** WEB-ONLY: the element to render. Native has no element vocabulary to mirror. */
export type TextElement = 'p' | 'span' | 'div' | 'h1' | 'h2' | 'h3' | 'h4'

export interface TextProps {
  readonly children: ReactNode
  readonly size?: TypeStep
  readonly tone?: TextTone
  readonly weight?: FontWeightName
  /** WEB-ONLY. Heading LEVEL is document structure, not appearance — pick it for the outline, then set `size` for the look. */
  readonly as?: TextElement
  readonly className?: string
  readonly testID?: string
}

// Every string on a screen goes through here. Not for tidiness: `size` and its line
// height travel together in the type ramp, and raw <p> tags inherit whatever leading
// the nearest ancestor happened to set — which is how the same 16px body text ends up
// set at 20 on one screen and 28 on another.
//
// `as` and `size` are separate props BECAUSE they are separate decisions. Choosing
// <h2> for its size is how a page ends up with an outline of h1 → h4 → h2, which reads
// fine visually and is unnavigable with a screen reader.
export function Text({
  children,
  size,
  tone,
  weight,
  as: Element = 'p',
  className,
  testID,
}: TextProps) {
  return (
    <Element className={cn(textVariants({ size, tone, weight }), className)} data-testid={testID}>
      {children}
    </Element>
  )
}
