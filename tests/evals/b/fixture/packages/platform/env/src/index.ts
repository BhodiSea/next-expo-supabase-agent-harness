import { z } from 'zod'
import type { EnvSource, WebPublicEnv } from './client.js'
import { parseEnvOrThrow, parseWebPublicEnv } from './client.js'

// ---------------------------------------------------------------------------
// @app/env — THE SERVER BARREL. Class (a): the secrets.
//
// It re-exports ./client (so a server module needs one import for the whole
// environment) and adds the parser for the variables that must never reach a
// bundle. The census in tools/exports-walls.json is what keeps that true:
// apps/mobile may import `@app/env/client` and may NOT import this file, and
// that rule is checked, not remembered.
//
// WHY THE SECRETS ARE A SEPARATE FILE RATHER THAN A SEPARATE FIELD.
// A bundler ships what the import graph reaches. If the service-role key were a
// field on an object this module also exported to clients, the string would be
// in the graph, and every defence after that point — a runtime branch, a
// getter, a `delete` — would be a defence against reading it, not against
// SHIPPING it. The value is already in the file the user downloaded. Splitting
// the parse across two files is the only version of this wall that a build tool
// enforces on your behalf.
//
// WHY THIS FILE PARSES EAGERLY AND ./client DOES NOT.
// This barrel is only ever evaluated by a process the operator runs — one
// artifact, one environment, known at import time. So the parse happens at
// MODULE SCOPE: importing @app/env anywhere on the server validates the whole
// server-side environment exactly once, at boot, and a missing variable stops
// the process before it can accept a request. ./client is bundled into two
// different artifacts that carry disjoint variable sets, which is why its
// parsers are functions the entry module calls (see the note there).
//
// The accepted cost, stated rather than discovered: a build that imports this
// package needs the server environment present. That is the point — a
// deployment which boots without its secrets does not fail at boot, it fails in
// a user's request, as a 500 with no obvious cause, at whatever hour the first
// person hits the one path that reads the missing value.
// SOURCE: docs/security/sandbox-and-supply-chain.md (secrets never cross into a
// shipped bundle; the elevated credential is server-only) docs/harness/README.md
// ---------------------------------------------------------------------------

export * from './client.js'

// Server-side reads are ordinary runtime lookups — nothing inlines them, since
// nothing bundles this file. The local declaration is still narrow on purpose:
// with an empty ambient type list, the only variables this package CAN read are
// the ones named here, so a new secret cannot be smuggled in by a call site and
// must be added to the schema below where a reviewer sees it.
declare const process: {
  readonly env: {
    readonly SUPABASE_SERVICE_ROLE_KEY?: string
    readonly SUPABASE_DB_URL?: string
  }
}

/**
 * A Postgres connection string. Checked for scheme only — the rest of a DSN is
 * host-specific (pooler ports, sslmode, connection parameters) and a stricter
 * pattern would reject a valid pooled URL on the day the platform changes it.
 *
 * This value carries a password in its authority component, so it is NEVER
 * logged, echoed into an error, or put on a response — not even as a field named
 * something harmless. @app/observability redacts by key NAME, which catches a
 * field called `password` or `token` and cannot see a credential buried inside a
 * URL. That net is the last one, not the first: the first is this rule.
 */
const PostgresUrl = z
  .string()
  .regex(
    /^postgres(?:ql)?:\/\/\S+$/,
    'must be a postgres:// or postgresql:// connection string (it is unset if this is empty)',
  )

/**
 * (a) The server-only class.
 *
 * Kept deliberately short. Every entry here is a value whose disclosure is an
 * incident, so the schema is also the review surface: adding a line is a
 * decision somebody has to justify, and a long list is a list nobody reads.
 */
export const ServerEnvSchema = z.object({
  /**
   * The elevated key. It BYPASSES row security entirely — a request made with it
   * is not "an admin request", it is every tenant's data with no policy between
   * the query and the rows. It exists for migrations, scheduled jobs, and the
   * few writes that must cross a tenant boundary deliberately.
   *
   * Length-checked, not format-checked, for the same reason as the publishable
   * key: this project has shipped more than one key spelling, and a gate that
   * reds on a valid credential is a gate that gets deleted.
   */
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(
      20,
      'is empty or truncated — this is the elevated, row-security-bypassing key; a partial ' +
        'paste fails later as an authorization error that looks like a policy bug',
    ),
  /** Direct database access for migrations and the test harness. Password-bearing. */
  SUPABASE_DB_URL: PostgresUrl,
})

/** The parsed server-only environment. */
export type ServerEnv = z.infer<typeof ServerEnvSchema>

/** The inlining-free server reads. Named one per line for the same reason as ./client. */
export function readServerEnv(): EnvSource {
  return {
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_DB_URL: process.env.SUPABASE_DB_URL,
  }
}

/**
 * Parse (a). Pure in its argument, like every other parser here, so the boot
 * behaviour can be tested without mutating the host process.
 */
export function parseServerEnv(source: EnvSource = readServerEnv()): ServerEnv {
  return parseEnvOrThrow(ServerEnvSchema, source, 'server-only (secrets)')
}

/**
 * The paste-the-wrong-key check.
 *
 * The elevated key and the publishable key are two opaque strings from the same
 * dashboard page, one line apart, and the failure mode of confusing them is
 * silent in the worst possible direction: everything WORKS. Row security is
 * bypassed rather than violated, so no request errors, no policy denies, no test
 * reds — and the elevated key is now inlined into the web bundle, where it is
 * public, permanent (see the recall note in ./client) and grants every row.
 *
 * Equality is the whole check. It cannot detect an elevated key pasted into a
 * public name that differs from the one configured here, which is exactly why
 * the NAME-shape rule exists alongside it; this catches the specific, common
 * accident that the name rule cannot see.
 */
function assertKeysAreDistinct(server: ServerEnv, web: WebPublicEnv): void {
  if (server.SUPABASE_SERVICE_ROLE_KEY !== web.NEXT_PUBLIC_SUPABASE_PUBLISHABLE) return
  throw new Error(
    '@app/env: NEXT_PUBLIC_SUPABASE_PUBLISHABLE holds the SAME value as ' +
      'SUPABASE_SERVICE_ROLE_KEY. The elevated key bypasses row security and a NEXT_PUBLIC_ ' +
      'name is compiled into the bundle served to every browser — this deployment would hand ' +
      'every tenant read and write access to every other. Rotate the elevated key (the value ' +
      'has to be assumed leaked) and set the PUBLISHABLE key here instead.',
  )
}

/**
 * The server-only environment, parsed at import.
 *
 * A frozen record, not a getter and not a promise: by the time any code can read
 * this binding, the environment has already been proven complete.
 */
export const serverEnv: ServerEnv = parseServerEnv()

/**
 * The web-public environment, parsed at import ON THE SERVER TOO.
 *
 * The server renders the same values it inlines into the browser bundle, so it
 * must agree with the browser about them. Validating here means one boot check
 * covers the whole server-side surface, and it is what makes the cross-check
 * below possible at all — it needs both classes in hand at the same moment,
 * which only ever happens on the server.
 */
export const webEnv: WebPublicEnv = parseWebPublicEnv()

assertKeysAreDistinct(serverEnv, webEnv)
