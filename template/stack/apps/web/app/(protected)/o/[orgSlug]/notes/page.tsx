import { Card, EmptyState, Text } from '@app/design-system'
import type { ReactNode } from 'react'
import { loadNotesPage } from '../../../../../lib/app-data/notes'
import { errorCopy } from '../../../../../lib/error-copy'
import { NoteComposer } from './note-composer'

// One org's notes. The route segment IS the tenant selector — loadNotesPage resolves it
// against the caller's real seats and scopes the query to the RESOLVED org's id, never to
// the slug in the URL.
//
// The four render states come from notes-model.ts as a closed union, so "succeeded with zero
// rows" cannot silently render as a list. That is the whole reason the matching lives in a
// module instead of inside this JSX.

export const metadata = { title: 'Notes' }

export default async function NotesPage({
  params,
}: {
  readonly params: Promise<{ readonly orgSlug: string }>
}): Promise<ReactNode> {
  const { orgSlug } = await params
  const model = await loadNotesPage(orgSlug)

  return (
    <section className="mt-6 flex flex-col gap-6">
      <NoteComposer orgSlug={orgSlug} />

      {model.status === 'error' && (
        <p role="alert" className="text-sm text-danger" data-testid="notes-error">
          {errorCopy(model.error)}
        </p>
      )}

      {model.status === 'empty' && (
        <EmptyState
          title="No notes yet"
          description="Anything you write here is visible to everyone in this organization."
          testID="notes-empty"
        />
      )}

      {model.status === 'ready' && (
        <ul className="flex flex-col gap-3" data-testid="notes-list">
          {model.notes.map((note) => (
            <li key={note.id}>
              <Card>
                <Text weight="medium">{note.title}</Text>
                {note.hasBody && (
                  <Text tone="muted" size="sm">
                    {note.excerpt}
                  </Text>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
