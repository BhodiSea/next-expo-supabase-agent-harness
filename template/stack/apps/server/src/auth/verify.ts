import { readFileSync } from 'node:fs'
// SOURCE: jose is the reference JOSE implementation for Node — jwtVerify with
// pinned algorithms + JWKS key resolvers is the verification path for both
// auth modes [corpus: entra/jwt-verify]
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from 'jose'
import { z } from 'zod'

export type TokenVerifier = (token: string) => Promise<{ userId: string }>

// Stub-mode token identity. The dev-auth signing core (src/auth/dev-auth.ts —
// shared by the CLI minter and the POST /auth/dev-token route) imports these,
// so mint and verify can never drift.
/** @public consumed by dev-auth.ts and the unit-test mint flow (verify.test.ts) */
export const STUB_ISSUER = 'urn:app:dev-auth'
/** @public consumed by dev-auth.ts and the unit-test mint flow (verify.test.ts) */
export const STUB_AUDIENCE = 'urn:app:api'

type Env = Readonly<Record<string, string | undefined>>

// SOURCE: jose resolves signing keys through a JWKS key-getter; local (stub) and
// remote (Entra) sets share the resolver shape, which is what lets both modes run
// the byte-identical jwtVerify path below [corpus: entra/jwt-verify]
type JwksKeyGetter = ReturnType<typeof createLocalJWKSet>

// z.guid(), not z.uuid(): postgres accepts any 8-4-4-4-12 hex uuid, and the
// seeded dev user (11111111-…) has no RFC-4122 variant bits — strict z.uuid()
// would reject it.
const UuidDto = z.guid()

const JwksFileDto = z.object({
  keys: z.array(z.looseObject({ kty: z.string() })),
})

export type AuthMode = 'stub' | 'entra'

/**
 * Env lookup that treats a SET-BUT-EMPTY variable as ABSENT.
 *
 * A bare `API_AUDIENCE=` line in a .env file yields `''`, and `??` is nullish-only —
 * so a plain `env['API_AUDIENCE'] ?? STUB_AUDIENCE` would hand jose `audience: ''`.
 * jose guards its claim check with `if (audience && ...)`, so an empty string SKIPS
 * audience validation entirely and every token verifies whatever its `aud`. Empty is
 * unset, everywhere, or the fallback silently becomes a bypass.
 * SOURCE: MS Entra ID access-token validation — aud must be pinned, never optional [corpus: entra/jwt-verify]
 */
function envValue(env: Env, name: string): string | undefined {
  const value = env[name]
  // No `value === undefined ||` disjunct: when the var is unset the else-branch already
  // yields `undefined`. Empty is the only case that needs mapping.
  return value === '' ? undefined : value
}

/**
 * The single place AUTH_MODE is read and validated — the boot guard, the
 * verifier factory, and createApp's dev-token-route wiring all share it.
 */
export function resolveAuthMode(env: Env): AuthMode {
  const mode = envValue(env, 'AUTH_MODE') ?? 'stub'
  if (mode !== 'stub' && mode !== 'entra') {
    throw new Error(`unknown AUTH_MODE: ${mode} (expected "stub" or "entra")`)
  }
  return mode
}

/**
 * The single place the stub JWKS location is resolved — the stub verifier reads
 * it and the dev-token route (src/auth/dev-token.ts) writes it, so the two can
 * never disagree about where the key material lives.
 */
export function resolveDevJwksPath(env: Env): string {
  return envValue(env, 'DEV_JWKS_PATH') ?? '.dev-auth/jwks.json'
}

/**
 * Boot-time guard, called from src/index.ts before the server binds a port.
 * The stub verifier trusts locally minted keys, so reaching it in production
 * would be an authentication bypass.
 */
export function assertAuthBootSafety(env: Env): void {
  // SOURCE: harness doctrine — a stub verifier reachable in production is an auth
  // bypass; fail the boot loudly instead of logging a warning [corpus: harness/doctrine]
  if (env['NODE_ENV'] === 'production' && resolveAuthMode(env) !== 'entra') {
    throw new Error(
      'FATAL: AUTH_MODE=stub is forbidden when NODE_ENV=production — set AUTH_MODE=entra and configure ENTRA_TENANT_ID + API_AUDIENCE',
    )
  }
}

function requireEnv(env: Env, name: string): string {
  const value = envValue(env, name)
  if (value === undefined) {
    throw new Error(`AUTH_MODE=entra requires ${name} to be set`)
  }
  return value
}

function buildVerifier(getKey: JwksKeyGetter, issuer: string, audience: string): TokenVerifier {
  return async (token) => {
    // SOURCE: MS Entra ID access-token validation — pin issuer + audience and allow only
    // the expected asymmetric algorithms (never HS*/none); clockTolerance 300s absorbs
    // client clock drift without widening the replay window [corpus: entra/jwt-verify]
    const { payload } = await jwtVerify(token, getKey, {
      issuer,
      audience,
      algorithms: ['ES256', 'RS256'],
      clockTolerance: 300, // SOURCE: ±300s drift absorption [corpus: entra/jwt-verify]
    })
    // SOURCE: Entra puts the immutable directory object id in `oid` (`sub` is
    // app-pairwise); stub tokens carry the user uuid in `sub`. Either way the RLS
    // identity must be a uuid — reject anything else [corpus: entra/jwt-verify]
    const userId = UuidDto.parse(payload['oid'] ?? payload.sub)
    return { userId }
  }
}

/**
 * Builds the token verifier for the configured AUTH_MODE. Both modes run the
 * byte-identical jwtVerify path above — only the key source and the pinned
 * issuer/audience differ.
 *
 * - `stub` (default): local JWKS minted by `scripts/mint-dev-token.mjs`
 *   (`.dev-auth/jwks.json`, gitignored). Read lazily so importing the app —
 *   e.g. for OpenAPI emission — needs no key material.
 * - `entra`: remote JWKS from the tenant discovery endpoint.
 */
export function createTokenVerifier(env: Env): TokenVerifier {
  const mode = resolveAuthMode(env)

  if (mode === 'entra') {
    const tenantId = requireEnv(env, 'ENTRA_TENANT_ID')
    const audience = envValue(env, 'API_AUDIENCE') ?? envValue(env, 'ENTRA_CLIENT_ID')
    if (audience === undefined) {
      throw new Error('AUTH_MODE=entra requires API_AUDIENCE (or ENTRA_CLIENT_ID) to be set')
    }
    // SOURCE: Entra v2.0 tokens — issuer is https://login.microsoftonline.com/{tenant}/v2.0
    // and signing keys come from the tenant JWKS discovery endpoint; createRemoteJWKSet
    // caches and re-fetches on unknown kid (key rollover) [corpus: entra/jwt-verify]
    const getKey = createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`),
    )
    return buildVerifier(getKey, `https://login.microsoftonline.com/${tenantId}/v2.0`, audience)
  }

  const jwksPath = resolveDevJwksPath(env)
  let localJwks: JwksKeyGetter | undefined
  const getKey: JwksKeyGetter = (protectedHeader, token) => {
    if (localJwks === undefined) {
      let raw: string
      try {
        raw = readFileSync(jwksPath, 'utf8')
      } catch {
        throw new Error(
          `stub JWKS not found at ${jwksPath} — run \`pnpm --filter server mint-dev-token\` first`,
        )
      }
      const parsed: unknown = JSON.parse(raw)
      // SOURCE: createLocalJWKSet mirrors the remote Entra key source so stub mode
      // exercises the same verification path with local keys [corpus: entra/jwt-verify]
      localJwks = createLocalJWKSet(JwksFileDto.parse(parsed))
    }
    return localJwks(protectedHeader, token)
  }
  return buildVerifier(getKey, STUB_ISSUER, envValue(env, 'API_AUDIENCE') ?? STUB_AUDIENCE)
}
