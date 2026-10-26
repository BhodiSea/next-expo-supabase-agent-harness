import { ActivityIndicator, View } from 'react-native'
import { cn } from './cn'
import { useTheme } from './ThemeProvider'
import { spinnerVariants } from './variants'

export type SpinnerSize = 'sm' | 'md' | 'lg'

export interface SpinnerProps {
  readonly size?: SpinnerSize
  /** REQUIRED accessible name — "Loading", "Saving changes". There is no default. */
  readonly label: string
  readonly className?: string
  readonly testID?: string
}

// The platform's own indicator, not a hand-rolled rotating ring.
//
// ActivityIndicator is drawn by the OS, which means it already matches the platform's
// idea of "busy", already stops when the OS says to reduce motion, and costs no
// JavaScript-driven animation frame. A custom ring would have to re-implement all
// three, and would get the third one wrong first.
//
// The cost is that RN exposes exactly TWO intrinsic sizes ('small' and 'large'), so the
// three token sizes map onto them; the wrapper View carries the token dimension so
// layout still snaps to the icon scale. That is a platform limit, stated rather than
// papered over with a scale transform that would blur the indicator.
const RN_SIZE: Record<SpinnerSize, 'small' | 'large'> = {
  sm: 'small',
  md: 'small',
  lg: 'large',
}

// `label` is required, with no default, because a spinner is often the only thing on
// screen at the moment it matters: unlabelled, it announces nothing at all and the app
// simply goes quiet for a screen-reader user. Defaulting to "Loading" would be worse
// than requiring it — "Saving changes" is almost always the useful sentence.
export function Spinner({ size = 'md', label, className, testID }: SpinnerProps) {
  const { palette } = useTheme()
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      testID={testID}
      className={cn(spinnerVariants({ size }), className)}
    >
      <ActivityIndicator size={RN_SIZE[size]} color={palette.accent} />
    </View>
  )
}
