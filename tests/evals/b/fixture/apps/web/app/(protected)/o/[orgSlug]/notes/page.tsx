import { Card, EmptyState, Text } from '@app/design-system'
import type { ReactNode } from 'react'
import { loadNotesPage } from '../../../../../lib/app-data/notes'
import { t } from '../../../../../lib/i18n'
import { errorCopy } from '../../../../../lib/i18n/errors'
import { NoteComposer } from './note-composer'
import { meta } from './page.meta'

// One org's notes. The route segment IS the tenant selector — loadNotesPage resolves it
// against the caller's real seats and scopes the query to the RESOLVED org's id, never to
// the slug in the URL.
//
// The four render states come from notes-model.ts as a closed union, so "succeeded with zero
// rows" cannot silently render as a list. That is the whole reason the matching lives in a
// module instead of inside this JSX.

// Title from the route's OWN meta — the registry and the browser tab read one declaration.
export const metadata = { title: t(meta.titleKey) }

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
        <p role="alert" className="text-sm text-danger" data-testid={meta.states.error}>
          {errorCopy(model.error)}
        </p>
      )}

      {model.status === 'empty' && (
        <EmptyState
          title={t('notes.empty.title')}
          description={t('notes.empty.description')}
          testID={meta.states.empty}
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
