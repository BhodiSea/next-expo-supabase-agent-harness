// ---------------------------------------------------------------------------
// @app/push — the device push-token vertical (push-notifications module).
//
// Copied from the @app/notes shape, so the same laws hold:
//
//   src/domain/   pure functions — the deterministic row id (push-token-id.ts)
//                 and the keyset cursor codec (cursor.ts). No IO, no client.
//   src/data/     the DAL. Takes a client, returns DTOs, never rows, never
//                 throws for a domain failure.
//
// One rule this package obeys structurally: a vertical MUST NOT import another
// vertical (dependency-cruiser's `verticals-not-into-verticals`). That is why the
// keyset codec is duplicated here rather than imported from @app/notes — see the
// README's honest limits for the packages/shared promotion that would remove the
// copy.
//
// Dependencies are downward only: @app/contracts (wire shapes) and @app/errors
// (the outcome kernel). The DAL consumes a client, it never constructs one.
//
// There is deliberately NO ./client barrel: registering and deregistering a token
// are WRITES, so the mobile app reaches them through the tRPC client
// (push.registerToken / push.removeToken mutations), not a direct-read barrel.
// ---------------------------------------------------------------------------

export {
  type PushTokensDatabase,
  type PushTokenWriteContext,
  registerToken,
  listTokens,
  removeToken,
} from './data/push-tokens.js'
// The keyset codec. The server mints cursors and clients hold them, so both
// surfaces may need to read one back.
export { decodePushCursor, encodePushCursor, type PushCursor } from './domain/cursor.js'
