import * as Haptics from 'expo-haptics'

// The ONE haptics door (the motion-seam pattern): a closed
// three-word vocabulary instead of the engine's full surface, so tactile
// feedback stays consistent app-wide — selection for picking/activating,
// success/warning for write outcomes. Wired only into PressableScale (opt-in
// per control) and the Toast's status tones; a feature never calls the engine
// directly (lint one-door). Fire-and-forget and fail-silent by design: a host
// without a haptic engine (web preview, jest, many Android devices) simply
// stays quiet — haptics are a redundant channel, never load-bearing.
// SOURCE: expo-haptics selection/notification API surface
// https://docs.expo.dev/versions/v57.0.0/sdk/haptics/
export type HapticKind = 'selection' | 'success' | 'warning'

function invoke(kind: HapticKind): Promise<void> {
  if (kind === 'selection') return Haptics.selectionAsync()
  const type =
    kind === 'success'
      ? Haptics.NotificationFeedbackType.Success
      : Haptics.NotificationFeedbackType.Warning
  return Haptics.notificationAsync(type)
}

export function haptic(kind: HapticKind): void {
  invoke(kind).catch(() => {
    // No haptic engine on this host — the visual channel already carries the meaning.
  })
}
