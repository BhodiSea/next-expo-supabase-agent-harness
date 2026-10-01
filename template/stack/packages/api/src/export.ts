import {
  type DataExportPage,
  EXPORT_MEMBERSHIPS_LIMIT,
  MembershipExportRows,
  ProfileExportRows,
} from '@app/contracts'
import { type ActionOutcome, type AppError, appError, outcomeErr, outcomeOk } from '@app/errors'
import type { ApiDatabase, StoreFailure } from './context.js'

// ---------------------------------------------------------------------------
// The `system.exportMyData` assembly — the DSR portability surface's one
// implementation (tools/data-flow.json export.surface; the human procedure is
// docs/runbooks/data-subject-requests.md).
//
// IT RUNS AS THE CALLER, UNDER RLS, and that is the design rather than a
// convenience: every projected row is readable by the subject's own policies,
// so no elevated privilege is involved anywhere in this file — an export that
// needed `service_role` would be an export that can return somebody else's
// rows the day a filter is wrong. The two reads answer the reviewed
// projection exactly:
//
//   profiles      the subject's own row       (RLS: self-only; the id filter
//                                              positions the PK scan)
//   memberships   the subject's own seats     (RLS: self-only for
//                                              `authenticated`; the user_id
//                                              filter positions the PK scan)
//
// The profile/membership self-reads live HERE, beside the context's identity
// resolution, rather than in a vertical: they are reads about the ACCOUNT
// (the system router's subject), not about any feature domain, and a vertical
// that owned "the user's profile" would be a vertical nobody could delete.
//
// A VERTICAL THAT STORES THE SUBJECT'S DATA ADDS ITS SECTION HERE: a paged read
// of what the subject authored, a cursor that walks it, and the projection row in
// tools/data-flow.json. The notes vertical `init --with-demo` plants is the worked
// example, including the one invariant RLS cannot give it (authored-only).
// ---------------------------------------------------------------------------

/** The verified subject. */
export interface ExportScope {
  readonly actorId: string
}

const PROFILES_TABLE = 'profiles'
/** tools/data-flow.json export.projection.profiles, verbatim. */
const PROFILE_COLUMNS = 'id, display_name, created_at, updated_at'
const MEMBERSHIPS_TABLE = 'memberships'
/** tools/data-flow.json export.projection.memberships, verbatim. */
const MEMBERSHIP_COLUMNS = 'user_id, org_id, role_rank, created_at'

// Row schemas live in @app/contracts (ProfileExportRows / MembershipExportRows):
// they borrow every bound from the wire DTOs — the rows.ts law — and contracts
// owns zod, so this package validates through them without a zod dependency of
// its own for two derived shapes.
const ProfileRows = ProfileExportRows
const MembershipRows = MembershipExportRows

/**
 * SQLSTATE classes where retrying the identical request is sane — the set a
 * vertical's error seam names, restated for the two reads that are this
 * package's own.
 * SOURCE: https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
const RETRYABLE_CLASSES: ReadonlySet<string> = new Set(['08', '53', '57'])

function storeFailure(relation: 'memberships' | 'profiles', failure: StoreFailure): AppError {
  if (failure.code === '42501') {
    return appError.rlsDenied({
      relation,
      message: `a row-security policy refused the ${relation} export read`,
    })
  }
  const sqlstateClass = failure.code?.slice(0, 2) ?? ''
  return RETRYABLE_CLASSES.has(sqlstateClass)
    ? appError.unavailable({ message: `the ${relation} store was unreachable during the export` })
    : appError.unknown({
        code: 'export_store_rejected',
        message: `the ${relation} store rejected the export read`,
      })
}

/** A row that no longer matches its contract is server drift, not a caller error. */
function exportDrift(relation: 'memberships' | 'profiles'): AppError {
  return appError.unknown({
    code: 'contract_drift',
    message: `a ${relation} row did not match its contract during the export`,
  })
}

/**
 * The subject's own profiles row. Zero rows is drift, not a domain state: the
 * account spine mints the profile with the account, and a signed-in caller
 * with no row is a tree the server must report, not paper over.
 */
async function readProfile(
  db: ApiDatabase,
  actorId: string,
): Promise<ActionOutcome<DataExportPage['profile']>> {
  const result = await db.from(PROFILES_TABLE).select(PROFILE_COLUMNS).eq('id', actorId).limit(1)
  if (result.error !== null) return outcomeErr(storeFailure('profiles', result.error))
  const rows = ProfileRows.safeParse(result.data)
  if (!rows.success) return outcomeErr(exportDrift('profiles'))
  const row = rows.data[0]
  if (row === undefined) return outcomeErr(appError.notFound({ resource: 'profile' }))
  return outcomeOk({
    createdAt: row.created_at,
    displayName: row.display_name,
    id: row.id,
    updatedAt: row.updated_at,
  })
}

/**
 * The subject's own seats. RLS is already self-only for `authenticated`; the
 * user_id filter positions the primary-key scan (user_id leads the PK) and
 * states on the page whose rows these are. Ordered by org_id so the export is
 * byte-stable across runs, and LIMIT-bounded unconditionally like every read
 * in the repo — the bound and its honest limit are documented on
 * EXPORT_MEMBERSHIPS_LIMIT.
 */
async function readMemberships(
  db: ApiDatabase,
  actorId: string,
): Promise<ActionOutcome<DataExportPage['memberships']>> {
  const result = await db
    .from(MEMBERSHIPS_TABLE)
    .select(MEMBERSHIP_COLUMNS)
    .eq('user_id', actorId)
    .order('org_id', { ascending: true })
    .limit(EXPORT_MEMBERSHIPS_LIMIT)
  if (result.error !== null) return outcomeErr(storeFailure('memberships', result.error))
  const rows = MembershipRows.safeParse(result.data)
  if (!rows.success) return outcomeErr(exportDrift('memberships'))
  return outcomeOk(
    rows.data.map((row) => ({
      createdAt: row.created_at,
      orgId: row.org_id,
      roleRank: row.role_rank,
      userId: row.user_id,
    })),
  )
}

/**
 * The subject's export. Sequential reads, first failure wins: an export is
 * all-or-nothing — one missing its memberships half would read as "no seats" in
 * the archive, which is a wrong answer, not a partial one.
 */
export async function exportMyData(
  db: ApiDatabase,
  scope: ExportScope,
): Promise<ActionOutcome<DataExportPage>> {
  const profile = await readProfile(db, scope.actorId)
  if (!profile.ok) return profile
  const memberships = await readMemberships(db, scope.actorId)
  if (!memberships.ok) return memberships
  return outcomeOk({ memberships: memberships.data, profile: profile.data })
}
