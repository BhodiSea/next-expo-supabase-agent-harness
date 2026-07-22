import { Component, type ReactNode } from 'react'
import { View } from 'react-native'
import { t } from '../i18n'
import { log } from '../lib/log'
import { type Palette, useThemedStyles } from '../theme/theme'
import { spacing, typeScale } from '../theme/tokens.gen'
import { AppText } from './AppText'
import { Button } from './Button'

interface ErrorBoundaryProps {
  readonly children: ReactNode
}

interface ErrorBoundaryState {
  readonly error: Error | null
}

// Without a boundary, ANY render exception unmounts the tree and ships as an
// invisible blank-screen ticket. The fallback names the error, offers a reset,
// and stays inside the design tokens so even the failure state looks
// intentional. Class component: error boundaries have no hook equivalent.
//
// i18n: this is a CLASS, so useI18n() — a hook — cannot be called in render. It
// imports the PLAIN `t`, which reads the module-level active locale. That the
// i18n store is NOT a React context is exactly what makes this work: the one
// component that can never hold a hook is also the one that must never fail to
// render its own copy. Trade-off: a locale switch does not re-render a tripped
// boundary (no subscription), which is harmless — the boundary is terminal and
// the next thing a user does here is reset it.
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  override state: ErrorBoundaryState = { error: null }

  override componentDidCatch(error: Error): void {
    // Through the log seam, so the crash-reporting module (opt-in, later
    // workstream) sees every boundary trip the moment it patches the sink.
    log.error('ErrorBoundary caught render error', error)
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <Fallback
          message={this.state.error.message}
          onReset={() => {
            // No page to reload on this host: resetting the boundary re-renders
            // the children — a transient failure recovers, a deterministic one
            // trips again immediately (equally honest).
            this.setState({ error: null })
          }}
        />
      )
    }
    return this.props.children
  }
}

const fallbackStyles = (palette: Palette) => ({
  root: {
    alignItems: 'center' as const,
    backgroundColor: palette.canvas,
    flex: 1,
    gap: spacing * 3,
    justifyContent: 'center' as const,
    padding: spacing * 8,
  },
  // The heading takes the danger token: this is the one screen where the app
  // has FAILED — it must not render in the same ink as ordinary chrome.
  heading: {
    color: palette.danger,
    fontSize: typeScale.base.fontSize,
    lineHeight: typeScale.base.lineHeight,
    fontWeight: '600' as const,
  },
})

interface FallbackProps {
  readonly message: string
  readonly onReset: () => void
}

// A function component so the tokens-only styling can use the theme hook —
// the class above holds only the boundary mechanics.
function Fallback({ message, onReset }: FallbackProps) {
  const styles = useThemedStyles(fallbackStyles)
  return (
    <View role="alert" style={styles.root}>
      <AppText style={styles.heading}>{t('error.title')}</AppText>
      <AppText variant="muted">{t('error.body')}</AppText>
      {/* The raw Error.message is DEVELOPER copy, not user copy: never in the
          catalog, never translatable. It still ships — dropping it would cost
          the one detail that makes a report actionable — but demoted to a
          technical footnote under the translated copy above. Guarded on
          non-empty so a message-less throw renders no empty line. */}
      {message !== '' && <AppText variant="muted">{message}</AppText>}
      <Button label={t('common.reload')} onPress={onReset} />
    </View>
  )
}
