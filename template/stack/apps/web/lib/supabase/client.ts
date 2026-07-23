import type { SupabaseBrowserClient } from '@app/supabase'
import { createBrowserSupabaseClient } from '@app/supabase'

// The browser-side Supabase seam. Import this ONLY from modules that carry (or are reached
// from) a 'use client' boundary — app/(protected)/sign-out-button.tsx is the seeded caller.
// A Server Component importing it would build a client that reads `document.cookie` in a
// context with no document, and the failure surfaces as a hydration mismatch rather than as
// the import mistake it is.
//
// The mirror-image rule to lib/supabase/server.ts: there, a module-scope client is a
// cross-request identity leak; HERE a module-scope client is correct and a per-call client
// is the bug. A browser tab has exactly one user, and @supabase/ssr's browser client owns a
// refresh timer plus an onAuthStateChange subscription. Constructing a second one gives you
// two timers racing to rotate the same refresh token, and Supabase's rotation invalidates
// whichever loses — the "signed out for no reason" report that never reproduces locally.
// The lazy singleton below is the whole defence: one client per tab, created on first use so
// nothing runs during module evaluation on the server render pass.
//
// Key discipline: this client carries the PUBLISHABLE key and nothing else. The service-role
// key is not merely inappropriate here, it is unusable — it bypasses RLS, and anything
// bundled for the browser is public by definition. @app/supabase hardens that seam by never
// exposing the elevated factory on a browser-reachable barrel.
// SOURCE: docs/security/sandbox-and-supply-chain.md (secrets never cross into a shipped
// bundle) docs/harness/README.md
let browserClient: SupabaseBrowserClient | null = null

/** The tab-scoped browser client. Safe to call from any Client Component. */
export function getBrowserClient(): SupabaseBrowserClient {
  browserClient ??= createBrowserSupabaseClient()
  return browserClient
}
