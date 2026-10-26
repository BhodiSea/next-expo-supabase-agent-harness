import { type ReactNode, useId, useMemo } from 'react'
import { View } from 'react-native'
import { cn } from './cn'
import { FieldContextProvider } from './field-context'
import { Text } from './Text'

export interface FieldProps {
  /** The visible label AND the control's accessible name — one string, one truth. */
  readonly label: string
  /** Standing guidance ("we never share this"). Always present, never only on error. */
  readonly hint?: string
  /** The current validation failure. Presence is what puts the control in its error state. */
  readonly error?: string
  readonly required?: boolean
  readonly children: ReactNode
  readonly className?: string
  readonly testID?: string
}

// The label/hint/error wrapper, and the reason a form's markup stays
// `<Field label="Email"><Input …/></Field>` on both surfaces. It owns the label string and
// the invalid flag and hands them to the control through context, so the wiring that makes a
// screen reader announce "Email, invalid" cannot be forgotten at a call site.
//
// What it does NOT own here is ids. The web twin computes `hintId`/`errorId` and points the
// control at them with aria-describedby; this platform associates a description with a
// control through props ON the control, not through an id reference, so `describedBy` stays
// `undefined` (field-context.ts calls that out as WEB-ONLY IN EFFECT). `controlId` is still a
// real, stable useId value — the context shape is kept congruent on both sides so a shared
// form helper never has to branch on platform, and the day a native control does want a
// stable identity it is already there rather than being invented per screen.
//
// No `flex-col` on the container and no Radix Label to mirror: RN's default axis IS column,
// and the whole reason the web reaches for Radix's Label (the native <label> re-fires clicks
// onto its control, so double-click-to-select toggles a checkbox) describes a DOM behaviour
// that does not exist here. Naming either would be noise pretending to be parity.
export function Field({
  label,
  hint,
  error,
  required = false,
  children,
  className,
  testID,
}: FieldProps) {
  const controlId = useId()
  const invalid = error !== undefined

  // Memoised for the same reason as on the web: a fresh object every render re-renders every
  // control inside the Field, and a Field wraps exactly the component that is being typed in.
  const context = useMemo(
    () => ({ controlId, describedBy: undefined, invalid, label }),
    [controlId, invalid, label],
  )

  return (
    <View testID={testID} className={cn('gap-1.5', className)}>
      {/* flex-row, because the asterisk is a SIBLING here rather than a <span> inside the
          label. It cannot be nested: nested Text is one accessibility element on iOS, so a
          decorative character inside the label would be read out as part of the field's
          name — the thing the web's aria-hidden exists to prevent. */}
      <View className="flex-row items-center">
        <Text size="sm" weight="medium">
          {label}
        </Text>
        {required ? (
          // The asterisk is DECORATIVE. Hiding it takes two props because the platforms
          // disagree on the spelling: accessibilityElementsHidden is the iOS switch,
          // importantForAccessibility="no-hide-descendants" is the Android one, and shipping
          // one of them announces "Email star" to half the users it was hidden for. The real
          // required signal is the control's own state, never this glyph.
          // SOURCE: React Native — accessibilityElementsHidden is iOS-only and
          // importantForAccessibility is Android-only
          // https://reactnative.dev/docs/accessibility#accessibilityelementshidden-ios
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {/* The leading space lives INSIDE the string, exactly as on the web, so both
                surfaces put the same character sequence on screen rather than one spacing
                token here and a text node there. */}
            <Text size="sm" weight="medium" tone="danger">
              {' *'}
            </Text>
          </View>
        ) : null}
      </View>
      <FieldContextProvider value={context}>{children}</FieldContextProvider>
      {/* Hint and error ARE <Text> here, where the web twin had to drop to raw <p> tags. The
          reason it could not use its own Text component — the DOM id those two elements have
          to carry — is the one thing that does not exist on this platform, so the native side
          gets to keep every string inside the type ramp. */}
      {hint === undefined ? null : (
        <Text size="sm" tone="muted">
          {hint}
        </Text>
      )}
      {error === undefined ? null : (
        // The twin of the web's role="alert": a validation failure that appears AFTER the
        // user has left the field must still be announced, or the message is silent for
        // exactly the people who cannot see the red border. assertive, not polite, because
        // role="alert" IS an assertive live region — matching it keeps the two surfaces
        // announcing in the same order rather than "the same words, eventually".
        //
        // This is acted on by Android only; iOS has no declarative live region and would
        // need an imperative announcement, which a design-system primitive must not fire —
        // it would double-speak on every screen whose submit handler already announces the
        // failure. That call belongs to the form, which knows how many fields just failed.
        // SOURCE: WAI-ARIA — role="alert" is a live region with aria-live="assertive"
        // https://www.w3.org/TR/wai-aria-1.2/#alert
        // SOURCE: React Native accessibilityLiveRegion is Android-only
        // https://reactnative.dev/docs/accessibility#accessibilityliveregion-android
        <View accessibilityRole="alert" accessibilityLiveRegion="assertive">
          <Text size="sm" tone="danger">
            {error}
          </Text>
        </View>
      )}
    </View>
  )
}
