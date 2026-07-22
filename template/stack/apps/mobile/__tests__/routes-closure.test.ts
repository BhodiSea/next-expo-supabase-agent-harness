// ROUTES ↔ app/ closure — the cheap precursor of the route-manifest gate:
// every manifest entry's `file` must exist under app/, so the manifest can
// never name a screen that does not ship (the lie every downstream lane —
// Maestro flows, startup budgets, state sweeps — would inherit silently).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ROUTES } from '../src/routes'

const APP_DIR = join(__dirname, '..', 'app')

describe('route manifest ↔ app/ closure', () => {
  it('every ROUTES entry names an app/ screen file that exists', () => {
    for (const route of ROUTES) {
      const file = join(APP_DIR, `${route.file}.tsx`)
      expect({ id: route.id, file, exists: existsSync(file) }).toEqual({
        id: route.id,
        file,
        exists: true,
      })
    }
  })
})
