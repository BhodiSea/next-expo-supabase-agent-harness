// Boot smoke over the REAL app tree (jest-expo + expo-router/testing-library):
// renderRouter('./app') mounts the actual _layout.tsx — polyfills, module-scope
// boot (theme + i18n), the Supabase provider, splash hold, tabs — against the
// mocked native layer. If any seam throws at import or first render, this is
// the suite that goes red first. Home carries the real notes query + liveness
// probe, so the boot smoke declares those procedures on the double (an
// unstubbed one throws by design).
import { renderRouter, screen } from 'expo-router/testing-library'
import { installMockServer, mockApiClient, uninstallMockServer } from '../src/testing/mock-server'
import { installMockSupabase, mockSupabaseClient } from '../src/testing/mock-supabase'

jest.mock('../src/lib/supabase/provider', () => ({
  SupabaseProvider: ({ children }: { readonly children: unknown }) => children,
  useSupabase: () => mockSupabaseClient(),
}))
jest.mock('../src/lib/trpc/use-api', () => ({ useApi: () => mockApiClient() }))

beforeEach(() => {
  installMockSupabase()
  installMockServer({
    systemHealth: () => ({ ok: true as const, version: '0.0.0' }),
    notesList: () => ({ ok: true, data: { items: [], nextCursor: null } }),
  })
})

afterEach(() => {
  uninstallMockServer()
})

describe('root layout boot', () => {
  it('mounts the real app tree without throwing and lands on Home', async () => {
    renderRouter('./app')
    expect(await screen.findByTestId('home-empty')).toBeTruthy()
  })

  it('the Hermes Intl polyfills are installed before anything renders', () => {
    // _layout.tsx imports src/i18n/polyfills FIRST; by the time any test module
    // has loaded the layout, the polyfill-force set must be live. (Under jest
    // the host is Node — which HAS these natively — so the assertion that
    // matters is the marker the @formatjs implementations carry.)
    expect(typeof Intl.PluralRules).toBe('function')
    expect(typeof Intl.RelativeTimeFormat).toBe('function')
    expect(typeof Intl.Locale).toBe('function')
    const polyfilled = Intl.PluralRules as typeof Intl.PluralRules & { polyfilled?: boolean }
    expect(polyfilled.polyfilled).toBe(true)
  })

  it('navigating to an unknown path renders the not-found chrome, not a crash', async () => {
    renderRouter('./app', { initialUrl: '/definitely-not-a-screen' })
    expect(await screen.findByTestId('not-found-screen')).toBeTruthy()
  })
})
