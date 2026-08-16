// The canonical route manifest. EVERY user-reachable content screen registers
// here: a stable id, the catalog KEY its title lives under, the URL path
// expo-router serves it at, the file under app/ that renders it, and the
// testID each canonical data state (loading/empty/error) exposes. The
// route-manifest gate closes the loop — an app/ screen no entry references
// (and that is not allowlisted chrome) fails validate — and the test lanes
// ITERATE this array (the RNTL fast lane per state, the Maestro device lane
// per flow, the startup-budget closure per screen), so a screen missing an
// entry is a screen that ships untested, and a screen WITH an entry is
// automatically held to those bars the day it registers.
//
// The title is a MESSAGE KEY, not prose: a route's name is the most visible
// copy in the app (tab label, header) and it is translatable like everything
// else — callers render it with `t(route.titleKey)`.
//
// CHROME IS NOT CONTENT: sign-in and +not-found deliberately have no entry
// (same pattern as the desktop original) — they are shell surfaces with no
// canonical data states, and they live in the route allowlist the
// route-manifest gate reads instead.
import type { MessageKey } from './i18n'

interface RouteStates {
  /** testID visible while the screen's primary query is in flight. */
  readonly loading: string
  /** testID visible when the query resolves to zero items. */
  readonly empty: string
  /** testID visible when the query fails — must CONTAIN a retry button. */
  readonly error: string
}

interface RouteEntry {
  /** Stable machine id — lowercase, used in test titles and state test ids. */
  readonly id: string
  /** Catalog key for the human title. A KEY, not prose — render with t(). */
  readonly titleKey: MessageKey
  /** URL path expo-router serves the screen at. */
  readonly path: string
  /** File under app/ (extension omitted) that renders the screen — the
   *  routes-closure test asserts it exists, so the manifest can never lie. */
  readonly file: string
  readonly states: RouteStates
}

// `as const satisfies`: entries stay literal-typed (states.empty is a string
// literal usable directly as a testID) while the shape is still checked.
export const ROUTES = [
  {
    id: 'home',
    titleKey: 'route.home',
    path: '/',
    file: '(tabs)/index',
    states: {
      loading: 'home-loading',
      empty: 'home-empty',
      error: 'home-error',
    },
  },
  {
    id: 'matrix',
    titleKey: 'route.matrix',
    path: '/matrix',
    file: '(tabs)/matrix',
    states: {
      loading: 'matrix-loading',
      empty: 'matrix-empty',
      error: 'matrix-error',
    },
  },
  {
    id: 'actions',
    titleKey: 'route.actions',
    path: '/actions',
    file: 'actions',
    states: {
      loading: 'actions-loading',
      empty: 'actions-empty',
      error: 'actions-error',
    },
  },
  {
    id: 'security',
    titleKey: 'route.security',
    path: '/security',
    file: 'security',
    states: {
      loading: 'security-loading',
      empty: 'security-empty',
      error: 'security-error',
    },
  },
] as const satisfies readonly RouteEntry[]
