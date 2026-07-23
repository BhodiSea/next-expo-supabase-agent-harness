import { type AppError, appError } from '@app/errors'
import type { PostgrestFailure } from './port.js'
import { NOTES_TABLE } from './rows.js'

// ---------------------------------------------------------------------------
// THE kernel seam: the only file in this vertical that BUILDS an `AppError`.
//
// Everywhere else a failure is a value produced here and returned unchanged. If
// the taxonomy grows a kind, or a constructor's options change, this file is the
// diff — not forty call sites spread across the DAL, the router and the tests.
//
// The envelope itself is @app/errors' doctrine, restated because it is the rule
// this whole layer exists to keep: a domain failure travels on the DATA channel
// as a value, never as a throw. A throw crossing the transport is flattened by
// the transport, the `kind` discriminant becomes prose, and the exhaustive
// switch on the other side degrades into string sniffing no compiler checks.
//
// NOTE ON DUPLICATION: @app/supabase owns a general `mapPostgresError` for the
// SQLSTATE-to-kind half of this. What CANNOT live there is everything below that
// depends on knowing which OPERATION ran — above all the read/write asymmetry,
// which is a vertical's judgement call about its own data, not a driver detail.
// ---------------------------------------------------------------------------

/** What the caller was doing. Appears in developer-facing messages and codes only. */
export type NoteOperation = 'create' | 'delete' | 'list' | 'read' | 'update'

// ---------------------------------------------------------------------------
// SQLSTATE classes and PostgREST codes.
// SOURCE: https://www.postgresql.org/docs/current/errcodes-appendix.html
// SOURCE: https://docs.postgrest.org/en/v12/references/errors.html
// ---------------------------------------------------------------------------

/** RLS refused a WRITE: the row failed a policy's USING / WITH CHECK clause. */
const INSUFFICIENT_PRIVILEGE = '42501'
/** A uniqueness constraint rejected the row. */
const UNIQUE_VIOLATION = '23505'
/** A referenced row is gone — a race with a concurrent delete, not a client error. */
const FOREIGN_KEY_VIOLATION = '23503'
/** A CHECK constraint rejected the row: the table's bound disagreed with the contract's. */
const CHECK_VIOLATION = '23514'
/** PostgREST could not satisfy a single-row expectation. */
const PGRST_NO_ROWS = 'PGRST116'
/** PostgREST rejected the JWT (expired, wrong key, malformed). */
const PGRST_BAD_JWT = 'PGRST301'

/**
 * SQLSTATE classes where retrying the identical request is a sane response:
 * 08 connection exception, 53 insufficient resources, 57 operator intervention.
 * Everything else that is unrecognised is a bug report, not a retry hint —
 * telling a client to retry a permanent failure just multiplies the load that
 * caused it.
 */
const RETRYABLE_CLASSES: ReadonlySet<string> = new Set(['08', '53', '57'])

/**
 * The critical asymmetry, and the reason this is a named function rather than
 * four inline branches:
 *
 *   A denied WRITE raises 42501. A denied READ raises NOTHING — RLS is a filter
 *   on SELECT, so an unauthorised read returns zero rows, indistinguishable
 *   from a row that does not exist.
 *
 * That indistinguishability is a FEATURE and this vertical preserves it: a read
 * that finds nothing reports `notFound`, never `forbidden` or `rlsDenied`.
 * Reporting a denial would confirm the row exists, turning every id in the table
 * into an existence oracle an attacker can enumerate. So there is deliberately
 * no "denied read" branch below — see `missingNote` for the read side.
 */
export function mapPostgrestFailure(
  failure: PostgrestFailure,
  operation: NoteOperation,
): AppError {
  switch (failure.code) {
    case INSUFFICIENT_PRIVILEGE:
      // `rlsDenied`, not `forbidden`. The distinction is for the OPERATOR: one
      // means the application said no, the other means the database said no,
      // and they have completely different fixes.
      return appError.rlsDenied({
        relation: NOTES_TABLE,
        message: `a row-security policy refused the ${operation}`,
      })
    case PGRST_BAD_JWT:
      // Recoverable by re-authenticating, so it must be distinguishable from
      // the policy denial above — which re-authenticating cannot fix, and where
      // telling a client to retry a login it already has loops it forever.
      return appError.unauthorized({
        code: 'session_expired',
        message: 'the access token was rejected',
      })
    case PGRST_NO_ROWS:
      return missingNote()
    case UNIQUE_VIOLATION:
    case FOREIGN_KEY_VIOLATION:
    case CHECK_VIOLATION:
      // Constraint and concurrency outcomes the client can act on by refetching
      // — distinct from the unclassified kinds, which it cannot act on at all.
      return appError.conflict({
        resource: 'note',
        message: `the ${operation} conflicts with the current state of the note`,
      })
    default:
      return unclassified(failure, operation)
  }
}

function unclassified(failure: PostgrestFailure, operation: NoteOperation): AppError {
  // The driver's message is NEVER forwarded: PostgREST error details quote
  // column names, constraint definitions and sometimes the offending value.
  // Only OUR sentence crosses the wire.
  const sqlstateClass = failure.code?.slice(0, 2) ?? ''
  return RETRYABLE_CLASSES.has(sqlstateClass)
    ? appError.unavailable({ message: `the notes store was unreachable during the ${operation}` })
    : appError.unknown({
        code: 'notes_store_rejected',
        message: `the notes store rejected the ${operation}`,
      })
}

/**
 * The read-side denial, spelled once. Every "no row came back" path funnels here
 * so the existence-oracle argument above is enforced by construction rather than
 * by everyone remembering it.
 */
export function missingNote(): AppError {
  return appError.notFound({ resource: 'note' })
}

/**
 * A page cursor that survived the contract's alphabet check but not the codec:
 * either tampering, or a token minted by an older deploy. The caller fixes it by
 * restarting the list, which makes it a rejected input rather than a fault.
 */
export function invalidCursor(): AppError {
  return appError.validation({
    code: 'invalid_cursor',
    fields: ['cursor'],
    message: 'the page cursor is not one this server minted',
  })
}

/**
 * An empty patch. Unreachable through the contract, reachable from a script that
 * skipped it — and it would still bump `updated_at`, reorder the list and
 * invalidate every live cursor.
 */
export function emptyPatch(): AppError {
  return appError.validation({
    code: 'empty_patch',
    message: 'an update must change at least one field',
  })
}

/**
 * A write that reported no error and returned no row: the RETURNING projection
 * was filtered by a SELECT policy, so the row exists and the caller may not read
 * it back. A policy misconfiguration — nothing the caller did, and nothing
 * retrying will fix.
 */
export function unreadableWrite(): AppError {
  return appError.unknown({
    code: 'write_not_readable',
    message: 'the note was written but could not be read back',
  })
}

/**
 * A row that came back but did not match the contract is schema drift — the
 * deployed table and the checked-in contract disagree. It becomes an outcome
 * rather than a thrown parse error so the transport stays uniform, and the zod
 * message is dropped rather than forwarded: issue paths are safe, but the values
 * zod echoes for some issue types are row content.
 */
export function contractDrift(operation: NoteOperation): AppError {
  return appError.unknown({
    code: 'contract_drift',
    message: `a notes row did not match its contract during the ${operation}`,
  })
}
