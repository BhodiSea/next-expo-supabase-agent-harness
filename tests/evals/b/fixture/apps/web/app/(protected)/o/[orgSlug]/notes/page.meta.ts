import type { WebRouteMeta } from '../../../../../lib/routes'

// One org's notes — the worked content route. All three canonical states are real here, which
// is why this is the route the gate's own fixtures use as the positive example: the segment
// renders every id declared below, and check-web-routes.mjs proves that rather than assuming
// it (the web half has no runtime states sweep to do it at request time).
export const meta = {
  id: 'notes',
  titleKey: 'route.notes',
  states: {
    loading: 'notes-loading',
    empty: 'notes-empty',
    error: 'notes-error',
  },
} as const satisfies WebRouteMeta
