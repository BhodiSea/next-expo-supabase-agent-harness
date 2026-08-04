import { type AppError, appError } from '@app/errors'

// ---------------------------------------------------------------------------
//                    THE EMPTY-SET PRINCIPLE — read this first
// ---------------------------------------------------------------------------
// A CORRECT RLS READ RETURNS ZERO ROWS. IT DOES NOT RETURN 403.
//
// Row-level security is a FILTER on SELECT, not a gate in front of it. When a
// caller asks for a row a policy does not grant them, Postgres does not raise
// `insufficient_privilege` — it removes the row from the result and returns an
// empty set. There is no error to map, because nothing went wrong.
//
// That is a security property, not a quirk, and this package's job is to keep
// it. A 403 on a read ANSWERS THE QUESTION THE READ WAS ASKING: "does row
// `9f3c…` exist?". Return 403 for a denied read and 404 for an absent one and
// every id in the table becomes an existence oracle — an attacker enumerates
// ids, reads the status codes, and reconstructs the shape of data they were
// never shown a byte of. Membership in a private workspace, the existence of a
// document, whether a given email has an account: all of it leaks through the
// difference between two status codes.
//
// So: a read that finds nothing reports `notFound`. Always. `readMiss()` below
// is that rule spelled once, and it is deliberately the ONLY thing this module
// offers for the read-miss case — there is no "denied read" constructor here
// because there is no such outcome to construct.
//
// The asymmetry is that WRITES do raise. A policy's `WITH CHECK` clause
// rejecting an INSERT or UPDATE raises SQLSTATE 42501, and that one maps to
// `rlsDenied` — telling a caller their own write was refused reveals nothing
// they did not already supply.
// SOURCE: PostgreSQL row security — policies restrict which rows a command can
// see, so a SELECT the policy excludes returns no rows rather than an error;
// INSERT/UPDATE violating WITH CHECK raises insufficient_privilege.
// https://www.postgresql.org/docs/current/ddl-rowsecurity.html
// SOURCE: packages/verticals/notes/src/data/errors.ts (the same asymmetry,
// restated at the vertical's own kernel seam)
// ---------------------------------------------------------------------------

/**
 * The failure half of a PostgREST response.
 *
 * Structurally identical to @app/notes' `PostgrestFailure` on purpose: the two
 * describe the same wire object, and re-declaring it here rather than importing
 * it keeps the dependency arrow pointing the right way (a vertical may import
 * platform; platform may never import a vertical). Every field but `message`
 * is optional so that PostgREST's own error shape AND the transport errors the
 * client synthesises are both assignable without a cast.
 */
export interface PostgresFailure {
  readonly code?: string | undefined
  readonly details?: string | null | undefined
  readonly hint?: string | null | undefined
  readonly message: string
}

/** Which relation the policy guarded / which resource the caller addressed. */
export interface PostgresErrorContext {
  /** Table name, for `rlsDenied`. An operator reads this to find the policy. */
  readonly relation?: string
  /** Domain noun, for `notFound` / `conflict`. A screen reads this for copy. */
  readonly resource?: string
}

// ---------------------------------------------------------------------------
// SQLSTATE codes and PostgREST codes.
// SOURCE: https://www.postgresql.org/docs/current/errcodes-appendix.html
// SOURCE: https://docs.postgrest.org/en/v12/references/errors.html
// ---------------------------------------------------------------------------

/** 42501 insufficient_privilege — an RLS policy refused a WRITE. */
const INSUFFICIENT_PRIVILEGE = '42501'
/** 23505 unique_violation — the row collides with one that already exists. */
const UNIQUE_VIOLATION = '23505'
/** 23503 foreign_key_violation — the row points at something that is not there. */
const FOREIGN_KEY_VIOLATION = '23503'
/** 23502 not_null_violation — a required column arrived empty. */
const NOT_NULL_VIOLATION = '23502'
/** 23514 check_violation — the table's own bound disagreed with the payload. */
const CHECK_VIOLATION = '23514'
/** 22P02 invalid_text_representation — a malformed uuid, enum or number. */
const INVALID_TEXT_REPRESENTATION = '22P02'
/**
 * 53400 configuration_limit_exceeded — a per-org quota trigger refused the write.
 *
 * IT MUST BE MATCHED EXPLICITLY, and the reason is three lines below: `53` is in
 * RETRYABLE_CLASSES, so without its own case this code falls through to
 * `unavailable` and every client is told to retry. Waiting does not free a quota —
 * only deleting rows or raising the ceiling does — so the retry can never succeed,
 * and the storm it produces lands on a database that just said it was full.
 */
const QUOTA_EXCEEDED = '53400'
/** 40001 serialization_failure — a concurrent transaction won the race. */
const SERIALIZATION_FAILURE = '40001'
/** 40P01 deadlock_detected — two transactions waited on each other; one was shot. */
const DEADLOCK_DETECTED = '40P01'
/** PGRST116 — `.single()` / `.maybeSingle()` matched zero rows (or more than one). */
const PGRST_NO_ROWS = 'PGRST116'
/** PGRST301 — PostgREST rejected the JWT: expired, wrong key, or malformed. */
const PGRST_BAD_JWT = 'PGRST301'
/** PGRST202 — the addressed RPC does not exist in the exposed schema. */
const PGRST_NO_FUNCTION = 'PGRST202'

/**
 * SQLSTATE CLASSES where retrying the identical request is a sane response:
 * 08 connection exception, 53 insufficient resources, 57 operator intervention.
 * Matched on the two-character class rather than on individual codes because
 * the class is what carries the "transient" meaning; enumerating members would
 * be a list that silently stops covering new ones.
 *
 * Everything unrecognised falls to `unknown`, NOT to `unavailable`. Telling a
 * client to retry a permanent failure multiplies the load that caused it, and
 * a retry storm against a database that rejected the query on its merits is
 * how a small bug becomes an outage.
 */
const RETRYABLE_CLASSES: ReadonlySet<string> = new Set(['08', '53', '57'])

/**
 * SQLSTATE → `AppError`. The single place in the platform layer where a driver
 * code becomes a member of the taxonomy the screens switch on.
 *
 * A vertical may wrap this (see @app/notes) to add what a general mapper
 * cannot know: which OPERATION ran, and therefore whether a constraint
 * violation is better read as a conflict or as bad input. What it must not do
 * is re-derive the SQLSTATE table — a second copy drifts, and the copy that
 * misses 42501 turns a policy denial into `unknown`, which reads as a bug in
 * the application rather than as the deliberate refusal it is.
 *
 * NOTE THE DRIVER MESSAGE IS DROPPED. PostgREST's `message`, `details` and
 * `hint` quote column names, constraint definitions and sometimes the offending
 * VALUE. Forwarding them puts row content and schema internals on a wire whose
 * far end is a user's screen, for no reader who can act on it. Only our own
 * sentence crosses. Route the original into @app/observability if you need it.
 */
export function mapPostgresError(
  failure: PostgresFailure,
  context: PostgresErrorContext = {},
): AppError {
  switch (failure.code) {
    case INSUFFICIENT_PRIVILEGE:
      // `rlsDenied`, not `forbidden`, and the distinction is for the OPERATOR:
      // one means the application's own rule said no, the other means the
      // database said no. They have completely different fixes — a code change
      // versus a policy migration — and collapsing them costs an incident the
      // hour it takes to work out which layer refused.
      return appError.rlsDenied({
        ...(context.relation === undefined ? {} : { relation: context.relation }),
        message: 'a row-security policy refused the write',
      })

    case QUOTA_EXCEEDED:
      // Placed above the class-53 retryable fallback deliberately: the fallback
      // would call this transient and hand the caller a retry that cannot work.
      // The metric and ceiling are NOT parsed out of the driver message — that
      // message quotes the org id and the raw counts, and the rule for this whole
      // module is that no driver text crosses to a screen. A caller that wants the
      // numbers reads public.org_usage, which it is allowed to.
      return appError.quotaExceeded({
        message: 'a per-org quota refused the write',
      })

    case PGRST_NO_ROWS:
      // Zero rows where exactly one was demanded. The empty-set principle makes
      // this `notFound` and never a denial: at this point the two are the same
      // observation, and saying which one it was is the leak.
      return readMiss(context.resource)

    case UNIQUE_VIOLATION:
      return appError.conflict({
        ...(context.resource === undefined ? {} : { resource: context.resource }),
        code: 'unique_violation',
        message: 'a row with those values already exists',
      })

    case FOREIGN_KEY_VIOLATION:
      // `validation`, not `conflict`: the caller named a parent row that is not
      // there (or not visible to them), which is an input they can correct. A
      // `conflict` would tell them to retry, and retrying the identical write
      // against a missing parent fails identically, forever.
      return appError.validation({
        code: 'foreign_key_violation',
        message: 'a referenced record does not exist',
      })

    case NOT_NULL_VIOLATION:
    case CHECK_VIOLATION:
    case INVALID_TEXT_REPRESENTATION:
      // The table's constraints disagreed with the payload. Reaching here means
      // the zod contract and the deployed schema have drifted — the contract
      // should have caught it first — but it is still the INPUT that is wrong,
      // so the caller gets the kind that lets a form react.
      return appError.validation({
        code: 'constraint_violation',
        message: 'the submitted values violate a database constraint',
      })

    case SERIALIZATION_FAILURE:
    case DEADLOCK_DETECTED:
      // Genuinely retryable, and genuinely a conflict: the write was correct
      // and lost a race. `conflict` rather than `unavailable` because the
      // caller must re-read before retrying — the state it was written against
      // is the state that changed.
      return appError.conflict({
        ...(context.resource === undefined ? {} : { resource: context.resource }),
        code: 'write_conflict',
        message: 'a concurrent write won the race; re-read and retry',
      })

    case PGRST_BAD_JWT:
      // Recoverable by re-authenticating, which is why it must NOT be folded
      // into the policy denial above: re-authenticating cannot fix a policy,
      // and telling a client to retry a login it already holds loops it forever.
      return appError.unauthorized({
        code: 'session_expired',
        message: 'the access token was rejected',
      })

    case PGRST_NO_FUNCTION:
      // A deploy-ordering fault (the migration adding the function has not
      // landed), never anything the caller did. `unknown` is the honest kind:
      // there is no client-side remedy.
      return appError.unknown({
        code: 'rpc_not_found',
        message: 'the database function is not exposed by this deployment',
      })

    default:
      return unclassified(failure)
  }
}

/**
 * The tail of the switch, split out so `mapPostgresError` stays a flat table.
 * A transport failure — DNS, TLS, a dead pooler — arrives with NO `code` at
 * all, and that is deliberately NOT treated as retryable: an absent code means
 * we do not know what happened, and guessing "transient" is how a client is
 * told to hammer a service that is failing on the merits.
 */
function unclassified(failure: PostgresFailure): AppError {
  const sqlstateClass = failure.code?.slice(0, 2) ?? ''
  if (RETRYABLE_CLASSES.has(sqlstateClass)) {
    return appError.unavailable({ message: 'the database was unreachable or shedding load' })
  }
  return appError.unknown({
    code: 'database_rejected',
    message: 'the database rejected the request',
  })
}

/**
 * A read that returned no rows. ALWAYS `notFound` — never `forbidden`, never
 * `rlsDenied`.
 *
 * This exists as a named export so the empty-set principle is something a call
 * site CALLS rather than something it has to remember. Every "nothing came
 * back" path in every DAL funnels here, which is what makes the property
 * enforceable by grep: a `forbidden` constructed on a read path is visible in
 * review as a deviation from the one function everyone else uses.
 */
export function readMiss(resource?: string): AppError {
  return appError.notFound(resource === undefined ? {} : { resource })
}

/**
 * True when a failure is a row-security refusal. For OBSERVABILITY — an
 * operator wants a distinct metric for "the database said no", because a spike
 * in it means a policy regression, not a user error.
 *
 * It is not a branch a screen should take: by the time an `AppError` exists the
 * `kind` discriminant already carries this, and re-deriving it from the driver
 * failure at a UI layer means the driver failure travelled further than it
 * should have.
 */
export function isRlsDenied(failure: PostgresFailure): boolean {
  return failure.code === INSUFFICIENT_PRIVILEGE
}
