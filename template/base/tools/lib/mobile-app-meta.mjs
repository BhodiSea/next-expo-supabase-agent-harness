// tools/lib/mobile-app-meta.mjs — the ONE parser for the mobile app facts the device
// lane needs: the ROUTES manifest (id + path per entry) and the launch identity
// (appId + deep-link scheme). Three consumers — the flow generator, the device e2e
// runner, and the startup measurer — read the SAME two files through this module, so
// a parse quirk can never make them disagree about what the app is.
//
// ROUTES parsing mirrors tools/check-mobile-perf.mjs deliberately (comments stripped,
// the `export const ROUTES = [ … ] as const` literal): the route-manifest gate owns
// full validation; here only ids/paths are lifted. Identity comes from
// tools/identity.lock.json — the expo-policy gate pins the resolved app config to that
// lock, so reading the lock IS reading the app's identity without a config resolution.
// SOURCE: docs/harness/gates-catalog.md (route-manifest; expo-policy identity lock) [corpus: harness/doctrine]
import { readFileSync } from 'node:fs'

/**
 * Strip block + line comments so commented-out entries can never be parsed as routes.
 * @param {string} code
 * @returns {string}
 */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n')
}

/**
 * The ROUTES entries as `{ id, path }` pairs, in manifest order.
 * Throws (callers fail their gate) when the literal is missing or an entry
 * lacks either field — a manifest this module half-reads would let a route
 * silently fall out of the device sweep.
 * @param {string} routesFile
 * @returns {{ id: string, path: string }[]}
 */
export function parseRoutes(routesFile) {
  const code = stripComments(readFileSync(routesFile, 'utf8'))
  const arr = code.match(/export const ROUTES\s*=\s*\[([\s\S]*?)\]\s*as const/)
  if (arr === null) {
    throw new Error(
      `${routesFile} has no \`export const ROUTES = [ … ] as const\` literal — the canonical route manifest is gone`,
    )
  }
  const ids = [...arr[1].matchAll(/\bid:\s*['"]([a-z0-9-]+)['"]/g)].map((m) => m[1])
  const paths = [...arr[1].matchAll(/\bpath:\s*['"]([^'"]*)['"]/g)].map((m) => m[1])
  if (ids.length === 0) {
    throw new Error(`${routesFile}: ROUTES is empty — nothing for the device lane to drive`)
  }
  if (ids.length !== paths.length) {
    throw new Error(
      `${routesFile}: ${String(ids.length)} id field(s) but ${String(paths.length)} path field(s) — every ROUTES entry must carry both`,
    )
  }
  return ids.map((id, i) => ({ id, path: /** @type {string} */ (paths[i]) }))
}

/**
 * The launch identity from tools/identity.lock.json: `appId` (the Android
 * package / iOS bundle id Maestro launches) and `scheme` (the deep-link
 * scheme cold starts and journeys open). Fails loudly on a lock that lost
 * either pin — a device lane guessing its own appId is not a lane.
 * @param {string} lockFile
 * @returns {{ appId: string, scheme: string }}
 */
export function readAppIdentity(lockFile) {
  /** @type {{ appIdentifier?: unknown, scheme?: unknown }} */
  const lock = JSON.parse(readFileSync(lockFile, 'utf8'))
  const appId = lock.appIdentifier
  const scheme = lock.scheme
  if (typeof appId !== 'string' || appId === '' || typeof scheme !== 'string' || scheme === '') {
    throw new Error(
      `${lockFile} carries no appIdentifier/scheme pins — the identity lock is the device lane's launch authority`,
    )
  }
  return { appId, scheme }
}

/**
 * The deep-link URL that opens a route: `scheme://` + the path without its
 * leading slash (expo-router serves `/` at the scheme root).
 * @param {string} scheme
 * @param {string} routePath
 * @returns {string}
 */
export function deepLink(scheme, routePath) {
  return `${scheme}://${routePath.replace(/^\//, '')}`
}
