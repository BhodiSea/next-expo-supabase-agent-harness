import { useEffect, useState } from 'react'
import { AccessibilityInfo, Animated, Easing } from 'react-native'
import { motion, spacing } from '../theme/tokens.gen'

// The ONE motion seam. Every animation in the app is built from these hooks over
// the manifest's motion tokens (tokens.gen.ts `motion`), the same one-door shape
// as api-client/host: raw `Animated`/`Easing` outside this module and the
// components home is a styleguide red, so motion vocabulary and reduce-motion
// behavior cannot fork per call site. Native-driver-only by construction — every
// helper animates opacity/transform, the two properties the native driver
// whitelists, so animations run on the UI thread and never contend with JS work.
// SOURCE: react-native Animated useNativeDriver supports only non-layout
// properties (transform/opacity) https://reactnative.dev/docs/animations#using-the-native-driver
//
// Reduce-motion is a BUILT-IN collapse, not a per-caller courtesy: when the OS
// signal is on, entrances render at their end state and the pulse holds static —
// callers cannot forget it because they never branch on it themselves.
// SOURCE: WCAG 2.2 SC 2.3.3 Animation from Interactions — motion triggered by
// interaction must be disableable https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html

const easingOf = (name: keyof typeof motion.easing): ((value: number) => number) => {
  const [x1, y1, x2, y2] = motion.easing[name]
  return Easing.bezier(x1, y1, x2, y2)
}

// Module-internal on purpose (knip-strict: nothing outside the seam consumes it
// yet). The subscription pairs addEventListener → .remove() in the returned
// cleanup — the perf-budget leak scan's contract.
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    let mounted = true
    AccessibilityInfo.isReduceMotionEnabled().then(
      (value) => {
        if (mounted) setReduced(value)
      },
      () => {
        // A host without the a11y bridge (jest) keeps animations on.
      },
    )
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced)
    return () => {
      mounted = false
      subscription.remove()
    }
  }, [])
  return reduced
}

/**
 * Entrance choreography: fade in while sliding up from `offset`. Returns an
 * animated style fragment for an Animated.View. Under reduce-motion the view
 * renders at its end state on the first frame — no travel, no fade.
 */
export function useEntrance(offset: number = spacing * 2): {
  readonly opacity: Animated.Value
  readonly transform: readonly [{ readonly translateY: Animated.AnimatedInterpolation<number> }]
} {
  const reduced = useReducedMotion()
  // Lazy state, not useRef: the value must be created once AND read during
  // render (it IS the style), which the React Compiler forbids for refs.
  const [progress] = useState(() => new Animated.Value(0))
  useEffect(() => {
    if (reduced) {
      progress.setValue(1)
      return
    }
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: motion.duration.base,
      easing: easingOf('decelerate'),
      useNativeDriver: true,
    })
    animation.start()
    return () => {
      animation.stop()
    }
  }, [progress, reduced])
  return {
    opacity: progress,
    transform: [
      { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [offset, 0] }) },
    ],
  }
}

/**
 * Pressed-state scale for the PressableScale primitive: eases to the manifest's
 * pressScale on press-in, back to rest on release. Under reduce-motion the
 * value snaps instantly — state feedback without travel.
 */
export function usePressScale(): {
  readonly scale: Animated.Value
  readonly pressIn: () => void
  readonly pressOut: () => void
} {
  const reduced = useReducedMotion()
  const [scale] = useState(() => new Animated.Value(1))
  const animateTo = (toValue: number): void => {
    if (reduced) {
      scale.setValue(toValue)
      return
    }
    Animated.timing(scale, {
      toValue,
      duration: motion.duration.fast,
      easing: easingOf('standard'),
      useNativeDriver: true,
    }).start()
  }
  return {
    scale,
    pressIn: () => {
      animateTo(motion.pressScale)
    },
    pressOut: () => {
      animateTo(1)
    },
  }
}

// The pulse floor: skeletons breathe between full and this opacity — deep enough
// to read as activity, shallow enough that the placeholder never strobes.
const PULSE_MIN_OPACITY = 0.55

/**
 * Skeleton pulse: opacity breathing on a slow loop. Returns the Animated.Value
 * to bind as `opacity`. Under reduce-motion the value holds at the floor — a
 * static placeholder block, visibly "not content" without any motion.
 */
export function usePulse(): Animated.Value {
  const reduced = useReducedMotion()
  const [opacity] = useState(() => new Animated.Value(1))
  useEffect(() => {
    if (reduced) {
      opacity.setValue(PULSE_MIN_OPACITY)
      return
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: PULSE_MIN_OPACITY,
          duration: motion.duration.slow,
          easing: easingOf('standard'),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: motion.duration.slow,
          easing: easingOf('standard'),
          useNativeDriver: true,
        }),
      ]),
    )
    loop.start()
    return () => {
      loop.stop()
    }
  }, [opacity, reduced])
  return opacity
}
