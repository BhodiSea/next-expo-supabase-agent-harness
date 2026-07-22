// Dev-auth CLI minter for AUTH_MODE=stub (never used in production — the
// server refuses to boot with the stub verifier when NODE_ENV=production).
// Run via `pnpm --filter server mint-dev-token` (tsx, like openapi:emit).
//
// Thin wrapper over the shared signing core (src/auth/dev-auth.ts) — the same
// module the POST /auth/dev-token route uses, so CLI-minted and route-minted
// tokens are byte-identically shaped and verify against the same JWKS. Writes
// the PUBLIC key to apps/server/.dev-auth/jwks.json (gitignored; the private
// key is never persisted) and prints a signed dev JWT for the seeded demo user.
import { fileURLToPath } from 'node:url'
import { createDevSigner, DEV_TOKEN_TTL_SECONDS, DEV_USER_ID } from '../src/auth/dev-auth.js'

const jwksPath = fileURLToPath(new URL('../.dev-auth/jwks.json', import.meta.url))
const signer = createDevSigner(jwksPath)
const { token } = await signer.mint(DEV_USER_ID)

console.log(`wrote ${jwksPath}`)
console.log(
  `dev token for user ${DEV_USER_ID} (expires in ${String(DEV_TOKEN_TTL_SECONDS / 3600)}h):`,
)
console.log(token)
