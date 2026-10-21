import type { ReactNode } from 'react'
import { cn } from './cn'
import { cardVariants } from './variants'

export type CardPadding = 'none' | 'sm' | 'md' | 'lg'

export interface CardProps {
  readonly children: ReactNode
  readonly padding?: CardPadding
  /** Lift the card off the canvas with a shadow. */
  readonly elevated?: boolean
  readonly className?: string
  readonly testID?: string
}

// A surface, not a semantic element: Card renders a plain <div> and never guesses at
// <article> or <section>. A generic container that silently emits a landmark pollutes
// the document outline of every page that used it for layout, and the component has no
// way to know which of its uses were structural.
//
// `elevated` is a shadow rather than a lighter background because a card that reads as
// raised BY BRIGHTNESS inverts in dark mode — there, "closer" is lighter but "further
// away" is darker, so the same trick that lifts a card on white pushes it into the page
// on black.
export function Card({ children, padding, elevated, className, testID }: CardProps) {
  return (
    <div className={cn(cardVariants({ padding, elevated }), className)} data-testid={testID}>
      {children}
    </div>
  )
}
