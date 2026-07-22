import { HealthResponse } from '@app/contracts'
import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { AppText } from '../../components/AppText'
import { useI18n } from '../../i18n'
import { apiFetch } from '../../lib/api-client'
import { type Palette, useThemedStyles } from '../../theme/theme'
import { spacing } from '../../theme/tokens.gen'

// SOURCE: harness doctrine — degraded-network states are a first-class UI
// concern; probe cadence is slow enough to stay invisible in server logs and
// the per-probe timeout keeps a dead API from wedging the indicator
// [corpus: harness/doctrine]
const POLL_INTERVAL_MS = 10_000
const PROBE_TIMEOUT_MS = 3_000

// PORT NOTE: the desktop original exposed a window event so the command palette
// could force a probe. This host has no window event bus and no palette-driven
// probe command — the indicator owns its loop outright; a future contribution
// seam would inject a callback prop, not a global event.

// Three states, not two: rendering "unreachable — retrying" before the FIRST
// probe resolves is a lie that trains users to distrust the indicator.
type ProbeState =
  | { readonly status: 'connecting' }
  | { readonly status: 'ok'; readonly version: string }
  | { readonly status: 'degraded' }

const statusStyles = (palette: Palette) => ({
  root: {
    alignItems: 'center' as const,
    flexDirection: 'row' as const,
    gap: spacing * 2,
  },
  // The dot is decorative — the text beside it carries the meaning; colour is
  // the redundant channel (WCAG 1.4.1). Degraded takes the danger token,
  // connected takes success: at a glance a dead API must not be
  // indistinguishable from one still connecting.
  dot: {
    borderRadius: spacing,
    height: spacing * 2,
    width: spacing * 2,
  },
  dotOk: {
    backgroundColor: palette.success,
  },
  dotConnecting: {
    backgroundColor: 'transparent',
    borderColor: palette['ink-muted'],
    borderWidth: 1,
  },
  dotDegraded: {
    backgroundColor: palette.danger,
  },
})

export function ConnectionStatus() {
  const { t } = useI18n()
  const styles = useThemedStyles(statusStyles)
  const [state, setState] = useState<ProbeState>({ status: 'connecting' })

  useEffect(() => {
    let cancelled = false
    const probe = async (): Promise<void> => {
      // Hand-rolled timeout: AbortSignal.timeout is not a guaranteed global on
      // this host's JS engine, and a dangling timer per probe would be a leak.
      const controller = new AbortController()
      const timeout = setTimeout(() => {
        controller.abort()
      }, PROBE_TIMEOUT_MS)
      try {
        // The liveness probe is the ONE unauthenticated call: it must report a
        // reachable-but-signed-out server as connected, not degraded.
        const response = await apiFetch('/healthz', { auth: false, signal: controller.signal })
        const body: unknown = await response.json()
        // HealthResponse pins `ok: literal(true)` — a degraded body fails the
        // parse and lands in the catch below.
        const health = HealthResponse.parse(body)
        if (!cancelled) setState({ status: 'ok', version: health.version })
      } catch {
        if (!cancelled) setState({ status: 'degraded' })
      } finally {
        clearTimeout(timeout)
      }
    }
    void probe()
    const timer = setInterval(() => {
      void probe()
    }, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  return (
    <View style={styles.root}>
      <View
        accessible={false}
        style={[
          styles.dot,
          state.status === 'ok' && styles.dotOk,
          state.status === 'connecting' && styles.dotConnecting,
          state.status === 'degraded' && styles.dotDegraded,
        ]}
      />
      {/* role=status: announced politely on change without stealing focus. The
          version rides in as an interpolation param rather than a JSX sibling: a
          locale is free to move it ("v{version} — API connected"), which a
          hardcoded suffix would forbid. testID on the Text LEAF (CI-LANE-FACTS). */}
      <AppText
        variant={state.status === 'ok' ? 'body' : 'muted'}
        role="status"
        testID="connection-status"
      >
        {state.status === 'ok'
          ? t('connection.connected', { version: state.version })
          : state.status === 'connecting'
            ? t('connection.connecting')
            : t('connection.unreachable')}
      </AppText>
    </View>
  )
}
