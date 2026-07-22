import { type Note, NotesPage } from '@app/contracts'
import { FlatList, RefreshControl, View } from 'react-native'
import { AppText } from '../../components/AppText'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { EmptyState } from '../../components/EmptyState'
import { Skeleton } from '../../components/Skeleton'
import { useToast } from '../../components/Toast'
import { formatRelativeTime, useI18n } from '../../i18n'
import { apiFetch } from '../../lib/api-client'
import { ROUTES } from '../../routes'
import { type Palette, usePalette, useThemedStyles } from '../../theme/theme'
import { radius, spacing } from '../../theme/tokens.gen'
import { NoteComposer } from './NoteComposer'
import { type ComposerRow, useCreateNote } from './useCreateNote'
import { type ListFetcher, type ListQueryState, useListQuery } from './useListQuery'

// The home screen's data panel — the reference implementation of the three
// canonical data states every route declares in src/routes.ts, expressed
// through the shared primitives: a quiet loading line, EmptyState (empty), and
// a retry Button (error). The loading/empty/error surfaces each render the
// manifest's testID, and the error surface carries a working retry affordance.
// The states sweep drives all three through the mock server. The panel is also
// the WRITE exemplar: NoteComposer + useCreateNote insert an optimistic pending
// row at the head of this list and reconcile or roll it back.
// SOURCE: harness doctrine — degraded/empty/loading states are a first-class
// UI concern, never a blank panel [corpus: harness/doctrine]

// Zod parse at the fetch boundary — the client trusts contracts, not wire
// bytes. Keyset pagination: this panel renders the FIRST page; the matrix
// screen (features/matrix/useKeysetQuery) shows the paged variant. apiFetch
// carries the bearer token and throws the envelope's own message; useListQuery
// runs every failure through translateError(), so a signed-out session reads
// the same (translated) way here, in the matrix, and in a toast. One mapping,
// not one per call site.
const fetchNotes: ListFetcher<Note> = async (signal) => {
  const response = await apiFetch('/api/notes', { signal })
  return NotesPage.parse(await response.json()).items
}

// The scaffold's home screen; its manifest entry carries the state test ids.
const [HOME] = ROUTES

const panelStyles = (palette: Palette) => ({
  root: {
    flex: 1,
    gap: spacing * 3,
  },
  header: {
    alignItems: 'center' as const,
    flexDirection: 'row' as const,
    justifyContent: 'space-between' as const,
  },
  list: {
    gap: spacing * 2,
  },
  row: {
    backgroundColor: palette.canvas,
    borderColor: palette.edge,
    borderRadius: radius.sm,
    borderWidth: 1,
    gap: spacing,
    paddingHorizontal: spacing * 3,
    paddingVertical: spacing * 2,
  },
  // Pending rows keep full-contrast tokens (ink-muted stays >= 4.5:1 in both
  // themes) — the provisional look is the dashed edge + muted ink, never an
  // opacity fade that could dip under AA mid-flight.
  rowPending: {
    borderStyle: 'dashed' as const,
  },
})

function NoteRowItem({ row }: { readonly row: ComposerRow }) {
  const { t } = useI18n()
  const styles = useThemedStyles(panelStyles)
  return (
    // The card is STYLED (border/background), so Fabric never flattens it away —
    // but the testID rides it only because it is also the row's ACCESSIBLE
    // element: pending state is part of the accessible name, so assistive tech
    // hears what sighted users see in the dashed border (leaf-testID discipline,
    // design record: CI-LANE-FACTS).
    // eslint-disable-next-line react-native-a11y/has-accessibility-hint -- a static note card: the label (title + pending state) IS the whole content; no interaction outcome exists for a hint
    <View
      style={[styles.row, row.pending && styles.rowPending]}
      testID={row.pending ? 'note-row-pending' : 'note-row'}
      accessible
      accessibilityLabel={row.pending ? t('notes.row.pending', { title: row.title }) : row.title}
    >
      {/* The title is its OWN element, not a bare text node beside the
          timestamp — gluing them into one text run is how "Note 1Created 3
          minutes ago" happens to every exact-text assertion and every screen
          reader reading the row as one run. */}
      <AppText variant={row.pending ? 'muted' : 'body'}>{row.title}</AppText>
      {/* The creation time, phrased the way the locale phrases it ("3 minutes
          ago", "hace 3 minutos", "منذ ٣ دقائق") — Intl.RelativeTimeFormat, not a
          hand-rolled "N ago" that would be English grammar wearing a
          translation. A pending row has no timestamp yet (the server assigns
          it), so it shows none rather than a guess that will change. */}
      {row.createdAt !== null && (
        <AppText variant="muted">
          {t('notes.createdAt', { when: formatRelativeTime(row.createdAt) })}
        </AppText>
      )}
    </View>
  )
}

function NotesBody({
  state,
  onRetry,
  overlay,
}: {
  readonly state: ListQueryState<Note>
  readonly onRetry: () => void
  /** Optimistic rows from useCreateNote, rendered ahead of the fetched page. */
  readonly overlay: readonly ComposerRow[]
}) {
  const { t } = useI18n()
  const styles = useThemedStyles(panelStyles)
  const palette = usePalette()
  if (state.status === 'loading') {
    // Skeleton, not prose: the placeholder mirrors the note rows about to paint
    // (no layout shift on arrival) and announces itself as a progressbar. The
    // state testID rides its accessible container — Fabric keeps accessible
    // elements intact (design record: CI-LANE-FACTS).
    return <Skeleton testID={HOME.states.loading} />
  }
  if (state.status === 'error') {
    return (
      // The error testID must sit on a surface that CONTAINS the retry button
      // (src/routes.ts contract), so it rides the Card — danger tone: the
      // failure surface must not be the same box as the empty state, and the
      // Card is styled, so Fabric keeps it (design record: CI-LANE-FACTS).
      <Card tone="danger" testID={HOME.states.error}>
        {/* THREE registers, and the distinction is the point.
              1. WHAT failed — catalog copy, always the same sentence for this surface.
              2. WHY — also catalog copy, but SELECTED BY THE ENVELOPE'S `code`:
                 "You are not signed in." reads very differently from "Something
                 went wrong on the server.", and the client can only say either
                 because the server's error contract carries a stable code.
              3. The raw failure text — an envelope message, a TypeError, an
                 offline socket. Untranslatable by nature (it is whatever the
                 failure said), so it stays quiet and muted, next to the request
                 id. It is kept, not hidden: it is what turns "it failed" into a
                 bug someone can trace. role=alert on the WHY line announces the
                 failure when it lands. */}
        <AppText variant="label">{t('notes.error.title')}</AppText>
        <AppText role="alert">{state.error.message}</AppText>
        {state.error.detail !== null && state.error.detail !== '' && (
          <AppText variant="muted">
            {state.error.detail}
            {state.error.requestId !== null &&
              ` — ${t('error.reference', { id: state.error.requestId })}`}
          </AppText>
        )}
        <Button variant="outline" label={t('common.retry')} onPress={onRetry} />
      </Card>
    )
  }
  const items = state.status === 'ready' ? state.items : []
  // A reconciled row can reappear in a reloaded page — the fetched row wins.
  const optimistic = overlay.filter((row) => !items.some((note) => note.id === row.id))
  if (state.status === 'empty' && optimistic.length === 0) {
    return (
      <EmptyState
        testID={HOME.states.empty}
        title={t('notes.empty.title')}
        description={t('notes.empty.description')}
        cta={{ label: t('common.reload'), onPress: onRetry }}
      />
    )
  }
  const rows: readonly ComposerRow[] = [
    ...optimistic,
    ...items.map((note) => ({
      id: note.id,
      title: note.title,
      pending: false,
      createdAt: note.createdAt,
    })),
  ]
  return (
    <FlatList
      data={rows}
      keyExtractor={(row) => row.id}
      renderItem={({ item }) => <NoteRowItem row={item} />}
      contentContainerStyle={styles.list}
      testID="notes-list"
      // A tap on a row should land while the composer's keyboard is up — not
      // spend itself dismissing the keyboard first.
      keyboardShouldPersistTaps="handled"
      // Pull-to-refresh re-runs the same reload as the header button; the body
      // swaps to the skeleton, which IS the refresh indicator, so the control's
      // own spinner never needs to persist (refreshing stays false).
      refreshControl={
        <RefreshControl
          refreshing={false}
          onRefresh={onRetry}
          tintColor={palette['ink-muted']}
          colors={[palette['ink-muted']]}
        />
      }
    />
  )
}

interface NotesPanelProps {
  /** Forwarded to the composer (deep-link/actions-modal focus). */
  readonly autoFocusComposer?: boolean
}

export function NotesPanel({ autoFocusComposer = false }: NotesPanelProps) {
  const { state, reload } = useListQuery(fetchNotes)
  const { t } = useI18n()
  const styles = useThemedStyles(panelStyles)
  const toast = useToast()
  // Write failures surface as envelope-message toasts — same seam as the
  // matrix screen's failed loadMore.
  // 'error', not the default info tone: a failed write is the one message in
  // this app a user must not scroll past.
  const { state: createState, submit } = useCreateNote((message) => {
    toast.show(message, 'error')
  })

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <AppText variant="label">{t('notes.heading')}</AppText>
        <Button variant="outline" label={t('common.reload')} onPress={reload} />
      </View>
      {/* Composer above the list: the optimistic row lands at the list head,
          directly under the form that created it. */}
      <NoteComposer
        status={createState.status}
        fieldError={createState.fieldError}
        onSubmit={submit}
        autoFocus={autoFocusComposer}
      />
      <NotesBody state={state} onRetry={reload} overlay={createState.rows} />
    </View>
  )
}
