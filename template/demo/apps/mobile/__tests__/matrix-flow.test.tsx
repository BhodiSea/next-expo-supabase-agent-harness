// Matrix screen flows — keyset pagination through the REAL screen: ready surface
// with plural summary, Load-more appends the next page (the reachable equivalent
// of the near-end scroll trigger), a failed loadMore keeps the data and surfaces
// toast + inline retry, and the list's accessibility contract (label + pagination
// hint + per-row role/label) holds.
//
// The double answers at the PROCEDURE, so the cursor assertion is direct: the
// handler reads `input.cursor` and the test pins what the hook sent, rather than
// pattern-matching a URL and hoping the query string was built the same way.
import type { NotesPage, NoteView } from '@app/contracts'
import { type ActionOutcome, appError } from '@app/errors'
import { fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library'
import { en } from '../src/i18n/catalog'
import { installMockServer, mockApiClient, uninstallMockServer } from '../src/testing/mock-server'
import { installMockSupabase, mockSupabaseClient } from '../src/testing/mock-supabase'

jest.mock('../src/lib/supabase/provider', () => ({
  SupabaseProvider: ({ children }: { readonly children: unknown }) => children,
  useSupabase: () => mockSupabaseClient(),
}))
jest.mock('../src/lib/trpc/use-api', () => ({ useApi: () => mockApiClient() }))

const SECOND_CURSOR = 'c2'

function note(id: string, title: string): NoteView {
  return {
    createdAt: '2026-01-01T00:00:00.000Z',
    excerpt: 'one two three',
    hasBody: true,
    id: `00000000-0000-4000-8000-${id.padStart(12, '0')}`,
    isArchived: false,
    title,
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

// Returns `NotesPage` — the SHIPPED contract type — rather than a locally
// re-declared readonly twin. A hand-written double that is merely
// shape-compatible drifts silently: the day the contract gains a field, the real
// procedure returns it and this double does not, and every test still passes
// while the screen renders undefined. Naming the contract makes that a red.
const page = (items: NoteView[], nextCursor: string | null): ActionOutcome<NotesPage> => ({
  ok: true,
  data: { items, nextCursor },
})

const HEALTH = () => ({ ok: true as const, version: '0.0.0' })

beforeEach(() => {
  installMockSupabase()
})

afterEach(() => {
  uninstallMockServer()
})

describe('matrix pagination', () => {
  it('renders the first page, appends the next via Load more, and exhausts the cursor', async () => {
    installMockServer({
      systemHealth: HEALTH,
      notesList: (input) =>
        input.cursor === undefined
          ? page([note('1', 'Alpha')], SECOND_CURSOR)
          : page([note('2', 'Beta')], null),
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

  it('forwards the cursor the server handed back, verbatim', async () => {
    const seen: (string | undefined)[] = []
    installMockServer({
      systemHealth: HEALTH,
      notesList: (input) => {
        seen.push(input.cursor)
        return input.cursor === undefined
          ? page([note('1', 'Alpha')], SECOND_CURSOR)
          : page([note('2', 'Beta')], null)
      },
    })
    renderRouter('./app', { initialUrl: '/matrix' })
    await screen.findByText('Alpha')

    fireEvent.press(screen.getByTestId('matrix-load-more'))
    await screen.findByText('Beta')

    // The token is OPAQUE to the client — its only correct handling is to send
    // back exactly what arrived. A client that parsed or rebuilt it would break
    // the moment the server's keyset encoding changed, which is the whole reason
    // the token is opaque.
    expect(seen).toEqual([undefined, SECOND_CURSOR])
  })

  it('a failed loadMore keeps the rendered data and offers toast + inline retry', async () => {
    let secondCalls = 0
    installMockServer({
      systemHealth: HEALTH,
      notesList: (input) => {
        if (input.cursor === undefined) return page([note('1', 'Alpha')], SECOND_CURSOR)
        secondCalls += 1
        return secondCalls === 1
          ? { ok: false, error: appError.unknown({ message: 'page exploded' }) }
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

  it('an initial-load failure owns the route error surface, translated', async () => {
    installMockServer({
      systemHealth: HEALTH,
      notesList: () => ({ ok: false, error: appError.unauthorized() }),
    })
    renderRouter('./app', { initialUrl: '/matrix' })

    expect(await screen.findByTestId('matrix-error')).toBeTruthy()
    expect(screen.getByText(en['error.api.unauthorized'])).toBeTruthy()
  })

  it('the list carries the a11y contract: label, pagination hint, one labelled row per note', async () => {
    installMockServer({
      systemHealth: HEALTH,
      notesList: () => page([note('1', 'Alpha'), note('2', 'Beta')], null),
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
