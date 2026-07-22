import type { ReactNode } from 'react'
import { View } from 'react-native'
import { type Palette, useThemedStyles } from '../theme/theme'
import { spacing } from '../theme/tokens.gen'
import { AppText } from './AppText'

// The one form-field primitive: label + control slot + inline error line, with
// the a11y contract computed in exactly ONE place. The control is a render
// prop — Field hands the caller the computed props and the caller spreads them
// onto whatever control primitive it renders (Input today), so the wiring can
// never be forgotten and Field never clones or introspects children.
//
// The error carries THREE channels, none sufficient alone (the RN adaptation of
// the desktop original's aria-describedby/aria-invalid/danger trio):
//   - accessibilityHint on the control (screen readers announce it with focus),
//   - the visible line under role="alert" (announced when it appears),
//   - the danger token on text + the control's border (sighted users) —
// colour is the redundant channel; the text + hint carry the meaning.
// SOURCE: WCAG 2.2 SC 1.4.1 Use of Color https://www.w3.org/TR/WCAG22/#use-of-color

/** Props Field computes for its control — spread them onto the Input (or peer). */
interface FieldControlProps {
  readonly accessibilityLabel: string
  readonly accessibilityHint: string | undefined
  readonly invalid: boolean
}

interface FieldProps {
  readonly label: string
  /** Inline error message; undefined/empty renders no error line. */
  readonly error?: string | undefined
  /** Render prop receiving the computed control props. */
  readonly children: (control: FieldControlProps) => ReactNode
}

const fieldStyles = (_palette: Palette) => ({
  root: {
    gap: spacing,
    width: '100%' as const,
  },
})

export function Field({ label, error, children }: FieldProps) {
  const styles = useThemedStyles(fieldStyles)
  const hasError = error !== undefined && error !== ''
  return (
    <View style={styles.root}>
      <AppText variant="label">{label}</AppText>
      {children({
        accessibilityLabel: label,
        accessibilityHint: hasError ? error : undefined,
        invalid: hasError,
      })}
      {hasError && (
        <AppText variant="danger" role="alert">
          {error}
        </AppText>
      )}
    </View>
  )
}
