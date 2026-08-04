'use client'

import { Button, Field, Input } from '@app/design-system'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { errorCopy } from '../../../../../lib/error-copy'
import { createNoteAction } from '../../../../actions/notes'

// The write surface. `orgSlug` is a PROP, bound from the route segment this composer was
// rendered under, and it travels to the Server Action as a bound argument — never inside the
// note payload. `CreateNoteSchema` has no org field and never will: a tenant a request can
// name in its body is a tenant the first careless handler will trust.
//
// What that buys concretely: this component cannot be reused to write into a different org
// by changing what the user types. To target another tenant you would have to render it under
// another route, which is a navigation the switcher makes explicit and the gate re-checks.

export function NoteComposer({ orgSlug }: { readonly orgSlug: string }): React.ReactNode {
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: React.SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const outcome = await createNoteAction(orgSlug, { title })
    setBusy(false)
    if (!outcome.ok) {
      // The envelope's own message. Screens switch on `code` when they need to branch; here
      // there is one control and one failure surface, so the message is the whole of it.
      setError(errorCopy(outcome.error))
      return
    }
    setTitle('')
    router.refresh()
  }

  return (
    <form
      onSubmit={(event) => {
        void submit(event)
      }}
      className="flex flex-col gap-3"
      noValidate
    >
      <Field label="New note">
        <Input value={title} onChangeText={setTitle} testID="note-composer-input" />
      </Field>
      {error !== null && (
        <p role="alert" className="text-sm text-danger" data-testid="note-composer-error">
          {error}
        </p>
      )}
      <Button
        label="Add note"
        type="submit"
        busy={busy}
        disabled={title.trim() === ''}
        testID="note-composer-submit"
      />
    </form>
  )
}
