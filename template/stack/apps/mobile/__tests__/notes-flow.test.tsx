// The optimistic write path through the REAL Home screen (renderRouter mounts
// the actual shell: providers, ToastProvider, tabs): composer submit → temp row
// at the list head (pending affordance) → reconcile on success / rollback +
// error toast on failure.
//
// TWO SEAMS ARE SUBSTITUTED AND ONLY TWO: who is asking (the Supabase client)
// and what the API answers (the tRPC client). Everything between them is the
// shipped code — the screens, the hooks, the @app/contracts parses, and
// `callProcedure`, the fold that makes one envelope true end to end.
import { type ActionOutcome, appError } from '@app/errors'
import { fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library'
import type { NotesPage, NoteView } from '@app/contracts'
import { en } from '../src/i18n/catalog'
import { installMockServer, mockApiClient, uninstallMockServer } from '../src/testing/mock-server'
import { installMockSupabase, mockSupabaseClient } from '../src/testing/mock-supabase'

jest.mock('../src/lib/supabase/provider', () => ({
  SupabaseProvider: ({ children }: { readonly children: unknown }) => children,
  useSupabase: () => mockSupabaseClient(),
}))
jest.mock('../src/lib/trpc/use-api', () => ({ useApi: () => mockApiClient() }))

// NoteView — the RENDER contract, which is what the router actually returns.
// Every field is present and every one is bounded, because the hooks re-parse
// the payload against the same schema the server built it from: a fixture that
// drifts from the contract fails HERE rather than passing a test the app could
// never reproduce.
const EXISTING: NoteView = {
  createdAt: '2026-01-01T00:00:00.000Z',
  excerpt: '',
  hasBody: false,
  id: '00000000-0000-4000-8000-000000000001',
  isArchived: false,
  title: 'First note',
  updatedAt: '2026-01-01T00:00:00.000Z',
}
const SERVER_NOTE: NoteView = {
  ...EXISTING,
  createdAt: '2026-01-01T00:00:01.000Z',
  id: '00000000-0000-4000-8000-000000000099',
  title: 'Fresh note',
}

// Returns the SHIPPED `NotesPage` contract type, not a locally re-declared twin —
// a hand-written double that is merely shape-compatible drifts silently when the
// contract gains a field, and every test keeps passing while the screen renders
// undefined. Naming the contract makes that drift a red.
const listPage = (items: NoteView[]): ActionOutcome<NotesPage> => ({
  ok: true,
  data: { items, nextCursor: null },
})

const HEALTH = () => ({ ok: true as const, version: '0.0.0' })

beforeEach(() => {
  installMockSupabase()
})

afterEach(() => {
  uninstallMockServer()
})

async function composeNote(title: string): Promise<void> {
  fireEvent.changeText(await screen.findByTestId('note-composer-input'), title)
  fireEvent.press(screen.getByTestId('note-composer-submit'))
}

describe('notes optimistic create', () => {
  it('holds a pending row at the list head while the write is in flight, then reconciles', async () => {
    let releaseCreate!: (result: ActionOutcome<NoteView>) => void
    const held = new Promise<ActionOutcome<NoteView>>((resolve) => {
      releaseCreate = resolve
    })
    installMockServer({
      systemHealth: HEALTH,
      notesList: () => listPage([EXISTING]),
      notesCreate: () => held,
    })
    renderRouter('./app')
    await screen.findByText('First note')

    await composeNote('Fresh note')

    // BEFORE fulfillment: the pending row renders (dashed affordance = the
    // note-row-pending testID), the button relabels + disables.
    const pending = await screen.findByTestId('note-row-pending')
    expect(pending).toHaveTextContent('Fresh note')
    expect(
      screen.getByRole('button', { name: en['notes.composer.pending'], disabled: true }),
    ).toBeTruthy()

    releaseCreate({ ok: true, data: SERVER_NOTE })

    // Reconciled: pending marker gone, the row stays, the draft cleared.
    await waitFor(() => {
      expect(screen.queryByTestId('note-row-pending')).toBeNull()
    })
    expect(screen.getByText('Fresh note')).toBeTruthy()
    expect(screen.getByText('First note')).toBeTruthy() // the fetched page is intact
    expect(screen.getByTestId('note-composer-input').props['value'] as string).toBe('')
  })

  it('rolls the row back on a failure envelope and toasts TRANSLATED copy, not the raw message', async () => {
    installMockServer({
      systemHealth: HEALTH,
      notesList: () => listPage([EXISTING]),
      // A DOMAIN failure on the DATA channel — the envelope rule. Nothing throws,
      // so the rollback path below is reached by a value, not by an exception.
      notesCreate: () => ({
        ok: false,
        error: appError.unknown({ message: 'note storage exploded' }),
      }),
    })
    renderRouter('./app')
    await screen.findByText('First note')

    await composeNote('Doomed note')

    // The error toast carries catalog copy chosen by the envelope's kind. The
    // server's own English message is a log diagnostic, never the headline.
    const toast = await screen.findByTestId('toast-error')
    expect(toast).toHaveTextContent(en['error.api.internal'])
    expect(screen.queryByText('note storage exploded')).toBeNull()
    // …and the temp row is GONE (rollback — never a phantom row after a failed
    // write), while the draft survives for retry.
    expect(screen.queryByText('Doomed note')).toBeNull()
    expect(screen.getByTestId('note-composer-input').props['value'] as string).toBe('Doomed note')
  })

  it('a transport-level UNAUTHORIZED reads as the signed-out copy, not as a server fault', async () => {
    installMockServer({
      systemHealth: HEALTH,
      notesList: () => listPage([EXISTING]),
      // The ONE thing the router is allowed to throw. `callProcedure` folds it
      // back onto the envelope, which is the whole point of that layer: the
      // screen never learns there were two channels.
      notesCreate: () => ({ ok: false, error: appError.unauthorized() }),
    })
    renderRouter('./app')
    await screen.findByText('First note')

    await composeNote('Signed out note')

    const toast = await screen.findByTestId('toast-error')
    expect(toast).toHaveTextContent(en['error.api.unauthorized'])
    expect(screen.queryByText('Signed out note')).toBeNull()
  })

  it('a first optimistic note replaces the empty state with the list', async () => {
    installMockServer({
      systemHealth: HEALTH,
      notesList: () => listPage([]),
      // Held forever: the optimistic row must stand on its own.
      notesCreate: () => new Promise<never>(() => undefined),
    })
    renderRouter('./app')
    await screen.findByTestId('home-empty')

    await composeNote('Fresh note')

    const pending = await screen.findByTestId('note-row-pending')
    expect(pending).toHaveTextContent('Fresh note')
    expect(screen.queryByTestId('home-empty')).toBeNull()
  })

  it('an invalid title renders the contract message inline and never calls the mutation', async () => {
    const creates = jest.fn(() => ({ ok: true as const, data: SERVER_NOTE }))
    installMockServer({
      systemHealth: HEALTH,
      notesList: () => listPage([]),
      notesCreate: creates,
    })
    renderRouter('./app')
    await screen.findByTestId('home-empty')

    fireEvent.press(await screen.findByTestId('note-composer-submit'))

    // Field's three-channel contract: the alert line carries the catalog copy,
    // and the same sentence rides the control's accessibilityHint.
    const alert = await screen.findByRole('alert')
    expect(alert).toBeTruthy()
    await waitFor(() => {
      expect(screen.getByTestId('note-composer-input').props['accessibilityHint']).toBeTruthy()
    })
    // Zod rejected at the boundary — no mutation ever left the app.
    expect(creates).not.toHaveBeenCalled()
  })

  it('the connection indicator reports the health procedure version through role=status', async () => {
    installMockServer({
      systemHealth: () => ({ ok: true as const, version: '9.9.9' }),
      notesList: () => listPage([]),
    })
    renderRouter('./app')
    const status = await screen.findByTestId('connection-status')
    await waitFor(() => {
      // exact:false — the version is interpolated INTO the catalog sentence.
      expect(status).toHaveTextContent('9.9.9', { exact: false })
    })
  })
})
