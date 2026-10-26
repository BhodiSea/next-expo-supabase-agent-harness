// cspell:words trunc upsert
import {
  type NewPushDeviceToken,
  type PushDeviceToken,
  PushDeviceTokenDto,
  type PushDeviceTokensListQueryInput,
  type PushDeviceTokensPageDto,
  PushDeviceTokensPage,
  PUSH_TOKENS_PAGE_LIMIT_MAX,
} from '@app/contracts'
import { type ActionOutcome, type AppError, appError, outcomeErr, outcomeOk } from '@app/errors'
import { z } from 'zod'
import { decodePushCursor, encodePushCursor, type PushCursor } from '../domain/cursor.js'
import { pushTokenRowId } from '../domain/push-token-id.js'

// ---------------------------------------------------------------------------
// The push-token DAL (push-notifications module). Installed to
// packages/verticals/push/src/data/push-tokens.ts.
//
// The same three laws as the notes DAL (packages/verticals/notes/src/data/notes.ts):
//
//   1. It takes a client, it never makes one. The client handed in is the
//      per-request, RLS-scoped one; a DAL that could reach for a service-role
//      client would make every caller a privilege decision.
//   2. It returns DTOs, never rows. `toPushDeviceToken` is the only door out of
//      the driver's world, and every method Zod-parses at its exit.
//   3. It returns outcomes, never throws for a domain failure — callers get a
//      value they can switch on; the transport (tRPC / Server Action) stays
//      uniform.
//
// And the load-bearing ABSENCE: no method adds an `owner_id` filter. Visibility
// is the RLS policies' job, enforced against `auth.uid()`; filtering in the
// application too would MASK a policy regression the day a policy is dropped.
// ---------------------------------------------------------------------------

// The structural port the DAL is written against — a deliberate hand-authored
// subset of the supabase-js query builder (the same technique as
// packages/verticals/notes/src/data/port.ts), widened here with `upsert` because
// registerToken() is an idempotent INSERT ... ON CONFLICT DO UPDATE. `data` is
// `unknown` on purpose: the row shape is whatever migration is deployed, so it is
// re-parsed at the exit rather than trusted at the entrance, and the port is
// fake-able in a few lines for a unit test with no container.
export interface PushTokensFailure {
  readonly code?: string | undefined
  readonly details?: string | null | undefined
  readonly hint?: string | null | undefined
  readonly message: string
}

export interface PushTokensOutcome {
  readonly data: unknown
  readonly error: PushTokensFailure | null
}

export interface PushTokensQuery extends PromiseLike<PushTokensOutcome> {
  eq(column: string, value: string): PushTokensQuery
  limit(count: number): PushTokensQuery
  or(filters: string): PushTokensQuery
  order(column: string, options: { readonly ascending: boolean }): PushTokensQuery
  select(columns: string): PushTokensQuery
}

export interface PushTokensTable {
  delete(): PushTokensQuery
  select(columns: string): PushTokensQuery
  upsert(
    values: Readonly<Record<string, unknown>>,
    options: { readonly onConflict: string },
  ): PushTokensQuery
}

/** The one method the DAL needs from a Supabase client. */
export interface PushTokensDatabase {
  from(table: string): PushTokensTable
}

/** What a write needs beyond its input: the VERIFIED actor, never a wire field. */
export interface PushTokenWriteContext {
  readonly actorId: string
}

/** The table this vertical owns. Named once; the DAL never spells it inline. */
const PUSH_TOKENS_TABLE = 'push_device_tokens'

// Explicit projection — `select('*')` is banned: it welds the wire payload to the
// physical table, so an internal column added later would silently grow every
// response past its contract bound.
const PUSH_TOKEN_COLUMNS = 'id, owner_id, token, platform, created_at, updated_at'

// The snake_case row shape, its field schemas BORROWED from the contract's shape
// rather than restated — a restated bound is a bound that drifts.
const PushRow = z.object({
  created_at: PushDeviceTokenDto.shape.createdAt,
  id: PushDeviceTokenDto.shape.id,
  owner_id: PushDeviceTokenDto.shape.ownerId,
  platform: PushDeviceTokenDto.shape.platform,
  token: PushDeviceTokenDto.shape.token,
  updated_at: PushDeviceTokenDto.shape.updatedAt,
})

/**
 * Parse ONCE at the driver boundary, then rename snake_case → camelCase. The
 * parse enforces every contract bound; the rename is a total, type-checked
 * mapping. Throws `ZodError` on a row that does not match; callers turn that into
 * a `contractDrift` outcome.
 */
function toPushDeviceToken(row: unknown): PushDeviceToken {
  const record = PushRow.parse(row)
  return {
    createdAt: record.created_at,
    id: record.id,
    ownerId: record.owner_id,
    platform: record.platform,
    token: record.token,
    updatedAt: record.updated_at,
  }
}

/** PostgREST hands back `unknown`; anything that is not an array is a protocol
 *  surprise, coerced to empty rather than indexed blindly. */
function asRowArray(data: unknown): readonly unknown[] {
  return Array.isArray(data) ? data : []
}

/**
 * Keyset seek for `ORDER BY created_at DESC, id DESC`, expressed as PostgREST's
 * `or(...)` of the two lexicographic cases — never OFFSET. The interpolated
 * values are safe because `decodePushCursor` has already parsed both against
 * anchored schemas (a calendar-valid timestamp and a uuid), so neither can carry
 * a `,`, `.`, `(`, `)` or `"` that would break out of the filter grammar; they
 * are quoted as well, because defence that depends on an upstream invariant
 * should not depend on it ALONE.
 * SOURCE: https://use-the-index-luke.com/no-offset · row-wise comparison
 * https://docs.postgrest.org/en/v12/references/api/tables_views.html#logical-operators
 */
function keysetFilter(cursor: PushCursor): string {
  const at = `"${cursor.createdAt}"`
  return `created_at.lt.${at},and(created_at.eq.${at},id.lt."${cursor.id}")`
}

// ---------------------------------------------------------------------------
// SQLSTATE / PostgREST failure mapping. A denied WRITE raises 42501; a denied
// READ raises NOTHING (RLS filters SELECT), so this vertical never reports a
// "denied read" — a read that finds nothing is `notFound`, preserving the
// existence-oracle protection the RLS suite pins.
// SOURCE: https://www.postgresql.org/docs/current/errcodes-appendix.html ·
// https://docs.postgrest.org/en/v12/references/errors.html
// ---------------------------------------------------------------------------
type PushOperation = 'register' | 'list' | 'remove'
const RETRYABLE_CLASSES: ReadonlySet<string> = new Set(['08', '53', '57'])

function mapFailure(failure: PushTokensFailure, operation: PushOperation): AppError {
  switch (failure.code) {
    case '42501':
      // rlsDenied, not forbidden: one means the application said no, the other
      // means the database said no, and they have different fixes.
      return appError.rlsDenied({
        relation: PUSH_TOKENS_TABLE,
        message: `a row-security policy refused the ${operation}`,
      })
    case 'PGRST301':
      return appError.unauthorized({
        code: 'session_expired',
        message: 'the access token was rejected',
      })
    case 'PGRST116':
      return appError.notFound({ resource: 'push_token' })
    case '23505':
    case '23503':
    case '23514':
      return appError.conflict({
        resource: 'push_token',
        message: `the ${operation} conflicts with the current state of the token`,
      })
    default: {
      // The driver's message is NEVER forwarded — PostgREST details quote column
      // names and sometimes the offending value; only OUR sentence crosses the wire.
      const sqlstateClass = failure.code?.slice(0, 2) ?? ''
      return RETRYABLE_CLASSES.has(sqlstateClass)
        ? appError.unavailable({ message: `the push-token store was unreachable during the ${operation}` })
        : appError.unknown({
            code: 'push_store_rejected',
            message: `the push-token store rejected the ${operation}`,
          })
    }
  }
}

function contractDrift(operation: PushOperation): AppError {
  return appError.unknown({
    code: 'contract_drift',
    message: `a push_device_tokens row did not match its contract during the ${operation}`,
  })
}

/**
 * Register (or re-register) a device token.
 *
 * The idempotence key is the DETERMINISTIC primary key: the same (owner, token)
 * derives the same id, so racing registrations collapse into one row through the
 * upsert's ON CONFLICT (id) DO UPDATE — no read-before-write. `owner_id` comes
 * from the VERIFIED actor on the context, never the wire (the contract does not
 * even carry the field); the INSERT policy's WITH CHECK re-checks it against
 * `auth.uid()`, and the DO UPDATE path re-checks the conflicting row against the
 * UPDATE policy. The BEFORE UPDATE trigger bumps updated_at on the conflict path.
 */
export async function registerToken(
  db: PushTokensDatabase,
  context: PushTokenWriteContext,
  input: NewPushDeviceToken,
): Promise<ActionOutcome<PushDeviceToken>> {
  const id = pushTokenRowId(context.actorId, input.token)

  const result = await db
    .from(PUSH_TOKENS_TABLE)
    .upsert(
      { id, owner_id: context.actorId, platform: input.platform, token: input.token },
      { onConflict: 'id' },
    )
    .select(PUSH_TOKEN_COLUMNS)
    .limit(1)

  // `error` FIRST, always: PostgREST resolves rather than rejects, so reading
  // `data` before `error` would render an RLS denial as an empty result.
  if (result.error !== null) return outcomeErr(mapFailure(result.error, 'register'))

  const row = asRowArray(result.data)[0]
  // No error and no row means the RETURNING projection was filtered by the SELECT
  // policy — the row exists but the caller may not read it back. A policy
  // misconfiguration, not a user error.
  if (row === undefined) {
    return outcomeErr(
      appError.unknown({
        code: 'write_not_readable',
        message: 'the push token was written but could not be read back',
      }),
    )
  }

  try {
    return outcomeOk(toPushDeviceToken(row))
  } catch {
    return outcomeErr(contractDrift('register'))
  }
}

/**
 * One keyset page of the caller's device tokens, newest first. A sentinel row
 * (limit + 1) is the has-more probe; the extra row is dropped before the page is
 * built. The defensive clamp is defence in depth below the contract bound: the
 * DAL never issues an unbounded SELECT, whatever a future caller passes.
 */
export async function listTokens(
  db: PushTokensDatabase,
  query: PushDeviceTokensListQueryInput,
): Promise<ActionOutcome<PushDeviceTokensPageDto>> {
  const limit = Math.min(Math.max(Math.trunc(query.limit), 1), PUSH_TOKENS_PAGE_LIMIT_MAX)

  let cursor: PushCursor | null = null
  if (query.cursor !== undefined) {
    cursor = decodePushCursor(query.cursor)
    if (cursor === null) {
      return outcomeErr(
        appError.validation({
          code: 'invalid_cursor',
          fields: ['cursor'],
          message: 'the page cursor is not one this server minted',
        }),
      )
    }
  }

  let builder = db.from(PUSH_TOKENS_TABLE).select(PUSH_TOKEN_COLUMNS)
  if (cursor !== null) builder = builder.or(keysetFilter(cursor))

  const result = await builder
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1)

  if (result.error !== null) return outcomeErr(mapFailure(result.error, 'list'))

  let records: PushDeviceToken[]
  try {
    records = asRowArray(result.data).map(toPushDeviceToken)
  } catch {
    return outcomeErr(contractDrift('list'))
  }

  const items = records.slice(0, limit)
  const last = items.at(-1)
  const nextCursor =
    records.length > limit && last !== undefined
      ? encodePushCursor({ createdAt: last.createdAt, id: last.id })
      : null

  try {
    return outcomeOk(PushDeviceTokensPage.parse({ items, nextCursor }))
  } catch {
    return outcomeErr(contractDrift('list'))
  }
}

/**
 * Deregister a token by id. RLS scopes the DELETE to the caller's own rows, so a
 * foreign or absent id simply matches nothing and the caller sees `notFound` —
 * the same answer for "gone" and "not yours", which is what keeps a uuid from
 * becoming an existence oracle.
 */
export async function removeToken(
  db: PushTokensDatabase,
  id: string,
): Promise<ActionOutcome<{ readonly id: string }>> {
  const result = await db.from(PUSH_TOKENS_TABLE).delete().eq('id', id).select('id').limit(1)

  if (result.error !== null) return outcomeErr(mapFailure(result.error, 'remove'))

  const row = asRowArray(result.data)[0]
  if (row === undefined) return outcomeErr(appError.notFound({ resource: 'push_token' }))

  return outcomeOk({ id })
}
