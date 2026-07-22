// Dev-auth signing core for AUTH_MODE=stub — the ONE place stub tokens are
// minted. Shared by the CLI minter (scripts/mint-dev-token.ts) and the
// POST /auth/dev-token route (src/auth/dev-token.ts), so key shape and claims
// cannot drift between the two. Never reachable in production:
// assertAuthBootSafety (called from src/index.ts before the port binds) makes
// NODE_ENV=production + a stub verifier a boot fatal.
//
// Key posture, identical to the original CLI minter: a fresh ES256 keypair per
// signer, the PUBLIC half merged into the stub JWKS file, the PRIVATE half held
// in memory only — it is never persisted anywhere.
// SOURCE: jose SignJWT + local JWKS mirror the remote Entra verification path
// with local keys [corpus: entra/jwt-verify]
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { SignJWT } from 'jose'
import { z } from 'zod'
import { STUB_AUDIENCE, STUB_ISSUER } from './verify.js'

/** The seeded demo user the CLI minter signs for (matches tests/rls USER_A). @public — script/test seam. */
export const DEV_USER_ID = '11111111-1111-4111-8111-111111111111'
/** One working day; re-mint to refresh. @public — script/test seam. */
export const DEV_TOKEN_TTL_SECONDS = 8 * 60 * 60

// Rotating window: every signer (a CLI run, a server boot that mints) adds ONE
// public key, so a long-lived .dev-auth would otherwise grow without bound.
// Keeping the newest few means tokens minted by a recent CLI run or a previous
// server boot keep verifying while the file stays bounded.
const MAX_JWKS_KEYS = 5

// Tolerant read: the JWKS file is regenerable dev state, so absent OR corrupt
// both mean "start a fresh key list" rather than a crash.
const JwksFileDto = z.object({ keys: z.array(z.looseObject({ kty: z.string() })) })

function existingKeys(jwksPath: string): Record<string, unknown>[] {
  let raw: string
  try {
    raw = readFileSync(jwksPath, 'utf8')
  } catch {
    return []
  }
  try {
    return JwksFileDto.parse(JSON.parse(raw)).keys
  } catch {
    return []
  }
}

export interface DevSigner {
  /** Key id of this signer's keypair (present in the JWKS it wrote). */
  readonly kid: string
  /** Where the public JWKS landed — the same path the stub verifier reads. */
  readonly jwksPath: string
  /** Sign a stub JWT for `sub` (default: a fresh uuid). */
  mint(sub?: string): Promise<{ token: string; userId: string }>
}

/**
 * Create a signer: generate an ES256 keypair, merge the public JWK into the
 * stub JWKS at `jwksPath` (creating the directory when absent — exactly how
 * the CLI minter bootstraps .dev-auth), and return a mint function bound to
 * the in-memory private key.
 */
export function createDevSigner(jwksPath: string): DevSigner {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const kid = randomUUID()
  const publicJwk = publicKey.export({ format: 'jwk' })
  const keys = [...existingKeys(jwksPath), { ...publicJwk, kid, alg: 'ES256', use: 'sig' }].slice(
    -MAX_JWKS_KEYS,
  )
  mkdirSync(dirname(jwksPath), { recursive: true })
  writeFileSync(jwksPath, `${JSON.stringify({ keys }, null, 2)}\n`)

  return {
    kid,
    jwksPath,
    async mint(sub = randomUUID()) {
      const now = Math.floor(Date.now() / 1000)
      // Claims identical to the original CLI minter: iss/aud pinned to the
      // verifier's STUB_ISSUER/STUB_AUDIENCE, identity in `sub` (stub tokens
      // carry the user uuid there; only Entra tokens use `oid`).
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid })
        .setIssuer(STUB_ISSUER)
        .setAudience(STUB_AUDIENCE)
        .setSubject(sub)
        .setIssuedAt(now)
        .setExpirationTime(now + DEV_TOKEN_TTL_SECONDS)
        .sign(privateKey)
      return { token, userId: sub }
    },
  }
}
