import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  assertAuthBootSafety,
  createTokenVerifier,
  STUB_AUDIENCE,
  STUB_ISSUER,
  type TokenVerifier,
} from './verify.js'

const DEV_USER_ID = '11111111-1111-4111-8111-111111111111'
// Entra puts the immutable directory object id in `oid`; `sub` is app-pairwise,
// so a token can legitimately carry two different uuids at once.
const ENTRA_OID = '22222222-2222-4222-8222-222222222222'

const TENANT_ID = 'cafef00d-1111-4222-8333-444444444444'
const ENTRA_AUDIENCE = 'api://harness'
const ENTRA_ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`
const ENTRA_JWKS_URL = `https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`

type Env = Readonly<Record<string, string | undefined>>
type SigningKey = Parameters<SignJWT['sign']>[0]

interface MintOptions {
  iss?: string
  aud?: string
  sub?: string
  exp?: number
  nbf?: number
  claims?: Record<string, unknown>
}

let esPrivateKey: SigningKey
let rsPrivateKey: SigningKey
/** Both public keys, in the shape scripts/mint-dev-token.mjs writes them. */
let jwksKeys: JWK[]
let jwksPath: string

const nowSeconds = () => Math.floor(Date.now() / 1000)

function signToken(
  alg: string,
  kid: string,
  key: SigningKey,
  opts: MintOptions = {},
): Promise<string> {
  const now = nowSeconds()
  const jwt = new SignJWT(opts.claims ?? {})
    .setProtectedHeader({ alg, kid })
    .setIssuer(opts.iss ?? STUB_ISSUER)
    .setAudience(opts.aud ?? STUB_AUDIENCE)
    .setSubject(opts.sub ?? DEV_USER_ID)
    .setIssuedAt(now - 60)
    .setExpirationTime(opts.exp ?? now + 3600)
  if (opts.nbf !== undefined) {
    jwt.setNotBefore(opts.nbf)
  }
  return jwt.sign(key)
}

/** ES256 — what the dev mint script signs with. */
const mint = (opts: MintOptions = {}) => signToken('ES256', 'test-key', esPrivateKey, opts)
/** RS256 — what Entra signs with. */
const mintRs256 = (opts: MintOptions = {}) => signToken('RS256', 'rsa-key', rsPrivateKey, opts)

// Every verifier is CONSTRUCTED INSIDE the test that uses it: a mutant that
// breaks construction must fail a test, not merely blow up a beforeAll hook
// (which vitest reports as skipped tests, i.e. as a surviving mutant).
const stubVerifier = (env: Env = {}): TokenVerifier =>
  createTokenVerifier({ AUTH_MODE: 'stub', DEV_JWKS_PATH: jwksPath, ...env })
const verify: TokenVerifier = (token) => stubVerifier()(token)

/** Serves the tenant JWKS offline; returns the list of URLs jose actually fetched. */
function stubTenantJwks(): string[] {
  const requested: string[] = []
  vi.stubGlobal('fetch', (input: string | URL) => {
    requested.push(String(input))
    return Promise.resolve(
      new Response(JSON.stringify({ keys: jwksKeys }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
  })
  return requested
}

const entraEnv = (env: Env = {}): Env => ({
  AUTH_MODE: 'entra',
  ENTRA_TENANT_ID: TENANT_ID,
  API_AUDIENCE: ENTRA_AUDIENCE,
  ...env,
})

async function writeJwks(prefix: string, keys: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const path = join(dir, 'jwks.json')
  await writeFile(path, JSON.stringify({ keys }))
  return path
}

beforeAll(async () => {
  // Key material only — no production code runs here (see stubVerifier above).
  const es = await generateKeyPair('ES256', { extractable: true })
  const rs = await generateKeyPair('RS256', { extractable: true })
  esPrivateKey = es.privateKey
  rsPrivateKey = rs.privateKey
  jwksKeys = [
    { ...(await exportJWK(es.publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' },
    { ...(await exportJWK(rs.publicKey)), kid: 'rsa-key', alg: 'RS256', use: 'sig' },
  ]
  jwksPath = await writeJwks('dev-auth-test-', jwksKeys)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('stub-mode verification (byte-identical path to entra mode)', () => {
  it('round-trips a token minted against the local JWKS', async () => {
    await expect(verify(await mint())).resolves.toEqual({ userId: DEV_USER_ID })
  })

  it('accepts a token that expired 4 minutes ago (clockTolerance 300s)', async () => {
    await expect(verify(await mint({ exp: nowSeconds() - 240 }))).resolves.toEqual({
      userId: DEV_USER_ID,
    })
  })

  it('rejects a token that expired 6 minutes ago', async () => {
    await expect(verify(await mint({ exp: nowSeconds() - 360 }))).rejects.toThrow()
  })

  it('accepts a token that becomes valid 4 minutes from now', async () => {
    await expect(verify(await mint({ nbf: nowSeconds() + 240 }))).resolves.toEqual({
      userId: DEV_USER_ID,
    })
  })

  it('rejects a token that becomes valid 6 minutes from now', async () => {
    await expect(verify(await mint({ nbf: nowSeconds() + 360 }))).rejects.toThrow()
  })

  it('rejects a wrong audience', async () => {
    await expect(verify(await mint({ aud: 'urn:someone:else' }))).rejects.toThrow()
  })

  it('rejects a wrong issuer', async () => {
    await expect(verify(await mint({ iss: 'urn:someone:else' }))).rejects.toThrow()
  })

  it('rejects a subject that is not a uuid (RLS identity must be a uuid)', async () => {
    await expect(verify(await mint({ sub: 'admin' }))).rejects.toThrow()
  })
})

// The algorithm allowlist is the alg-confusion defence: ES256 is what the dev
// mint script signs, RS256 is what Entra signs, and NOTHING else may verify.
describe('algorithm pinning', () => {
  it('accepts an RS256 token — the algorithm Entra signs with', async () => {
    await expect(verify(await mintRs256())).resolves.toEqual({ userId: DEV_USER_ID })
  })

  it('rejects a token whose alg is outside the allowlist (HS256)', async () => {
    const secret = new TextEncoder().encode('symmetric-secret-that-must-never-verify')
    const token = await signToken('HS256', 'test-key', secret)
    await expect(verify(token)).rejects.toThrow(/not allowed/)
  })

  it('rejects an RS256 token signed by a key outside the JWKS', async () => {
    const impostor = await generateKeyPair('RS256', { extractable: true })
    const token = await signToken('RS256', 'rsa-key', impostor.privateKey)
    await expect(verify(token)).rejects.toThrow()
  })
})

// SOURCE: Entra puts the immutable directory object id in `oid`; `sub` is
// app-pairwise, so `oid` must win whenever it is present [corpus: entra/jwt-verify]
describe('RLS identity claim (oid beats sub)', () => {
  it('prefers oid over sub when both are present', async () => {
    const token = await mint({ sub: DEV_USER_ID, claims: { oid: ENTRA_OID } })
    await expect(verify(token)).resolves.toEqual({ userId: ENTRA_OID })
  })

  it('falls back to sub when no oid claim is present', async () => {
    const token = await mint({ sub: DEV_USER_ID })
    await expect(verify(token)).resolves.toEqual({ userId: DEV_USER_ID })
  })

  it('rejects a non-uuid oid even when sub is a valid uuid', async () => {
    const token = await mint({ sub: DEV_USER_ID, claims: { oid: 'admin' } })
    await expect(verify(token)).rejects.toThrow()
  })
})

describe('stub-mode construction', () => {
  it('defaults to stub mode when AUTH_MODE is unset', async () => {
    const v = createTokenVerifier({ DEV_JWKS_PATH: jwksPath })
    await expect(v(await mint())).resolves.toEqual({ userId: DEV_USER_ID })
  })

  it('pins the audience to API_AUDIENCE when it is set', async () => {
    const v = stubVerifier({ API_AUDIENCE: 'urn:app:custom' })
    await expect(v(await mint({ aud: 'urn:app:custom' }))).resolves.toEqual({ userId: DEV_USER_ID })
    await expect(v(await mint({ aud: STUB_AUDIENCE }))).rejects.toThrow(/aud/)
  })

  it('treats a SET-BUT-EMPTY API_AUDIENCE as unset — an empty aud DISABLES the check', async () => {
    // A bare `API_AUDIENCE=` line in .env yields ''. `??` is nullish-only, so the old
    // `env['API_AUDIENCE'] ?? STUB_AUDIENCE` handed jose `audience: ''` — and jose guards
    // its claim check with `if (audience && ...)`, so an EMPTY audience skips validation
    // entirely and every token verifies whatever its `aud`. That is an auth bypass, and
    // nothing in the suite noticed it. Empty must mean unset, and the default must hold.
    const v = stubVerifier({ API_AUDIENCE: '' })
    await expect(v(await mint({ aud: STUB_AUDIENCE }))).resolves.toEqual({ userId: DEV_USER_ID })
    await expect(v(await mint({ aud: 'urn:attacker:totally-different-api' }))).rejects.toThrow(
      /aud/,
    )
  })

  it('reads the JWKS lazily, once, and keeps verifying after the file disappears', async () => {
    const path = await writeJwks('dev-auth-cache-', jwksKeys)
    const v = createTokenVerifier({ AUTH_MODE: 'stub', DEV_JWKS_PATH: path })
    await expect(v(await mint())).resolves.toEqual({ userId: DEV_USER_ID })
    await rm(path)
    await expect(v(await mint())).resolves.toEqual({ userId: DEV_USER_ID })
  })

  it('tells the developer to mint a dev token when the stub JWKS is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dev-auth-missing-'))
    const v = createTokenVerifier({ AUTH_MODE: 'stub', DEV_JWKS_PATH: join(dir, 'absent.json') })
    await expect(v(await mint())).rejects.toThrow(
      /stub JWKS not found at .*absent\.json — run `pnpm --filter server mint-dev-token` first/,
    )
  })

  it('defaults the stub JWKS path to .dev-auth/jwks.json', async () => {
    const v = createTokenVerifier({ AUTH_MODE: 'stub' })
    await expect(v(await mint())).rejects.toThrow(/stub JWKS not found at \.dev-auth\/jwks\.json/)
  })

  it('rejects a JWKS file whose keys are not JWKs (no kty)', async () => {
    const path = await writeJwks('dev-auth-malformed-', [{ kid: 'test-key', alg: 'ES256' }])
    const v = createTokenVerifier({ AUTH_MODE: 'stub', DEV_JWKS_PATH: path })
    await expect(v(await mint())).rejects.toThrow(/kty/)
  })
})

describe('entra-mode construction (the production path)', () => {
  it('builds a verifier from ENTRA_TENANT_ID + API_AUDIENCE', () => {
    expect(typeof createTokenVerifier(entraEnv())).toBe('function')
  })

  it('falls back to ENTRA_CLIENT_ID when API_AUDIENCE is unset', () => {
    const v = createTokenVerifier({
      AUTH_MODE: 'entra',
      ENTRA_TENANT_ID: TENANT_ID,
      ENTRA_CLIENT_ID: ENTRA_AUDIENCE,
    })
    expect(typeof v).toBe('function')
  })

  it('refuses to build with no audience at all', () => {
    expect(() => createTokenVerifier({ AUTH_MODE: 'entra', ENTRA_TENANT_ID: TENANT_ID })).toThrow(
      /requires API_AUDIENCE \(or ENTRA_CLIENT_ID\) to be set/,
    )
  })

  it('refuses to build with an empty audience', () => {
    expect(() => createTokenVerifier(entraEnv({ API_AUDIENCE: '' }))).toThrow(
      /requires API_AUDIENCE \(or ENTRA_CLIENT_ID\) to be set/,
    )
  })

  it('refuses to build with an empty ENTRA_TENANT_ID', () => {
    expect(() => createTokenVerifier(entraEnv({ ENTRA_TENANT_ID: '' }))).toThrow(
      /requires ENTRA_TENANT_ID to be set/,
    )
  })
})

// The tenant JWKS is served from a stubbed fetch — no network, but the real
// createRemoteJWKSet -> jwtVerify path runs end to end.
describe('entra-mode verification (offline tenant JWKS)', () => {
  it('verifies an RS256 tenant token and takes identity from oid', async () => {
    const requested = stubTenantJwks()
    const v = createTokenVerifier(entraEnv())
    const token = await mintRs256({
      iss: ENTRA_ISSUER,
      aud: ENTRA_AUDIENCE,
      sub: DEV_USER_ID,
      claims: { oid: ENTRA_OID },
    })
    await expect(v(token)).resolves.toEqual({ userId: ENTRA_OID })
    expect(requested).toEqual([ENTRA_JWKS_URL])
  })

  it('rejects a token minted by another tenant (issuer is pinned)', async () => {
    stubTenantJwks()
    const v = createTokenVerifier(entraEnv())
    const token = await mintRs256({
      iss: 'https://login.microsoftonline.com/some-other-tenant/v2.0',
      aud: ENTRA_AUDIENCE,
      claims: { oid: ENTRA_OID },
    })
    await expect(v(token)).rejects.toThrow(/iss/)
  })

  it('rejects a token minted for another audience', async () => {
    stubTenantJwks()
    const v = createTokenVerifier(entraEnv())
    const token = await mintRs256({
      iss: ENTRA_ISSUER,
      aud: 'api://someone-else',
      claims: { oid: ENTRA_OID },
    })
    await expect(v(token)).rejects.toThrow(/aud/)
  })
})

describe('boot safety', () => {
  it('is fatal to boot production with the stub verifier', () => {
    expect(() => {
      assertAuthBootSafety({ NODE_ENV: 'production', AUTH_MODE: 'stub' })
    }).toThrow(/AUTH_MODE=stub is forbidden/)
  })

  it('is fatal to boot production with AUTH_MODE unset (stub is the default)', () => {
    expect(() => {
      assertAuthBootSafety({ NODE_ENV: 'production' })
    }).toThrow(/AUTH_MODE=stub is forbidden/)
  })

  it('allows production with entra and dev with stub', () => {
    expect(() => {
      assertAuthBootSafety({ NODE_ENV: 'production', AUTH_MODE: 'entra' })
    }).not.toThrow()
    expect(() => {
      assertAuthBootSafety({ NODE_ENV: 'development', AUTH_MODE: 'stub' })
    }).not.toThrow()
  })

  it('rejects unknown AUTH_MODE values at verifier construction', () => {
    expect(() => createTokenVerifier({ AUTH_MODE: 'none' })).toThrow(/unknown AUTH_MODE/)
  })

  it('requires tenant configuration in entra mode', () => {
    expect(() => createTokenVerifier({ AUTH_MODE: 'entra' })).toThrow(/ENTRA_TENANT_ID/)
  })
})
