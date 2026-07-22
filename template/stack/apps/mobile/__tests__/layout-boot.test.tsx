// Boot smoke over the REAL app tree (jest-expo + expo-router/testing-library):
// renderRouter('./app') mounts the actual _layout.tsx — polyfills, module-scope
// boot (theme/i18n/session wiring), splash hold, tabs — against the mocked
// native layer. If any seam throws at import or first render, this is the suite
// that goes red first. Home now carries the real notes query + healthz probe,
// so the boot smoke declares that network on the mock server (an unhandled
// request throws by design).
import { renderRouter, screen } from 'expo-router/testing-library'
import { installMockServer, uninstallMockServer } from '../src/testing/mock-server'

jest.mock('../src/host', () => ({
  secureGetToken: jest.fn(() => Promise.resolve('jest-session-token')),
  secureSetToken: jest.fn(() => Promise.resolve()),
  secureDeleteToken: jest.fn(() => Promise.resolve()),
  secureGetRefreshToken: jest.fn(() => Promise.resolve(null)),
  secureSetRefreshToken: jest.fn(() => Promise.resolve()),
  secureDeleteRefreshToken: jest.fn(() => Promise.resolve()),
}))

beforeEach(() => {
  installMockServer({
    'GET /healthz': () => ({ status: 200, body: { ok: true, version: '0.0.0' } }),
    'GET /api/notes': () => ({ status: 200, body: { items: [], nextCursor: null } }),
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
