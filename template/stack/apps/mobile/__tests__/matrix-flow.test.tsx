// Matrix screen flows — keyset pagination against the mock server through the
// REAL screen: ready surface with plural summary, Load-more appends the next
// page (the reachable equivalent of the near-end scroll trigger), a failed
// loadMore keeps the data and surfaces toast + inline retry, and the list's
// accessibility contract (label + pagination hint + per-row role/label) holds.
import { fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library'
import { en } from '../src/i18n/catalog'
import { installMockServer, uninstallMockServer } from '../src/testing/mock-server'

jest.mock('../src/host', () => ({
  secureGetToken: jest.fn(() => Promise.resolve('jest-session-token')),
  secureSetToken: jest.fn(() => Promise.resolve()),
  secureDeleteToken: jest.fn(() => Promise.resolve()),
  secureGetRefreshToken: jest.fn(() => Promise.resolve(null)),
  secureSetRefreshToken: jest.fn(() => Promise.resolve()),
  secureDeleteRefreshToken: jest.fn(() => Promise.resolve()),
}))

const FIRST_PAGE_KEY = 'GET /api/notes?limit=50'
const SECOND_PAGE_KEY = 'GET /api/notes?limit=50&cursor=c2'

function note(id: string, title: string) {
  return {
    id: `00000000-0000-4000-8000-${id.padStart(12, '0')}`,
    ownerId: '00000000-0000-4000-8000-0000000000aa',
    title,
    body: 'one two\nthree',
    createdAt: '2026-01-01T00:00:00.000Z',
    embedding: null,
    sourceConfidence: 0.5,
    sourceModel: null,
  }
}

const page = (items: readonly unknown[], nextCursor: string | null) => ({
  status: 200,
  body: { items, nextCursor },
})
const HEALTH = () => ({ status: 200, body: { ok: true as const, version: '0.0.0' } })

afterEach(() => {
  uninstallMockServer()
})

describe('matrix pagination', () => {
  it('renders the first page, appends the next via Load more, and exhausts the cursor', async () => {
    installMockServer({
      'GET /healthz': HEALTH,
      [FIRST_PAGE_KEY]: () => page([note('1', 'Alpha')], 'c2'),
      [SECOND_PAGE_KEY]: () => page([note('2', 'Beta')], null),
    })
    renderRouter('./app', { initialUrl: '/matrix' })

    // Ready surface: the plural summary (Intl.PluralRules — "1 row", never "1 rows").
    const summary = await screen.findByTestId('matrix-summary')
    expect(summary).toHaveTextContent('1 row ×', { exact: false })
    expect(await screen.findByText('Alpha')).toBeTruthy()

    fireEvent.press(screen.getByTestId('matrix-load-more'))

    await screen.findByText('Beta')
    expect(screen.getByText('Alpha')).toBeTruthy() // pages APPEND
    expect(screen.getByTestId('matrix-summary')).toHaveTextContent('2 rows ×', { exact: false })
    // Cursor exhausted: the load-more affordance leaves the screen.
    await waitFor(() => {
      expect(screen.queryByTestId('matrix-load-more')).toBeNull()
    })
  })

  it('a failed loadMore keeps the rendered data and offers toast + inline retry', async () => {
    let secondCalls = 0
    installMockServer({
      'GET /healthz': HEALTH,
      [FIRST_PAGE_KEY]: () => page([note('1', 'Alpha')], 'c2'),
      [SECOND_PAGE_KEY]: () => {
        secondCalls += 1
        return secondCalls === 1
          ? { status: 500, body: { error: { code: 'internal', message: 'page exploded' } } }
          : page([note('2', 'Beta')], null)
      },
    })
    renderRouter('./app', { initialUrl: '/matrix' })
    await screen.findByText('Alpha')

    fireEvent.press(screen.getByTestId('matrix-load-more'))

    // Toast: catalog sentence around the TRANSLATED envelope copy; raw server
    // text stays out of the headline.
    const toast = await screen.findByTestId('toast-error')
    expect(toast).toHaveTextContent(en['error.api.internal'], { exact: false })
    // Inline retry line + the data intact.
    expect(screen.getByText(en['matrix.loadMore.failed'])).toBeTruthy()
    expect(screen.getByText('Alpha')).toBeTruthy()

    // The inline retry re-runs the SAME page request and recovers.
    fireEvent.press(screen.getByRole('button', { name: en['common.retry'] }))
    await screen.findByText('Beta')
  })

  it('the list carries the a11y contract: label, pagination hint, one labelled row per note', async () => {
    installMockServer({
      'GET /healthz': HEALTH,
      [FIRST_PAGE_KEY]: () => page([note('1', 'Alpha'), note('2', 'Beta')], null),
    })
    renderRouter('./app', { initialUrl: '/matrix' })

    const list = await screen.findByTestId('matrix-list')
    expect(list.props['accessibilityLabel'] as string).toBe(en['matrix.list'])
    // The pagination ANNOUNCEMENT — the near-end trigger is silent, the hint is not.
    expect(list.props['accessibilityHint'] as string).toBe(en['matrix.pagination.hint'])
    // Per-row role + accessible label (one accessible element per row).
    expect((await screen.findAllByRole('row')).length).toBe(2)
    expect(screen.getByLabelText('Alpha')).toBeTruthy()
    expect(screen.getByLabelText('Beta')).toBeTruthy()
  })
})
