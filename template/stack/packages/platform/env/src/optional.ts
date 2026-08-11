import { z } from 'zod'
import type { EnvSource } from './client.js'
import { parseEnvOrThrow } from './client.js'

// ---------------------------------------------------------------------------
// @app/env/optional — the OPTIONAL server section. Class (a′): values a
// deployment MAY set, still read through the register.
//
// WHY A THIRD FILE, not more lines in ./index.ts. The server barrel parses
// EAGERLY and its schema is fail-fast REQUIRED — importing it anywhere makes
// that process demand the elevated Supabase key at boot. The web app must
// never hold that key (service-role confinement), yet it has optional server
// configuration of its own (the Upstash pair, deploy metadata). A separate
// subpath gives it the register without the secrets: importing this file
// validates ONLY the optional section.
//
// OPTIONAL ≠ UN-SEEN. Before 0.9.5 the Upstash pair was read straight off
// process.env in apps/web with the argument that an optional value has no
// place in a fail-fast schema. Both halves of that were true and the
// conclusion still wrong: the token is a value whose disclosure is an
// incident, and the register is the one module whose job is to see every
// server variable. `.optional()` is how a schema says "may be absent" without
// saying "may be invisible". The narrow ambient type below keeps the other
// property too: the only variables this file CAN read are the ones named
// here, so a new value joins the environment as a reviewed schema line.
//
// This section parses at MODULE SCOPE like ./index.ts and for the same
// reason: one artifact, one environment, known at import time — a
// half-configured pair stops the process at boot instead of degrading it
// silently at whatever hour the first rate-limited request arrives.
// SOURCE: docs/security/sandbox-and-supply-chain.md (secrets never cross into
// a shipped bundle) docs/harness/README.md
// ---------------------------------------------------------------------------

declare const process: {
  readonly env: {
    readonly UPSTASH_REDIS_REST_TOKEN?: string
    readonly UPSTASH_REDIS_REST_URL?: string
    readonly APP_VERSION?: string
    readonly MIN_SUPPORTED_CLIENT?: string
  }
}

/**
 * (a′) The optional server class.
 *
 * Every entry is `.optional()` — absence is a supported configuration — and
 * every PRESENT value is validated: an optional section that accepted garbage
 * would be a register in name only.
 */
export const OptionalServerEnvSchema = z
  .object({
    /**
     * The Redis-backed rate limiter's credential pair. Absent = the in-process
     * fallback limiter, loudly (see apps/web/lib/rate-limit-runtime.ts). The
     * token's disclosure is an incident — it is never logged, echoed, or put on
     * a response, same discipline as the required class.
     */
    UPSTASH_REDIS_REST_TOKEN: z
      .string()
      .min(1, 'is set but empty — unset it entirely, or paste the real token')
      .optional(),
    UPSTASH_REDIS_REST_URL: z
      .string()
      .regex(
        /^https:\/\/\S+$/,
        'must be the https:// Upstash REST endpoint (it is unset if this is empty)',
      )
      .optional(),
    /**
     * Deploy-set override for the version-skew guard's server version; unset,
     * the API host falls back to its own package.json version (the route
     * documents the ladder). @app/api parses it once and rejects an
     * unparseable value loudly — the register checks presence-shape only.
     */
    APP_VERSION: z.string().min(1, 'is set but empty — unset it, or set a real version').optional(),
    /**
     * The minimum-supported-client floor for the skew guard; unset leaves the
     * floor inert (see @app/api isBelowMinimum).
     */
    MIN_SUPPORTED_CLIENT: z
      .string()
      .min(1, 'is set but empty — unset it, or set a real version floor')
      .optional(),
  })
  .superRefine((value, ctx) => {
    // Both-or-neither: half a Redis configuration is a MISCONFIGURATION, not an
    // optional feature. Before this check a typo'd URL name silently degraded
    // the limiter to per-process on every instance — a production deploy that
    // lost distributed limiting while looking healthy on every dashboard.
    const token = value.UPSTASH_REDIS_REST_TOKEN !== undefined
    const url = value.UPSTASH_REDIS_REST_URL !== undefined
    if (token !== url) {
      ctx.addIssue({
        code: 'custom',
        path: [token ? 'UPSTASH_REDIS_REST_URL' : 'UPSTASH_REDIS_REST_TOKEN'],
        message:
          'is missing while its pair is set — the Upstash credentials work only as a pair. ' +
          'Set both to enable the Redis limiter, or neither to accept the in-process fallback.',
      })
    }
  })

/** The parsed optional server environment. */
export type OptionalServerEnv = z.infer<typeof OptionalServerEnvSchema>

/** The inlining-free optional reads. Named one per line, like every reader here. */
export function readOptionalServerEnv(): EnvSource {
  return {
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    APP_VERSION: process.env.APP_VERSION,
    MIN_SUPPORTED_CLIENT: process.env.MIN_SUPPORTED_CLIENT,
  }
}

/** Parse (a′). Pure in its argument, so boot behaviour is testable. */
export function parseOptionalServerEnv(source: EnvSource = readOptionalServerEnv()): OptionalServerEnv {
  return parseEnvOrThrow(OptionalServerEnvSchema, source, 'server-optional')
}

/**
 * The optional server environment, parsed at import. A frozen record: by the
 * time any code reads this binding, every PRESENT value has been proven valid
 * and the pair invariant has held.
 */
export const optionalServerEnv: OptionalServerEnv = parseOptionalServerEnv()
