import { cn } from './cn'
import { useFieldContext } from './field-context'
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
  /** Masked entry. Web renders type=password; native sets secureTextEntry. */
  readonly secure?: boolean
  readonly keyboard?: InputKeyboard
  /** Required only when the input stands OUTSIDE a Field — a Field supplies it. */
  readonly accessibilityLabel?: string
  readonly className?: string
  readonly testID?: string
}

// inputMode, not type: `type="number"` brings a spinner, silently drops non-numeric
// input, and returns "" for anything the browser considers invalid — so a leading zero
// or a partially typed value disappears from state while the user is still typing.
// inputMode changes the on-screen keyboard and nothing else, which is the entire
// intent.
// SOURCE: inputmode selects a virtual keyboard without changing value parsing or
// validation, unlike input type
// https://developer.mozilla.org/en-US/docs/Web/HTML/Global_attributes/inputmode
const INPUT_MODE: Record<InputKeyboard, 'text' | 'email' | 'numeric' | 'tel' | 'url'> = {
  text: 'text',
  email: 'email',
  number: 'numeric',
  tel: 'tel',
  url: 'url',
}

// A CONTROLLED input with no internal state. An uncontrolled fallback would make the
// component work in a story and drop keystrokes the first time a parent re-rendered
// during an async submit.
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
  // Inside a Field, the label, the invalid flag and the described-by ids come from the
  // wrapper — so the visible label, the error text and the accessible name are all the
  // same strings by construction rather than by everyone remembering to pass them.
  const field = useFieldContext()
  const invalidState = field?.invalid ?? invalid

  return (
    <input
      id={field?.controlId}
      value={value}
      onChange={(event) => {
        onChangeText(event.target.value)
      }}
      placeholder={placeholder}
      disabled={disabled}
      type={secure ? 'password' : 'text'}
      inputMode={INPUT_MODE[keyboard]}
      // aria-invalid is what a screen reader announces; the red border is what everyone
      // else sees. Shipping one without the other is the most common way an error state
      // reaches production half-built.
      aria-invalid={invalidState}
      aria-describedby={field?.describedBy}
      aria-label={field === null ? accessibilityLabel : undefined}
      data-testid={testID}
      className={cn(inputVariants({ invalid: invalidState }), className)}
    />
  )
}
