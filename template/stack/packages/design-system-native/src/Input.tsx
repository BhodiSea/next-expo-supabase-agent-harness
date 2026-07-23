import { TextInput } from 'react-native'
import { cn } from './cn'
import { useFieldContext } from './field-context'
import { useTheme } from './ThemeProvider'
import { inputVariants } from './variants'

/**
 * The keyboard/entry hint. A platform-neutral vocabulary on purpose: the web maps it to
 * `inputMode` and native to `keyboardType`, and neither platform's own enum is a subset
 * of the other's.
 */
export type InputKeyboard = 'text' | 'email' | 'number' | 'tel' | 'url'

export interface InputProps {
  readonly value: string
  /** `onChangeText`, not `onChange`: the callback takes the VALUE, never an event. */
  readonly onChangeText: (next: string) => void
  readonly placeholder?: string
  readonly disabled?: boolean
  readonly invalid?: boolean
  /** Masked entry. Native sets secureTextEntry; web renders type=password. */
  readonly secure?: boolean
  readonly keyboard?: InputKeyboard
  /** Required only when the input stands OUTSIDE a Field — a Field supplies it. */
  readonly accessibilityLabel?: string
  readonly className?: string
  readonly testID?: string
}

// 'email-address' and 'numeric', not 'default' everywhere: the keyboard is the single
// biggest determinant of how painful a form is on a phone, and it is also the one
// property nobody notices missing in a simulator with a hardware keyboard attached.
const KEYBOARD_TYPE: Record<InputKeyboard, 'default' | 'email-address' | 'numeric' | 'phone-pad' | 'url'> =
  {
    text: 'default',
    email: 'email-address',
    number: 'numeric',
    tel: 'phone-pad',
    url: 'url',
  }

// A CONTROLLED input with no internal state. An uncontrolled fallback would work in a
// story and drop keystrokes the first time a parent re-rendered during an async submit.
export function Input({
  value,
  onChangeText,
  placeholder,
  disabled = false,
  invalid = false,
  secure = false,
  keyboard = 'text',
  accessibilityLabel,
  className,
  testID,
}: InputProps) {
  // Inside a Field, the label and the invalid flag come from the wrapper — so the
  // visible label, the error text and the accessible name are the same strings by
  // construction rather than by everyone remembering to pass them.
  const field = useFieldContext()
  const { palette } = useTheme()
  const invalidState = field?.invalid ?? invalid

  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      // A theme token, not the platform default grey: RN's default placeholder colour
      // is a fixed light grey that vanishes on a light canvas and on a dark one.
      placeholderTextColor={palette['ink-muted']}
      editable={!disabled}
      secureTextEntry={secure}
      keyboardType={KEYBOARD_TYPE[keyboard]}
      // The RED BORDER is what most people see; the invalid flag is what the rest
      // hear. Shipping one without the other is the usual way an error state reaches
      // production half-built.
      //
      // `aria-invalid`, NOT `accessibilityInvalid` and NOT `accessibilityState.invalid`
      // — neither of those exists in React Native. `accessibilityState` accepts only
      // {disabled, selected, checked, busy, expanded}, so an `invalid` key there is
      // silently DROPPED rather than rejected: the border turns red, the screen reader
      // says nothing, and the omission is invisible in review. RN forwards the ARIA
      // spelling to both platforms' accessibility trees.
      accessibilityLabel={field?.label ?? accessibilityLabel}
      accessibilityState={{ disabled }}
      aria-invalid={invalidState}
      testID={testID}
      className={cn(
        inputVariants({ invalid: invalidState }),
        disabled && 'opacity-50',
        className,
      )}
    />
  )
}
