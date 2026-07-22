# Motion — which token, which transition, always through the seam

Motion is tokens-as-data, exactly like color: durations/easings live in the
`motion` block of `tokens.gen.ts`, and every animation runs through
`src/lib/motion.ts` (the seam). The styleguide gate bans raw
`Animated`/`Easing`/`LayoutAnimation` references outside the seam + the
components home, and literal `duration:`/`delay:` values everywhere.

## Duration roles

- `motion.duration.fast` (120ms) — state feedback: press scale, toggles,
  anything that answers a finger. Longer feels laggy.
- `motion.duration.base` (200ms) — element entrances/exits: a toast arriving,
  a row appearing, content crossfading in.
- `motion.duration.slow` (320ms) — ambient motion only: the skeleton pulse.
  Nothing user-blocking ever runs this long.
- There is no "slower". If a transition seems to need more, the design is
  moving too much distance — shrink the change, not the clock.

## Easing roles

- **Enter** = `decelerate` (fast start, soft landing — things arrive).
- **Exit** = `accelerate` (soft start, fast leave — things depart).
- **State change in place** = `standard`.

## The seam's vocabulary (use these, don't reinvent)

- `useEntrance(offset?)` — fade + slide-up for anything appearing (the Toast
  card is the worked pattern). Returns the animated style fragment.
- `usePulse()` — the skeleton's opacity breathing.
- `usePressScale()` — pressed-state scale to `motion.pressScale` (0.97),
  already wired into PressableScale; you almost never call it directly.
- A genuinely new choreography = a new HOOK IN THE SEAM (with its
  reduce-motion collapse), never a raw `Animated.timing` at the call site —
  the seam is where the token vocabulary and the collapse live.

## Hard rules

- **transform + opacity only** — the native-driver whitelist. Never animate
  layout (width/height/padding) and never animate inside list rows.
- **Reduce-motion is not optional.** Every seam hook collapses to a static
  end state when the OS asks; a new hook must too, by construction — the
  caller never branches on it.
- **Haptics ride motion's moments,** through the one door
  (`src/lib/haptics.ts`): `selection` when the user picks something
  (OptionRow has it), `success`/`warning` when a write lands/fails (the Toast
  tones fire them). Nothing else — tactile noise cheapens the real signals.
- Navigation transitions belong to the navigator (expo-router/screens
  defaults) — do not re-animate screen changes in JS.
