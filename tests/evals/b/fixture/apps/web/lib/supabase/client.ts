import type {
  SupabaseBrowserClient,
  SupabaseCookie,
  SupabaseCookieAdapter,
} from '@app/supabase/client'
import { cookieSessionStorage, createBrowserSupabaseClient } from '@app/supabase/client'

// The browser-side Supabase seam. Import this ONLY from modules that carry (or are reached
// from) a 'use client' boundary — app/(protected)/sign-out-button.tsx is the seeded caller.
// A Server Component importing it would build a client over `document.cookie` in a context
// with no document, and the failure surfaces as a hydration mismatch rather than as the
// import mistake it is.
//
// The mirror-image rule to lib/supabase/server.ts: there, a module-scope client is a
// cross-request identity leak; HERE a module-scope client is correct and a per-call client
// is the bug. A browser tab has exactly one user, and the client owns a refresh timer plus
// an onAuthStateChange subscription. Constructing a second one gives you two timers racing
// to rotate the same refresh token, and Supabase's rotation invalidates whichever loses —
// the "signed out for no reason" report that never reproduces locally.
// The lazy singleton below is the whole defence: one client per tab, created on first use so
// nothing runs during module evaluation on the server render pass.
//
// ─── WHY THIS FILE SUPPLIES A `storage`, AND WHAT HAPPENS WHEN IT DOES NOT ──────────
// THE SESSION MUST LAND SOMEWHERE THE SERVER CAN READ. @supabase/supabase-js persists to
// `localStorage` when no storage is supplied, and localStorage is NOT sent with a request.
// Every server reader on this host — proxy.ts, lib/supabase/server.ts, and the tRPC route's
// cookie branch — reads the session out of the COOKIE JAR. Omit the argument below and the
// two stores are disjoint: sign-in succeeds, the browser believes it holds a session, and
// the protected layout's getVerifiedUser() sees nothing and redirects back to /sign-in. That
// is a sign-in LOOP, not a degraded experience, and it is invisible to any test that never
// completes a successful sign-in.
//
// THE CODEC IS THE PACKAGE'S OWN, deliberately. A session does not fit in one cookie (RFC
// 6265 guarantees only 4096 bytes), so it is chunked — and the chunking is a FORMAT, which
// means the writer and the reader must be the same code or they are two formats. The server
// reassembles with `readChunkedCookie`; this writes with the `cookieWrites` that shares its
// module, so the two cannot drift. Reaching for a second cookie-session library here would
// reintroduce exactly that drift at the one seam where a mismatch reads as "randomly signed
// out" rather than as an error.
// SOURCE: packages/platform/supabase/src/cookies.ts (the shared codec and the 4096-byte
// chunking rationale) · https://www.rfc-editor.org/rfc/rfc6265#section-6.1
//
// Key discipline: this client carries the PUBLISHABLE key and nothing else. The service-role
// key is not merely inappropriate here, it is unusable — it bypasses RLS, and anything
// bundled for the browser is public by definition. @app/supabase hardens that seam by never
// exposing the elevated factory on a browser-reachable barrel.
//
// WHICH IS WHY THE IMPORT IS `@app/supabase/client` AND NOT `@app/supabase`. The `.` barrel
// carries the service-role factory AND server-env.ts, whose schema parses SUPABASE_DB_URL and
// SUPABASE_SERVICE_ROLE_KEY at MODULE LOAD. Pull it into a Client Component and that parse
// runs in the browser, where those variables cannot exist by design — it throws during
// hydration and every interactive page renders "This page couldn't load". The same
// one-barrel-per-surface rule mobile follows (Metro does not tree-shake), for a different
// reason that fails just as hard: it is not that the secret leaks, it is that the module
// asserting the secret exists runs somewhere it never can.
// SOURCE: packages/platform/supabase/src/index.ts (the `.` barrel is the server surface;
// ./client is the browser one)
// SOURCE: docs/security/sandbox-and-supply-chain.md (secrets never cross into a shipped
// bundle) docs/harness/README.md

/**
 * `document.cookie` as the jar this package's codec writes into.
 *
 * WHY `httpOnly` IS ABSENT AND CANNOT BE ADDED. A cookie the browser must both write and
 * read cannot be `HttpOnly` — that attribute exists precisely to make a cookie invisible to
 * script, and a user agent silently ignores it on a `document.cookie` write. This
 * architecture chooses browser-side sign-in (see app/sign-in/sign-in-form.tsx: the password
 * never crosses an extra hop), and the cost of that choice is that the session cookie is
 * script-readable. State it rather than claim otherwise: the mitigations that DO apply are
 * `Secure`, `SameSite`, the CSRF guard on the ambient-credential path
 * (packages/api/src/csrf.ts), and the fact that the token is short-lived and rotates.
 * SOURCE: https://developer.mozilla.org/en-US/docs/Web/HTTP/Cookies#restrict_access_to_cookies
 */
const documentCookieJar: SupabaseCookieAdapter = {
  getAll: (): readonly SupabaseCookie[] =>
    document.cookie
      .split(';')
      .map((pair) => pair.trim())
      .filter((pair) => pair !== '')
      .map((pair) => {
        // Split on the FIRST `=` only: a cookie value is base64-ish and routinely contains
        // `=` padding, and splitting on every one truncates the chunk to its first segment —
        // which reassembles into a JSON prefix that throws inside auth boot.
        const eq = pair.indexOf('=')
        return eq < 0
          ? { name: pair, value: '' }
          : { name: pair.slice(0, eq), value: decodeURIComponent(pair.slice(eq + 1)) }
      }),
  setAll: (cookiesToSet): void => {
    for (const { name, value, options } of cookiesToSet) {
      const parts = [`${name}=${encodeURIComponent(value)}`]
      if (options.path !== undefined) parts.push(`Path=${options.path}`)
      // Max-Age=0 is how a cookie is DELETED; it must survive the falsy check that a bare
      // `if (options.maxAge)` would apply, or expiring a stale chunk silently no-ops and the
      // next read concatenates last week's tail onto this week's head.
      if (options.maxAge !== undefined) parts.push(`Max-Age=${String(options.maxAge)}`)
      if (options.domain !== undefined) parts.push(`Domain=${options.domain}`)
      if (options.sameSite !== undefined) {
        parts.push(
          `SameSite=${options.sameSite.charAt(0).toUpperCase()}${options.sameSite.slice(1)}`,
        )
      }
      if (options.secure === true) parts.push('Secure')
      document.cookie = parts.join('; ')
    }
  },
}

/**
 * `Secure` iff this document was served over TLS.
 *
 * Not a hard-coded `true`: a user agent DROPS a `Secure` cookie set over plain http, so
 * hard-coding it makes `pnpm dev:web` on http://localhost fail to persist a session at all —
 * and the symptom is the same sign-in loop this file exists to prevent, appearing only in
 * development. Deriving it from the scheme means production (https) is hardened and local
 * development still works, with no environment variable to forget.
 */
const secureCookies = (): boolean => window.location.protocol === 'https:'

let browserClient: SupabaseBrowserClient | null = null

/** The tab-scoped browser client. Safe to call from any Client Component. */
export function getBrowserClient(): SupabaseBrowserClient {
  browserClient ??= createBrowserSupabaseClient({
    storage: cookieSessionStorage(documentCookieJar, { secure: secureCookies() }),
  })
  return browserClient
}
