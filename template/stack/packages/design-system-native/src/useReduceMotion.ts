import { useEffect, useState } from 'react'
import { AccessibilityInfo } from 'react-native'

/**
 * Whether the OS is asking for reduced motion, tracked live.
 *
 * The web design system gets this for free from Tailwind's `motion-safe:` variant —
 * the media query is evaluated by the browser and the class simply stops applying.
 * React Native has no media queries, so the same guarantee has to be a hook, and every
 * animation in this package is gated on it.
 *
 * Read ONCE at mount and then subscribed, not read on every render: the initial read
 * is async (a bridge call), so a synchronous default is unavoidable, and `false` is the
 * right one — it means the first frame animates and then settles, rather than a
 * reduced-motion user seeing motion permanently because a promise had not resolved
 * before the component decided.
 *
 * The listener is what makes it correct after mount: the setting is changed in Settings
 * while the app is backgrounded, and an app that only read it at launch honours it
 * exactly until the next cold start.
 * SOURCE: WCAG 2.2 SC 2.3.3 Animation from Interactions — motion triggered by
 * interaction can be disabled unless essential [corpus: wcag/reduced-motion]
 * https://www.w3.org/TR/WCAG22/#animation-from-interactions
 */
export function useReduceMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false)

  useEffect(() => {
    let active = true
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      // The promise can settle after unmount; setting state then is a no-op React
      // warns about and, worse, hides the real subscription below in the noise.
      if (active) setReduceMotion(enabled)
    })
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion)
    return () => {
      active = false
      subscription.remove()
    }
  }, [])

  return reduceMotion
}
