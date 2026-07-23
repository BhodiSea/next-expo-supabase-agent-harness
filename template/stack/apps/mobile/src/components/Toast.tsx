import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Animated, View } from 'react-native'
import { useI18n } from '../i18n'
import { haptic } from '../lib/haptics'
import { useEntrance } from '../lib/motion'
import { elevation, type Palette, radius, space, useThemedStyles } from '../theme/theme'
import { AppText } from './AppText'
import { Button } from './Button'
import { Icon } from './icons/Icon'

// SOURCE: WCAG 2.2 SC 4.1.3 Status Messages — a toast is a status message that
// must reach assistive tech without moving focus; the auto-dismiss delay holds
// each one on screen long enough to read before it clears.
// https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html
const TOAST_DISMISS_MS = 6000

/**
 * What the toast is TELLING you. Not decoration: a failed write and a confirmed one must
 * not render as the same pixels — tone drives the colour channel AND the announcement
 * urgency. The RN adaptation of the desktop original's live-region trio: there is no DOM
 * aria-live here, so show() ANNOUNCES the message through
 * AccessibilityInfo.announceForAccessibility (both platforms), and the rendered text
 * additionally carries accessibilityLiveRegion for Android's native live-region path.
 * SOURCE: WCAG 2.2 SC 1.4.1 Use of Color — colour is a redundant channel here, never the
 * only one: the message text carries the meaning on its own
 * https://www.w3.org/TR/WCAG22/#use-of-color
 */
export type ToastTone = 'info' | 'error' | 'success'

interface ToastItem {
  readonly id: number
  readonly message: string
  readonly tone: ToastTone
}

interface ToastApi {
  /** Defaults to 'info'. Pass 'error' for anything the user must not miss. */
  readonly show: (message: string, tone?: ToastTone) => void
}

const ToastContext = createContext<ToastApi | null>(null)

/** Access the toast queue. Throws outside a ToastProvider — a wiring bug, loud. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext)
  if (api === null) throw new Error('useToast must be called inside a ToastProvider')
  return api
}

// Body copy stays the full-contrast ink in every tone — the status hue rides the
// BORDER, so colour is added without demoting the text a user actually has to read.
const toastStyles = (palette: Palette) => ({
  // The stack overlays the screen bottom; pointerEvents box-none on the wrapper
  // keeps the screen behind it interactive.
  stack: {
    bottom: 0,
    gap: space[2],
    left: 0,
    padding: space[4],
    position: 'absolute' as const,
    right: 0,
  },
  // A toast floats OVER the screen — the overlay elevation level is what
  // separates it from the surface it interrupts (the border alone reads as
  // just another card in dark themes).
  toast: {
    ...elevation.overlay,
    alignItems: 'center' as const,
    backgroundColor: palette.surface,
    borderColor: palette.edge,
    borderLeftWidth: space[1],
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: 'row' as const,
    gap: space[3],
    paddingHorizontal: space[3],
    paddingVertical: space[2],
  },
  error: {
    borderColor: palette.danger,
  },
  success: {
    borderColor: palette.success,
  },
  message: {
    flex: 1,
  },
})

// One card per queued toast, split out so the entrance hook runs per-toast: each
// card fades in while sliding up through the motion seam (reduce-motion renders
// it at rest on frame one). The ANNOUNCEMENT never rides this animation — show()
// announces synchronously, before any frame is painted.
// The tone's glyph doubles the border's colour channel — never replaces the
// text (decorative by Icon's construction; the message carries the meaning).
const TONE_ICON = {
  info: { name: 'info', tone: 'ink-muted' },
  error: { name: 'alertTriangle', tone: 'danger' },
  success: { name: 'checkCircle', tone: 'success' },
} as const

function ToastCard({
  toast,
  onDismiss,
}: {
  readonly toast: ToastItem
  readonly onDismiss: (id: number) => void
}) {
  const { t } = useI18n()
  const styles = useThemedStyles(toastStyles)
  const entrance = useEntrance()
  return (
    <Animated.View
      style={[
        styles.toast,
        toast.tone === 'error' && styles.error,
        toast.tone === 'success' && styles.success,
        entrance,
      ]}
    >
      <Icon
        name={TONE_ICON[toast.tone].name}
        tone={TONE_ICON[toast.tone].tone}
        size="sm"
        testID={`toast-icon-${toast.tone}`}
      />
      <AppText
        testID={`toast-${toast.tone}`}
        // Android's native live region announces the appearance; an error
        // interrupts (assertive) — "your write was lost" must not queue
        // politely behind chrome chatter. iOS parity is the explicit
        // announceForAccessibility call in show().
        accessibilityLiveRegion={toast.tone === 'error' ? 'assertive' : 'polite'}
        style={styles.message}
      >
        {toast.message}
      </AppText>
      <Button
        variant="ghost"
        label={t('common.dismiss')}
        testID={`toast-dismiss-${String(toast.id)}`}
        onPress={() => {
          onDismiss(toast.id)
        }}
      />
    </Animated.View>
  )
}

// Provider + queue + the rendered stack, all in ONE module so the surface stays a
// single self-contained unit (the desktop original's shape, minus the DOM live
// region — announceForAccessibility is the cross-platform announcement channel).
export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const styles = useThemedStyles(toastStyles)
  const [toasts, setToasts] = useState<readonly ToastItem[]>([])
  const nextId = useRef(0)
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())

  const dismiss = (id: number): void => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }

  const show = (message: string, tone: ToastTone = 'info'): void => {
    nextId.current += 1
    const id = nextId.current
    setToasts((current) => [...current, { id, message, tone }])
    // Status tones get a tactile channel too — warning for a failed write,
    // success for a landed one (the haptics seam is fail-silent by design).
    if (tone === 'error') haptic('warning')
    if (tone === 'success') haptic('success')
    // The ANNOUNCEMENT is the accessibility contract: a toast appears outside
    // the focus path, so without this a screen-reader user simply never learns
    // their write failed. Fail-silent under a mocked native layer (jest).
    try {
      AccessibilityInfo.announceForAccessibility(message)
    } catch {
      // A host without the a11y bridge still renders the visible toast.
    }
    const timer = setTimeout(() => {
      timers.current.delete(timer)
      dismiss(id)
    }, TOAST_DISMISS_MS)
    timers.current.add(timer)
  }

  // Clear any in-flight auto-dismiss timers on unmount so a late fire can never
  // setState on a torn-down tree.
  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending) clearTimeout(timer)
      pending.clear()
    }
  }, [])

  // A fresh object per render, like the desktop original — the React Compiler
  // memoizes it, and the queue lives in state either way.
  const api: ToastApi = { show }

  return (
    <ToastContext.Provider value={api}>
      {children}
      <View pointerEvents="box-none" style={styles.stack}>
        {toasts.map((toast) => (
          // The card is STYLED (border/background/padding), so Fabric never
          // flattens it — but the testID still rides the message Text (an
          // accessible LEAF), per the leaf-testID rule (design record: CI-LANE-FACTS).
          <ToastCard key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </View>
    </ToastContext.Provider>
  )
}
