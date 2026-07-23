import type { Client } from '@app/supabase/client'
import { useSupabase } from '../supabase/provider'
import { type ApiClient, createApiClient } from './client'

// Re-exported so a consumer that needs to NAME the client (a helper taking it as
// a parameter, a test double) reaches for the same door it calls — one import,
// not one for the value and a second, deeper one for its type.
export type { ApiClient } from './client'

// The ONE door from a screen to the API — and the reason it is a door rather
// than a `createApiClient()` call at each call site.
//
// A tRPC client is cheap to construct, so the temptation is to build one per
// hook. That would be wrong for a reason that has nothing to do with cost:
// `httpBatchLink` BATCHES, and batching is a property of a client instance.
// Two clients mean two HTTP requests where one would have carried both
// procedures — so the home screen's notes list and its health probe, fired in
// the same tick, would open two sockets, mint two bearer headers, and lose
// exactly the coalescing the link was chosen for. One client per Supabase
// client is what makes the batch window real.
//
// KEYED ON THE SUPABASE CLIENT, not on nothing. The bearer token is resolved
// per request from the Supabase client captured at construction (see
// ./client.ts), so a cache keyed globally would keep serving the FIRST
// session's client after a sign-out and re-sign-in — requests would carry the
// old user's identity until the app was killed. Keying on the client object
// means a new session gets a new API client by construction.
//
// A WeakMap rather than a Map: the entry dies with the Supabase client it is
// keyed on, so a provider remount (fast refresh, a sign-out that rebuilds the
// tree) does not leave the previous client's transport pinned in memory.
const clients = new WeakMap<Client, ApiClient>()

/**
 * The typed tRPC client for the active session.
 *
 * Deliberately NOT a second React context. `useSupabase()` already resolves
 * through one, and the client is a pure function of what that context holds —
 * a second provider would be a second thing to mount, a second thing to forget
 * to mount in a test, and no additional information.
 */
export function useApi(): ApiClient {
  const supabase = useSupabase()
  let client = clients.get(supabase)
  if (client === undefined) {
    client = createApiClient(supabase)
    clients.set(supabase, client)
  }
  return client
}
