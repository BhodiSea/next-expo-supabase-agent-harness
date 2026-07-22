// Dev-only AccessTokenProvider over the API server's stub authority.
//
// POST /auth/dev-token — registered by the server ONLY when its resolved auth
// mode is stub (apps/server/src/auth/dev-token.ts): `{ sub? }` -> 201
// `{ token, userId }`. The minted JWT lands in the platform keychain via
// src/host and is replayed per request by the api-client one-door.

import { secureDeleteToken, secureGetToken, secureSetToken } from '../../host'
import { apiPost } from '../../lib/api-client'
import type { AccessTokenProvider } from '../session'

interface DevTokenResponse {
  readonly token: string
  readonly userId: string
}

// Hand-rolled shape check (no zod dep in the app; @app/contracts carries the
// wire DTOs, and dev tooling is deliberately outside the committed contract —
// same reasoning as the server registering this route off the OpenAPI surface).
function parseDevToken(value: unknown): DevTokenResponse {
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    const token = record['token']
    const userId = record['userId']
    if (typeof token === 'string' && token !== '' && typeof userId === 'string') {
      return { token, userId }
    }
  }
  throw new Error('dev-token response did not carry { token, userId }')
}

export function createStubProvider(): AccessTokenProvider {
  if (!__DEV__) {
    // A stub session mints credentials with zero user interaction — in a
    // release binary that is an auth bypass, not a convenience. The server
    // enforces the mirror-image invariant (stub mode is a boot fatal under
    // NODE_ENV=production); this throw keeps a misconfigured CLIENT build
    // equally loud instead of quietly authenticated against a dev authority.
    throw new Error('stub auth provider is dev-only (__DEV__); Entra lands in W4')
  }
  return {
    getAccessToken: () => secureGetToken(),
    signIn: async (hint?: string): Promise<void> => {
      // hint = optional subject uuid: the server mints a fresh uuid per token
      // when absent; pinning one keeps a dev user's data across reinstalls.
      const response = await apiPost('/auth/dev-token', hint === undefined ? {} : { sub: hint }, {
        auth: false,
      })
      const { token } = parseDevToken(await response.json())
      await secureSetToken(token)
    },
    signOut: () => secureDeleteToken(),
  }
}
