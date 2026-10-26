import type { WebRouteMeta } from '../../../lib/routes'

// The security route's registry entry — CONTENT, never allowlisted chrome: the
// factor list is a real query with all three canonical states, and declaring
// them here is what holds the page to rendering each one (check-web-routes.mjs
// proves every declared id appears in this segment's source).
export const meta = {
  id: 'security',
  titleKey: 'route.security',
  states: {
    loading: 'security-loading',
    empty: 'security-empty',
    error: 'security-error',
  },
} as const satisfies WebRouteMeta
