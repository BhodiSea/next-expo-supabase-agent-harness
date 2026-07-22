// Actions modal — ranking, sections, recents pinning, and command execution
// through the REAL router (renderRouter: running a navigation command closes
// the modal and lands on the target screen). Storage: src/lib/kv is mocked
// in-memory (the native kv-store is absent under jest and the corrupt-safe kv
// would silently read empty — the recents behavior needs a store that works).
import { fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library'
import { Alert } from 'react-native'
import { en } from '../src/i18n/catalog'
import { installMockServer, uninstallMockServer } from '../src/testing/mock-server'

const { kvBacking } = jest.requireMock<{ kvBacking: Map<string, string> }>('../src/lib/kv')

jest.mock('../src/lib/kv', () => {
  const kvBacking = new Map<string, string>()
  return {
    kvBacking,
    kvGet: (key: string) => kvBacking.get(key) ?? null,
    kvSet: (key: string, value: string) => {
      kvBacking.set(key, value)
    },
    kvDelete: (key: string) => {
      kvBacking.delete(key)
    },
  }
})

jest.mock('../src/host', () => ({
  secureGetToken: jest.fn(() => Promise.resolve('jest-session-token')),
  secureSetToken: jest.fn(() => Promise.resolve()),
  secureDeleteToken: jest.fn(() => Promise.resolve()),
  secureGetRefreshToken: jest.fn(() => Promise.resolve(null)),
  secureSetRefreshToken: jest.fn(() => Promise.resolve()),
  secureDeleteRefreshToken: jest.fn(() => Promise.resolve()),
}))

const RECENTS_KEY = 'actions.recents'

/** Press the first element carrying the testID (guarded: noUncheckedIndexedAccess types [0] undefined). */
async function pressFirst(testId: string): Promise<void> {
  const [first] = await screen.findAllByTestId(testId)
  if (first === undefined) throw new Error(`no element with testID ${testId}`)
  fireEvent.press(first)
}

const emptyPage = () => ({ status: 200, body: { items: [], nextCursor: null } })
const HEALTH = () => ({ status: 200, body: { ok: true as const, version: '0.0.0' } })

// Every screen a command can land on fetches — cover the whole route surface.
function installAppNetwork(): void {
  installMockServer({
    'GET /healthz': HEALTH,
    'GET /api/notes': emptyPage,
    'GET /api/notes?limit=50': emptyPage,
  })
}

beforeEach(() => {
  kvBacking.clear()
})

afterEach(() => {
  uninstallMockServer()
})

function optionTitles(): readonly string[] {
  return screen
    .getAllByTestId(/^action-/)
    .map((option) => (option.props['accessibilityLabel'] ?? '') as string)
}

describe('actions modal sections + ranking', () => {
  it('renders group headers and commands in registration order on the empty query', async () => {
    installAppNetwork()
    renderRouter('./app', { initialUrl: '/actions' })
    await screen.findByTestId('actions-screen')

    expect(screen.getByText(en['actions.group.navigation'])).toBeTruthy()
    expect(screen.getByText(en['actions.group.notes'])).toBeTruthy()
    expect(screen.getByText(en['actions.group.session'])).toBeTruthy()
    expect(optionTitles()).toEqual([
      en['command.goHome'],
      en['command.goMatrix'],
      en['command.createNote'],
      en['command.signOut'],
      en['command.deleteAccount'],
    ])
  })

  it('re-ranks as the user types — pinned in fuzzyScore.test.ts: boundary hits beat scattered', async () => {
    installAppNetwork()
    renderRouter('./app', { initialUrl: '/actions' })
    fireEvent.changeText(await screen.findByTestId('actions-search'), 'tm')

    expect(optionTitles()).toEqual([en['command.goMatrix'], en['command.goHome']])
    // Groups with no surviving member disappear.
    expect(screen.queryByText(en['actions.group.session'])).toBeNull()
  })

  it('shows the empty state when nothing matches — the route manifest testID lands here', async () => {
    installAppNetwork()
    renderRouter('./app', { initialUrl: '/actions' })
    fireEvent.changeText(await screen.findByTestId('actions-search'), 'zzzz')

    expect(await screen.findByTestId('actions-empty')).toBeTruthy()
    expect(screen.queryAllByTestId(/^action-/)).toHaveLength(0)
  })
})

describe('actions modal recents', () => {
  it('pins a Recents section first on the empty query, duplicating the command in its home group', async () => {
    kvBacking.set(RECENTS_KEY, JSON.stringify(['session.signOut']))
    installAppNetwork()
    renderRouter('./app', { initialUrl: '/actions' })
    await screen.findByTestId('actions-screen')

    expect(screen.getByText(en['actions.group.recents'])).toBeTruthy()
    // The recent command renders twice — under Recents AND its home group.
    expect(screen.getAllByTestId('action-session.signOut')).toHaveLength(2)
    // Recents lead the surface: the first rendered option is the recent one.
    expect(optionTitles()[0]).toBe(en['command.signOut'])
  })

  it('replaces Recents with ranked results as soon as the user types', async () => {
    kvBacking.set(RECENTS_KEY, JSON.stringify(['session.signOut']))
    installAppNetwork()
    renderRouter('./app', { initialUrl: '/actions' })
    fireEvent.changeText(await screen.findByTestId('actions-search'), 'go')

    expect(screen.queryByText(en['actions.group.recents'])).toBeNull()
    fireEvent.changeText(screen.getByTestId('actions-search'), '')
    expect(await screen.findByText(en['actions.group.recents'])).toBeTruthy()
  })

  it('filters recents ids whose command no longer exists (stale build) without dropping storage', async () => {
    kvBacking.set(RECENTS_KEY, JSON.stringify(['ghost.command', 'nav.home']))
    installAppNetwork()
    renderRouter('./app', { initialUrl: '/actions' })
    await screen.findByText(en['actions.group.recents'])

    // Only the live command surfaces; the ghost id stays in storage untouched.
    expect(screen.getAllByTestId('action-nav.home')).toHaveLength(2)
    expect(JSON.parse(kvBacking.get(RECENTS_KEY) ?? 'null')).toEqual(['ghost.command', 'nav.home'])
  })

  it('running a command records it at the front of the persisted recents', async () => {
    kvBacking.set(RECENTS_KEY, JSON.stringify(['nav.home']))
    installAppNetwork()
    renderRouter('./app', { initialUrl: '/actions' })

    await pressFirst('action-nav.matrix')

    await waitFor(() => {
      expect(JSON.parse(kvBacking.get(RECENTS_KEY) ?? 'null')).toEqual(['nav.matrix', 'nav.home'])
    })
  })

  it('survives a corrupt recents payload without a Recents section', async () => {
    kvBacking.set(RECENTS_KEY, '[[[corrupt')
    installAppNetwork()
    renderRouter('./app', { initialUrl: '/actions' })
    await screen.findByTestId('actions-screen')

    expect(screen.queryByText(en['actions.group.recents'])).toBeNull()
  })
})

describe('actions modal commands', () => {
  it('a navigation command closes the modal and lands on its target screen', async () => {
    installAppNetwork()
    renderRouter('./app', { initialUrl: '/actions' })

    await pressFirst('action-nav.matrix')

    expect(await screen.findByTestId('matrix-screen')).toBeTruthy()
  })

  it('create-note lands on Home with the composer focused', async () => {
    installAppNetwork()
    renderRouter('./app', { initialUrl: '/actions' })

    await pressFirst('action-notes.create')

    const input = await screen.findByTestId('note-composer-input')
    // The ?focus=composer param forwards as the input's autoFocus.
    expect(input.props['autoFocus'] as boolean).toBe(true)
  })

  it('sign-out drops the session and returns to the sign-in screen', async () => {
    installAppNetwork()
    renderRouter('./app', { initialUrl: '/actions' })

    await pressFirst('action-session.signOut')

    expect(await screen.findByTestId('sign-in-screen')).toBeTruthy()
  })
})

// ---- account deletion (Apple 5.1.1(v)) --------------------------------------

interface AlertButton {
  readonly text?: string
  readonly style?: string
  readonly onPress?: () => void
}

/** The app network plus a recordable DELETE /api/me (204 is unrepresentable in
 *  the mock's JSON envelope — a 200 body stands in; apiFetch only reads ok). */
function installDeletionNetwork(onDelete: () => { status: number; body: unknown }): void {
  installMockServer({
    'GET /healthz': HEALTH,
    'GET /api/notes': emptyPage,
    'GET /api/notes?limit=50': emptyPage,
    'DELETE /api/me': onDelete,
  })
}

describe('actions modal account deletion (Apple 5.1.1(v))', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('the command asks for native confirmation first — cancel sends NOTHING', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
    let hits = 0
    installDeletionNetwork(() => {
      hits += 1
      return { status: 200, body: { ok: true } }
    })
    renderRouter('./app', { initialUrl: '/actions' })

    await pressFirst('action-session.deleteAccount')

    expect(alert).toHaveBeenCalledWith(
      en['account.delete.confirmTitle'],
      en['account.delete.confirmBody'],
      expect.any(Array),
    )
    const buttons = (alert.mock.calls.at(-1)?.[2] ?? []) as readonly AlertButton[]
    buttons.find((b) => b.style === 'cancel')?.onPress?.()
    expect(hits).toBe(0)
  })

  it('confirm deletes on the server, drops the session, and lands on sign-in', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
    let hits = 0
    installDeletionNetwork(() => {
      hits += 1
      return { status: 200, body: { ok: true } }
    })
    renderRouter('./app', { initialUrl: '/actions' })

    await pressFirst('action-session.deleteAccount')
    const buttons = (alert.mock.calls.at(-1)?.[2] ?? []) as readonly AlertButton[]
    const confirm = buttons.find((b) => b.style === 'destructive')
    expect(confirm?.text).toBe(en['account.delete.confirm'])
    confirm?.onPress?.()

    expect(await screen.findByTestId('sign-in-screen')).toBeTruthy()
    expect(hits).toBe(1)
  })

  it('a failed server deletion keeps the session and surfaces the envelope toast', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
    installDeletionNetwork(() => ({
      status: 500,
      body: { error: { code: 'internal', message: 'deletion exploded' } },
    }))
    renderRouter('./app', { initialUrl: '/actions' })

    await pressFirst('action-session.deleteAccount')
    const buttons = (alert.mock.calls.at(-1)?.[2] ?? []) as readonly AlertButton[]
    buttons.find((b) => b.style === 'destructive')?.onPress?.()

    expect(await screen.findByTestId('toast-error')).toBeTruthy()
    // Nothing half-deletes: the failure keeps the session, no sign-in redirect.
    expect(screen.queryByTestId('sign-in-screen')).toBeNull()
  })
})
