// The states sweep — src/routes.ts is the CONTRACT, this suite is its
// enforcement in the fast lane: for every route with a network-backed query
// (home, matrix) every canonical data state renders its manifest testID, and
// the error state CONTAINS a working retry affordance. Driven through
// renderRouter + the mock server, so the shipped screens, api-client and
// translateError run for real.
//
// ACTIONS HONESTY: the actions route's data source is a static in-process
// registry — `loading` and `error` are UNREACHABLE (no network, no async, no
// failure mode), and this suite does not fake them. Its one driveable state is
// EMPTY (a query with no match), swept below. The manifest keeps all three ids
// so the contract stays uniform for consumers that add async sources.
import { fireEvent, renderRouter, screen } from 'expo-router/testing-library'
import { en } from '../src/i18n/catalog'
import { ROUTES } from '../src/routes'
import {
  installMockServer,
  type MockRouteHandler,
  uninstallMockServer,
} from '../src/testing/mock-server'

jest.mock('../src/host', () => ({
  secureGetToken: jest.fn(() => Promise.resolve('jest-session-token')),
  secureSetToken: jest.fn(() => Promise.resolve()),
  secureDeleteToken: jest.fn(() => Promise.resolve()),
  secureGetRefreshToken: jest.fn(() => Promise.resolve(null)),
  secureSetRefreshToken: jest.fn(() => Promise.resolve()),
  secureDeleteRefreshToken: jest.fn(() => Promise.resolve()),
}))

const HOME = ROUTES[0]
const MATRIX = ROUTES[1]
const ACTIONS = ROUTES[2]

const HEALTH: MockRouteHandler = () => ({ status: 200, body: { ok: true, version: '0.0.0' } })

type Behavior = 'held' | 'empty' | 'error'

// One handler shape per behavior, installed for BOTH notes-query keys (home's
// bare list and matrix's paged list), so the sweep stays uniform per route.
function queryHandler(behavior: Behavior): MockRouteHandler {
  if (behavior === 'held') return () => new Promise<never>(() => undefined)
  if (behavior === 'empty') return () => ({ status: 200, body: { items: [], nextCursor: null } })
  return () => ({
    status: 500,
    body: { error: { code: 'internal', message: 'sweep-induced failure' } },
  })
}

function installFor(behavior: Behavior): void {
  installMockServer({
    'GET /healthz': HEALTH,
    'GET /api/notes': queryHandler(behavior),
    'GET /api/notes?limit=50': queryHandler(behavior),
  })
}

afterEach(() => {
  uninstallMockServer()
})

const NETWORK_ROUTES = [HOME, MATRIX] as const

describe.each(
  NETWORK_ROUTES.map((route) => [route.id, route] as const),
)('route %s canonical states', (_id, route) => {
  it(`held query renders ${route.states.loading} as a progressbar skeleton, never prose`, async () => {
    installFor('held')
    renderRouter('./app', { initialUrl: route.path })
    const loading = await screen.findByTestId(route.states.loading)
    // The loading surface is a Skeleton/Spinner (announced progressbar with the
    // catalog's loading copy) — a bare "Loading…" text line reds here.
    expect(loading.props['accessibilityRole'] as string).toBe('progressbar')
    expect(loading.props['accessibilityLabel'] as string).toBe(en['common.loading'])
  })

  it(`zero items render ${route.states.empty}`, async () => {
    installFor('empty')
    renderRouter('./app', { initialUrl: route.path })
    expect(await screen.findByTestId(route.states.empty)).toBeTruthy()
  })

  it(`a 500 envelope renders ${route.states.error} CONTAINING a retry that recovers`, async () => {
    installFor('error')
    renderRouter('./app', { initialUrl: route.path })
    const surface = await screen.findByTestId(route.states.error)
    expect(surface).toBeTruthy()
    // The manifest contract: the error surface CONTAINS the retry affordance,
    // and the retry actually re-runs the query (swap the network to empty
    // first, so recovery is observable).
    uninstallMockServer()
    installFor('empty')
    fireEvent.press(screen.getByRole('button', { name: en['common.retry'] }))
    expect(await screen.findByTestId(route.states.empty)).toBeTruthy()
  })
})

describe('route actions canonical states', () => {
  it(`a no-match query renders ${ACTIONS.states.empty} (loading/error are honestly unreachable)`, async () => {
    installFor('empty')
    renderRouter('./app', { initialUrl: ACTIONS.path })
    fireEvent.changeText(await screen.findByTestId('actions-search'), 'zzzz no such action')
    expect(await screen.findByTestId(ACTIONS.states.empty)).toBeTruthy()
  })
})
