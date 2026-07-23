import { elevation } from '@app/design-tokens/native'
import type { ReactNode } from 'react'
import { View } from 'react-native'
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

// Elevation is the one thing in this package that cannot be a class.
//
// React Native has two unrelated shadow APIs — shadowColor/shadowOffset/shadowOpacity/
// shadowRadius on iOS, a single `elevation` depth on Android — and no Tailwind utility
// maps to both. The token package resolves the shared design INTENT into one
// ready-to-spread style object carrying all five keys, so the web's `shadow-raised`
// and this spread are two renderings of the same declaration rather than two people
// picking numbers that looked close.
//
// A shadow rather than a lighter background, for the same reason as on the web: a card
// that reads as raised BY BRIGHTNESS inverts in dark mode, where nearer is lighter but
// further away is darker.
//
// A plain View, never a semantic wrapper: on this platform "semantic" means an
// accessibility role, and a generic container that silently claims one pollutes the
// accessibility tree of every screen that used it for layout.
export function Card({ children, padding, elevated = false, className, testID }: CardProps) {
  return (
    <View
      testID={testID}
      style={elevated ? elevation.raised : undefined}
      className={cn(cardVariants({ padding, elevated }), className)}
    >
      {children}
    </View>
  )
}
