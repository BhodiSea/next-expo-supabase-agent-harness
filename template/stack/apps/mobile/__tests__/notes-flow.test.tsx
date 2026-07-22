// The optimistic write path through the REAL Home screen (renderRouter mounts
// the actual shell: providers, ToastProvider, tabs): composer submit → temp row
// at the list head (pending affordance) → reconcile on 201 / rollback + error
// toast on failure. The host keychain is mocked at the seam; the network runs
// through the mock server, so the shipped api-client (origin, bearer, envelope
// decoding) is the code under test.
import { fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library'
import { en } from '../src/i18n/catalog'
import {
  installMockServer,
  type MockRouteHandler,
  uninstallMockServer,
} from '../src/testing/mock-server'

jest.mock('../src/host', () => {
  let token: string | null = 'jest-session-token'
  return {
    secureGetToken: jest.fn(() => Promise.resolve(token)),
    secureSetToken: jest.fn((next: string) => {
      token = next
      return Promise.resolve()
    }),
    secureDeleteToken: jest.fn(() => {
      token = null
      return Promise.resolve()
    }),
    secureGetRefreshToken: jest.fn(() => Promise.resolve(null)),
    secureSetRefreshToken: jest.fn(() => Promise.resolve()),
    secureDeleteRefreshToken: jest.fn(() => Promise.resolve()),
  }
})

const EXISTING = {
  id: '00000000-0000-4000-8000-000000000001',
  ownerId: '00000000-0000-4000-8000-0000000000aa',
  title: 'First note',
  body: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  embedding: null,
  sourceConfidence: null,
  sourceModel: null,
}
const SERVER_NOTE = {
  ...EXISTING,
  id: '00000000-0000-4000-8000-000000000099',
  title: 'Fresh note',
  createdAt: '2026-01-01T00:00:01.000Z',
}

const listPage = (items: readonly unknown[]) => ({
  status: 200,
  body: { items, nextCursor: null },
})
const HEALTH: MockRouteHandler = () => ({ status: 200, body: { ok: true, version: '0.0.0' } })

afterEach(() => {
  uninstallMockServer()
})

async function composeNote(title: string): Promise<void> {
  fireEvent.changeText(await screen.findByTestId('note-composer-input'), title)
  fireEvent.press(screen.getByTestId('note-composer-submit'))
}

describe('notes optimistic create', () => {
  it('holds a pending row at the list head while the POST is in flight, then reconciles', async () => {
    let releaseCreate!: (result: { status: number; body: unknown }) => void
    const held = new Promise<{ status: number; body: unknown }>((resolve) => {
      releaseCreate = resolve
    })
    installMockServer({
      'GET /healthz': HEALTH,
      'GET /api/notes': () => listPage([EXISTING]),
      'POST /api/notes': () => held,
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

    releaseCreate({ status: 201, body: SERVER_NOTE })

    // Reconciled: pending marker gone, the row stays, the draft cleared.
    await waitFor(() => {
      expect(screen.queryByTestId('note-row-pending')).toBeNull()
    })
    expect(screen.getByText('Fresh note')).toBeTruthy()
    expect(screen.getByText('First note')).toBeTruthy() // the fetched page is intact
    expect(screen.getByTestId('note-composer-input').props['value'] as string).toBe('')
  })

  it('rolls the row back on a 500 envelope and toasts TRANSLATED copy, not the raw message', async () => {
    installMockServer({
      'GET /healthz': HEALTH,
      'GET /api/notes': () => listPage([EXISTING]),
      'POST /api/notes': () => ({
        status: 500,
        body: { error: { code: 'internal', message: 'note storage exploded' } },
      }),
    })
    renderRouter('./app')
    await screen.findByText('First note')

    await composeNote('Doomed note')

    // The error toast carries catalog copy chosen by the envelope's `code`. The
    // server's own English message is a log diagnostic, never the headline.
    const toast = await screen.findByTestId('toast-error')
    expect(toast).toHaveTextContent(en['error.api.internal'])
    expect(screen.queryByText('note storage exploded')).toBeNull()
    // …and the temp row is GONE (rollback — never a phantom row after a failed
    // write), while the draft survives for retry.
    expect(screen.queryByText('Doomed note')).toBeNull()
    expect(screen.getByTestId('note-composer-input').props['value'] as string).toBe('Doomed note')
  })

  it('a first optimistic note replaces the empty state with the list', async () => {
    installMockServer({
      'GET /healthz': HEALTH,
      'GET /api/notes': () => listPage([]),
      // POST held forever: the optimistic row must stand on its own.
      'POST /api/notes': () => new Promise<never>(() => undefined),
    })
    renderRouter('./app')
    await screen.findByTestId('home-empty')

    await composeNote('Fresh note')

    const pending = await screen.findByTestId('note-row-pending')
    expect(pending).toHaveTextContent('Fresh note')
    expect(screen.queryByTestId('home-empty')).toBeNull()
  })

  it('an invalid title renders the contract message inline and never POSTs', async () => {
    const posts = jest.fn()
    installMockServer({
      'GET /healthz': HEALTH,
      'GET /api/notes': () => listPage([]),
      'POST /api/notes': () => {
        posts()
        return { status: 201, body: SERVER_NOTE }
      },
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
    // Zod rejected at the boundary — no POST ever left the app.
    expect(posts).not.toHaveBeenCalled()
  })

  it('the connection indicator reports the healthz version through role=status', async () => {
    installMockServer({
      'GET /healthz': () => ({ status: 200, body: { ok: true, version: '9.9.9' } }),
      'GET /api/notes': () => listPage([]),
    })
    renderRouter('./app')
    const status = await screen.findByTestId('connection-status')
    await waitFor(() => {
      // exact:false — the version is interpolated INTO the catalog sentence.
      expect(status).toHaveTextContent('9.9.9', { exact: false })
    })
  })
})
