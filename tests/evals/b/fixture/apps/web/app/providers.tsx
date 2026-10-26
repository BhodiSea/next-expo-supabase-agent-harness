'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useState } from 'react'

// The client-side provider island. It exists so the root layout does NOT have to be a Client
// Component: everything the browser genuinely needs lives here, and the shell above it stays
// on the server where it costs no bundle.
//
// Reads on this surface are React Server Components (lib/app-data/*) — they need no query
// cache at all. The cache is here for the CLIENT half: mutations invoked from interactive
// components, and any future tRPC-over-HTTP subscription a client component opens against the
// same router apps/mobile uses. Wiring it once at the root is what keeps a component from
// quietly instantiating its own.

// The QueryClient is created INSIDE the component, in useState, and that placement is the
// entire point of this file.
//
// A module-scope `const queryClient = new QueryClient()` is the single most common bug in
// SSR React Query setups, and it is a data leak rather than a performance problem: on the
// server the module is evaluated once per process, so one cache would be shared by every
// concurrent request the server is rendering — user A's fetched rows served into user B's
// HTML. useState's initializer runs once per component INSTANCE, which on the server means
// once per request and in the browser means once per tab, surviving re-renders. Both halves
// are required; either alone is broken.
// SOURCE: docs/security/sandbox-and-supply-chain.md (no cross-request shared state on the
// server) docs/harness/README.md
export function Providers({ children }: { readonly children: ReactNode }): ReactNode {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // A short window, not zero and not minutes. Zero refetches on every mount and
            // makes React's development double-render look like a network storm; long values
            // show a user their own stale writes after a mutation. Thirty seconds is long
            // enough to absorb navigation, short enough that nothing looks frozen.
            // SOURCE: docs/harness/README.md (tuning constants are stated, not defaulted)
            staleTime: 30_000,
            // Refetching whenever a window regains focus is a sensible default for a
            // dashboard and a wasteful one for a form the user tabbed away from mid-edit.
            // Off globally; opt in per query where freshness actually matters.
            refetchOnWindowFocus: false,
          },
        },
      }),
  )

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}
