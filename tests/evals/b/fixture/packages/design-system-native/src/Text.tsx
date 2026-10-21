import type { FontWeightName, TypeStep } from '@app/design-tokens'
import { fontScaleCap } from '@app/design-tokens/native'
import type { ReactNode } from 'react'
import { Text as RNText } from 'react-native'
import { cn } from './cn'
import { textVariants } from './variants'

/** The tone vocabulary — closed on purpose; a sixth colour is a token change. */
export type TextTone = 'default' | 'muted' | 'accent' | 'danger' | 'success'

/** NATIVE-ONLY: the two font-scaling roles. The web has browser zoom instead. */
export type TextScaleRole = 'default' | 'dense'

export interface TextProps {
  readonly children: ReactNode
  readonly size?: TypeStep
  readonly tone?: TextTone
  readonly weight?: FontWeightName
  /** NATIVE-ONLY: 'dense' caps OS text scaling for fixed-height rows. */
  readonly scaleRole?: TextScaleRole
  readonly className?: string
  readonly testID?: string
}

// Every string on a screen goes through here, and on this platform there is a second
// reason beyond the type ramp: React Native's Text does NOT inherit style from a parent
// View, so a raw <Text> inside a themed card renders in the platform default colour on
// a themed background. There is no cascade to fall back on.
//
// maxFontSizeMultiplier is always set. Left unset, RN honours OS text scaling without
// limit, which on the largest accessibility sizes turns a fixed-height list row into a
// row with invisible text rather than a taller row. `default` (2x) is generous; `dense`
// (1.3x) is for the rows whose height is fixed by a virtualised list.
export function Text({
  children,
  size,
  tone,
  weight,
  scaleRole = 'default',
  className,
  testID,
}: TextProps) {
  return (
    <RNText
      maxFontSizeMultiplier={fontScaleCap[scaleRole]}
      testID={testID}
      className={cn(textVariants({ size, tone, weight }), className)}
    >
      {children}
    </RNText>
  )
}
