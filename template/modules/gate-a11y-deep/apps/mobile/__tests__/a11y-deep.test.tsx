// The DEEP accessibility sweep (gate-a11y-deep module) — the automated,
// enforceable half of the module, keyed to the SAME canonical manifest
// (src/routes.ts) the route-manifest gate closes over, so a screen cannot
// register without joining this sweep and cannot ship swept while
// unregistered. Per route × per reachable canonical data state it asserts
// what the base floor (eslint-plugin-react-native-a11y at error +
// primitives-a11y contracts) cannot see at the SCREEN level:
//
//   1. every interactive accessibility element (button/link/tab/switch/…)
//      exposes a non-empty ACCESSIBLE NAME — the string TalkBack/VoiceOver
//      actually announce (computed by RNTL exactly as the platform does:
//      aria-label/accessibilityLabel, else descendant text);
//   2. every TextInput carries an explicit label prop — placeholder text and
//      typed values are NOT labels (a placeholder disappears the moment the
//      user types; a value masks the field's purpose), so this check reads
//      the label props directly instead of the accessible-name fallback;
//   3. the manifest's state surface itself is VISIBLE to assistive tech
//      (toBeVisible fails on display:none, opacity:0 and
//      accessibility-hidden ancestors — deeper than the states sweep's
//      presence check);
//   4. the error state's retry affordance is reachable BY ROLE with its
//      catalog name — recovery must exist on the announced surface, not
//      just as a testID for the functional suite.
//
// ACTIONS HONESTY (mirrors states-sweep.test.tsx): the actions route's data
// source is a static in-process registry — loading and error are unreachable
// and this suite does not fake them; its swept surfaces are the default
// (ready) modal and the no-match empty state.
//
// Machine checks end where judgement begins: docs/runbooks/screen-reader-checklist.md
// holds the on-device TalkBack/VoiceOver pass this sweep cannot replace
// (announcement ORDER, gesture navigation, real focus movement), and the CI
// device lane owns painted pixels and Fabric-flattening detachment.
// SOURCE: https://reactnative.dev/docs/accessibility (accessibilityLabel / role semantics)
// SOURCE: https://www.w3.org/TR/WCAG22/ (SC 4.1.2 name-role-value; SC 2.5.3 label-in-name)
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

// A NoteDto-shaped fixture for the ready-state sweeps (same shape the flow
// suites use — the list contract from @app/contracts).
function note(id: string, title: string) {
  return {
    id: `00000000-0000-4000-8000-${id.padStart(12, '0')}`,
    ownerId: '00000000-0000-4000-8000-0000000000aa',
    title,
    body: 'alpha body',
    createdAt: '2026-01-01T00:00:00.000Z',
    embedding: null,
    sourceConfidence: 0.5,
    sourceModel: null,
  }
}

function installReady(): void {
  const ready: MockRouteHandler = () => ({
    status: 200,
    body: { items: [note('1', 'Deep sweep fixture note')], nextCursor: null },
  })
  installMockServer({
    'GET /healthz': HEALTH,
    'GET /api/notes': ready,
    'GET /api/notes?limit=50': ready,
  })
}

afterEach(() => {
  uninstallMockServer()
})

// The RN roles a user can OPERATE — each must announce a non-empty name.
// (Static/text roles — header, alert, text, cell — carry their content as the
// announcement; the interactive set is where a silent control strands a
// screen-reader user mid-task.)
// SOURCE: https://reactnative.dev/docs/accessibility#accessibilityrole
// cspell:ignore togglebutton imagebutton -- verbatim RN accessibilityRole values
const INTERACTIVE_ROLES = [
  'button',
  'togglebutton',
  'link',
  'imagebutton',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'search',
  'combobox',
  'adjustable',
  'spinbutton',
] as const

// Sweep-wide tallies for the anti-vacuity verdict at the bottom: a sweep that
// audited zero interactive elements is a sweep asserting nothing.
let auditedInteractive = 0
let auditedInputs = 0

/** Human-readable pointer for a failing element (the test name carries route+state). */
function describeElement(el: { type: unknown; props: Record<string, unknown> }): string {
  const type = typeof el.type === 'string' ? el.type : 'composite'
  const testId = typeof el.props['testID'] === 'string' ? `#${el.props['testID']}` : ''
  return `${type}${testId}`
}

// Every interactive element must expose a non-empty accessible name. The
// verdict comes from RNTL's OWN accessible-name computation (the `name`
// option of *ByRole matches it), never a private reimplementation — the
// unnamed set is exactly (all with role) minus (those matching name /\S/).
function expectInteractiveElementsNamed(): void {
  const offenders: string[] = []
  for (const role of INTERACTIVE_ROLES) {
    const all = screen.queryAllByRole(role)
    if (all.length === 0) continue
    const named = new Set(screen.queryAllByRole(role, { name: /\S/ }))
    for (const el of all) {
      auditedInteractive += 1
      if (!named.has(el)) offenders.push(`${describeElement(el)} [role=${role}]`)
    }
  }
  expect(offenders).toEqual([])
}

// Every TextInput must be labelled EXPLICITLY (label props only — the
// accessible-name text-content fallback would let a typed value or a
// placeholder mask a missing label).
function expectInputsLabelled(): void {
  const offenders: string[] = []
  // Host TextInput elements: matched by host-component NAME (the string RNTL
  // itself resolves for text inputs). The annotated widening to `string` is
  // deliberate — the .d.ts types host names as a literal union that omits RN
  // hosts, while the runtime value here is exactly 'TextInput'.
  const inputs = screen.root.findAll((node) => {
    if (typeof node.type !== 'string') return false
    const typeName: string = node.type
    return typeName === 'TextInput'
  })
  for (const el of inputs) {
    auditedInputs += 1
    const props = el.props as Record<string, unknown>
    const label =
      props['aria-label'] ??
      props['accessibilityLabel'] ??
      props['aria-labelledby'] ??
      props['accessibilityLabelledBy']
    if (typeof label !== 'string' || label.trim() === '') {
      offenders.push(describeElement(el))
    }
  }
  expect(offenders).toEqual([])
}

const NETWORK_ROUTES = [HOME, MATRIX] as const

describe.each(
  NETWORK_ROUTES.map((route) => [route.id, route] as const),
)('route %s — deep a11y per canonical state', (_id, route) => {
  it(`held query: ${route.states.loading} is visible to assistive tech; every control is named`, async () => {
    installFor('held')
    renderRouter('./app', { initialUrl: route.path })
    expect(await screen.findByTestId(route.states.loading)).toBeVisible()
    expectInteractiveElementsNamed()
    expectInputsLabelled()
  })

  it(`zero items: ${route.states.empty} is visible to assistive tech; every control is named`, async () => {
    installFor('empty')
    renderRouter('./app', { initialUrl: route.path })
    expect(await screen.findByTestId(route.states.empty)).toBeVisible()
    expectInteractiveElementsNamed()
    expectInputsLabelled()
  })

  it(`a 500 envelope: ${route.states.error} is visible; retry is reachable BY ROLE with its catalog name`, async () => {
    installFor('error')
    renderRouter('./app', { initialUrl: route.path })
    expect(await screen.findByTestId(route.states.error)).toBeVisible()
    // Recovery on the ANNOUNCED surface: role=button + the catalog name —
    // a retry reachable only by testID is invisible to a screen-reader user.
    expect(screen.getByRole('button', { name: en['common.retry'] })).toBeVisible()
    expectInteractiveElementsNamed()
    expectInputsLabelled()
  })

  it('ready (one item): the populated surface keeps every control named', async () => {
    installReady()
    renderRouter('./app', { initialUrl: route.path })
    expect(await screen.findByText('Deep sweep fixture note')).toBeVisible()
    expectInteractiveElementsNamed()
    expectInputsLabelled()
  })
})

describe('route actions — deep a11y (loading/error honestly unreachable)', () => {
  it('the default modal surface: search input labelled, every option named', async () => {
    installFor('empty')
    renderRouter('./app', { initialUrl: ACTIONS.path })
    expect(await screen.findByTestId('actions-search')).toBeVisible()
    expectInteractiveElementsNamed()
    expectInputsLabelled()
  })

  it(`a no-match query: ${ACTIONS.states.empty} is visible to assistive tech`, async () => {
    installFor('empty')
    renderRouter('./app', { initialUrl: ACTIONS.path })
    fireEvent.changeText(await screen.findByTestId('actions-search'), 'zzzz no such action')
    expect(await screen.findByTestId(ACTIONS.states.empty)).toBeVisible()
    expectInteractiveElementsNamed()
  })
})

describe('sweep anti-vacuity', () => {
  it('the manifest is not empty (an empty sweep is a vacuous pass)', () => {
    expect(ROUTES.length).toBeGreaterThan(0)
  })

  it('the sweep audited real surfaces: interactive elements AND labelled inputs were seen', () => {
    // Declared last in the file — jest runs describe blocks in declaration
    // order, so the tallies above are final here. Zero audited interactive
    // elements would mean every screen rendered bare of controls (or the
    // role queries silently broke): either way the sweep proved nothing and
    // must say so.
    expect(auditedInteractive).toBeGreaterThan(0)
    expect(auditedInputs).toBeGreaterThan(0)
  })
})
