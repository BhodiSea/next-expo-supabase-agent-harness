import { useState } from 'react'
import { View } from 'react-native'
import { Button } from '../../components/Button'
import { Field } from '../../components/Field'
import { Input } from '../../components/Input'
import { useI18n } from '../../i18n'
import { type Palette, space, useThemedStyles } from '../../theme/theme'
import type { CreateNoteStatus, SubmitOutcome } from './useCreateNote'

// The write form of the optimistic create-note slice — pure presentation over
// useCreateNote's state (NotesPanel owns the hook so the optimistic rows land
// in ITS list). Everything renders through primitives: Field wires the a11y
// contract, Input + Button carry the tokens. While the POST is in flight the
// submit affordance disables and relabels to t('notes.composer.pending') —
// "Adding…" in English, visible without any motion channel. The relabel is the
// accessible name, so it must stay catalog copy: a screen reader announces the
// pending state by reading it.
//
// Keyboard avoidance is the SCREEN's job (Screen's `keyboard` prop — the home
// route sets it), so the composer stays pure presentation.

interface NoteComposerProps {
  readonly status: CreateNoteStatus
  /** Inline contract-validation message, rendered through Field's error line. */
  readonly fieldError: string | null
  readonly onSubmit: (input: { readonly title: string }) => Promise<SubmitOutcome>
  /** Focus the title input on mount (the actions modal's "Create a note" lands here). */
  readonly autoFocus?: boolean
}

const composerStyles = (_palette: Palette) => ({
  row: {
    alignItems: 'flex-start' as const,
    flexDirection: 'row' as const,
    gap: space[2],
  },
  // Input's base style is width:'100%'; inside a row it must flex instead.
  inputSlot: {
    flex: 1,
  },
})

export function NoteComposer({
  status,
  fieldError,
  onSubmit,
  autoFocus = false,
}: NoteComposerProps) {
  const [title, setTitle] = useState('')
  const { t } = useI18n()
  const styles = useThemedStyles(composerStyles)
  const pending = status === 'pending'

  const submit = async (): Promise<void> => {
    const outcome = await onSubmit({ title })
    // Optimistic-UX contract: the draft clears only once the note reconciled;
    // a rollback keeps the text so the user retries without retyping.
    if (outcome === 'settled') setTitle('')
  }

  return (
    <Field label={t('notes.composer.label')} error={fieldError ?? undefined}>
      {(control) => (
        <View style={styles.row}>
          <View style={styles.inputSlot}>
            <Input
              value={title}
              onChangeText={setTitle}
              placeholder={t('notes.composer.placeholder')}
              editable={!pending}
              autoFocus={autoFocus}
              returnKeyType="done"
              onSubmitEditing={() => {
                void submit()
              }}
              accessibilityLabel={control.accessibilityLabel}
              accessibilityHint={control.accessibilityHint}
              invalid={control.invalid}
              testID="note-composer-input"
            />
          </View>
          <Button
            label={pending ? t('notes.composer.pending') : t('notes.composer.submit')}
            disabled={pending}
            onPress={() => {
              void submit()
            }}
            testID="note-composer-submit"
          />
        </View>
      )}
    </Field>
  )
}
