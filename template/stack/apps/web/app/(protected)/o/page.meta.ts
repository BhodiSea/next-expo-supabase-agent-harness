import type { WebRouteMeta } from '../../../lib/routes'

// The org picker's registry entry. `path` and `file` are absent on purpose: the App Router
// decides both from where this file sits, and tools/gen-web-routes.mjs writes them into
// apps/web/lib/routes.generated.ts. What lives here is only what position cannot tell you.
export const meta = {
  id: 'orgs',
  titleKey: 'route.orgs',
  states: {
    loading: 'orgs-loading',
    empty: 'orgs-empty',
    // NULL, with a reviewed reason in tools/web-route-allowlist.json: resolveOrgs() returns an
    // EMPTY list on a failed seat lookup rather than throwing, so this route renders the empty
    // surface where another would render an error one. Declaring a fabricated error test id
    // would satisfy a dumber gate and describe a screen that cannot exist.
    error: null,
  },
} as const satisfies WebRouteMeta
