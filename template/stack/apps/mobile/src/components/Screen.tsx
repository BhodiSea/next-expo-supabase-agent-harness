import type { ReactNode } from 'react'
import { KeyboardAvoidingView, Platform } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { type Palette, useThemedStyles } from '../theme/theme'
import { spacing } from '../theme/tokens.gen'

// The one screen container: safe-area handling + the canvas token + the base
// gutter, in one place. Every route's top-level surface renders through it so
// "a screen" always means the same thing to the theme, to the perf lane
// (paint area), and to Maestro selectors (the testID is the route surface).
// `keyboard` opts a screen into soft-keyboard avoidance — any screen carrying a
// text input sets it, so the rising keyboard lifts the form instead of covering
// it. iOS pads (the keyboard overlays the window there); Android's default
// resize behavior already reflows the viewport, so no behavior prop is set.
interface ScreenProps {
  readonly children: ReactNode
  /** Set on screens with text inputs — the keyboard must never cover the form. */
  readonly keyboard?: boolean
  readonly testID?: string
}

const screenStyles = (palette: Palette) => ({
  root: {
    backgroundColor: palette.canvas,
    flex: 1,
    gap: spacing * 3,
    padding: spacing * 4,
  },
  // The avoider replaces root as the children's flex container, so it carries
  // the same gap (root's gap then spaces a single child — a no-op).
  avoider: {
    flex: 1,
    gap: spacing * 3,
  },
})

export function Screen({ children, keyboard = false, testID }: ScreenProps) {
  const styles = useThemedStyles(screenStyles)
  return (
    <SafeAreaView testID={testID} style={styles.root}>
      {keyboard ? (
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.avoider}
        >
          {children}
        </KeyboardAvoidingView>
      ) : (
        children
      )}
    </SafeAreaView>
  )
}
