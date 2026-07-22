// Route-manifest shape suite (pure; runs under the root vitest unit-node
// project). The file-existence closure lives in __tests__/routes-closure.test.ts
// under jest — it needs the app/ tree on disk; THIS suite pins the invariants
// the manifest's consumers (test lanes, gates) assume about every entry.
import { describe, expect, it } from 'vitest'
import { ROUTES } from './routes'

describe('route manifest shape', () => {
  it('ids are unique, lowercase machine names', () => {
    const ids = ROUTES.map((route) => route.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/)
  })

  it('paths are unique, absolute, and never trail a slash (except root)', () => {
    const paths = ROUTES.map((route) => route.path)
    expect(new Set(paths).size).toBe(paths.length)
    for (const path of paths) {
      expect(path.startsWith('/')).toBe(true)
      if (path !== '/') expect(path.endsWith('/')).toBe(false)
    }
  })

  it('files are app/-relative module paths: no extension, no leading slash', () => {
    for (const route of ROUTES) {
      expect(route.file.startsWith('/')).toBe(false)
      expect(route.file.endsWith('.tsx')).toBe(false)
    }
  })

  it('every state testID is namespaced by its route id — collisions across screens are unconstructable', () => {
    for (const route of ROUTES) {
      expect(route.states.loading).toBe(`${route.id}-loading`)
      expect(route.states.empty).toBe(`${route.id}-empty`)
      expect(route.states.error).toBe(`${route.id}-error`)
    }
  })
})
