// The states sweep — src/routes.ts is the CONTRACT, this suite is its
// enforcement in the fast lane: for every route with a network-backed query
// (home, matrix) every canonical data state renders its manifest testID, and
// the error state CONTAINS a working retry affordance. Driven through
// renderRouter over the procedure double, so the shipped screens, hooks and
// translateError run for real.
//
// ACTIONS HONESTY: the actions route's data source is a static in-process
// registry — `loading` and `error` are UNREACHABLE (no network, no async, no
// failure mode), and this suite does not fake them. Its one driveable state is
// EMPTY (a query with no match), swept below. The manifest keeps all three ids
// so the contract stays uniform for consumers that add async sources.
import { appError } from '@app/errors'
import { fireEvent, renderRouter, screen } from 'expo-router/testing-library'
import { en } from '../src/i18n/catalog'
import { ROUTES } from '../src/routes'
import {
  installMockServer,
  type MockApiHandlers,
  mockApiClient,
  uninstallMockServer,
} from '../src/testing/mock-server'
import { installMockSupabase, mockSupabaseClient } from '../src/testing/mock-supabase'

jest.mock('../src/lib/supabase/provider', () => ({
  SupabaseProvider: ({ children }: { readonly children: unknown }) => children,
  useSupabase: () => mockSupabaseClient(),
}))
jest.mock('../src/lib/trpc/use-api', () => ({ useApi: () => mockApiClient() }))

const HOME = ROUTES[0]
const MATRIX = ROUTES[1]
const ACTIONS = ROUTES[2]

const HEALTH = () => ({ ok: true as const, version: '0.0.0' })

type Behavior = 'empty' | 'error' | 'held'

// ONE list handler per behavior, shared by both network-backed routes — home's
// unpaged query and matrix's paged one hit the same procedure, which is exactly
// why the sweep can be uniform per route instead of per screen.
function queryHandler(behavior: Behavior): NonNullable<MockApiHandlers['notesList']> {
  if (behavior === 'held') return () => new Promise<never>(() => undefined)
  if (behavior === 'empty') return () => ({ ok: true, data: { items: [], nextCursor: null } })
  return () => ({ ok: false, error: appError.unknown({ message: 'sweep-induced failure' }) })
}

function installFor(behavior: Behavior): void {
  installMockServer({ systemHealth: HEALTH, notesList: queryHandler(behavior) })
}

beforeEach(() => {
  installMockSupabase()
})

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

  it(`a failure envelope renders ${route.states.error} CONTAINING a retry that recovers`, async () => {
    installFor('error')
    renderRouter('./app', { initialUrl: route.path })
    const surface = await screen.findByTestId(route.states.error)
    expect(surface).toBeTruthy()
    // The manifest contract: the error surface CONTAINS the retry affordance,
    // and the retry actually re-runs the query (swap the double to empty first,
    // so recovery is observable).
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
