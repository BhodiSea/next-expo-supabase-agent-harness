import {
  type DataExportPage,
  EXPORT_MEMBERSHIPS_LIMIT,
  type ExportedNotesPage,
  type ExportMyDataSchema,
  MembershipExportRows,
  ProfileExportRows,
} from '@app/contracts'
import { type ActionOutcome, type AppError, appError, outcomeErr, outcomeOk } from '@app/errors'
import {
  decodeNotesExportCursor,
  encodeNotesExportCursor,
  listAuthoredNotes,
  type NotesDatabase,
  type PostgrestFailure,
} from '@app/notes'

// ---------------------------------------------------------------------------
// The `system.exportMyData` assembly — the DSR portability surface's one
// implementation (tools/data-flow.json export.surface; the human procedure is
// docs/runbooks/data-subject-requests.md).
//
// IT RUNS AS THE CALLER, UNDER RLS, and that is the design rather than a
// convenience: every projected row is readable by the subject's own policies,
// so no elevated privilege is involved anywhere in this file — an export that
// needed `service_role` would be an export that can return somebody else's
// rows the day a filter is wrong. The three reads answer the reviewed
// projection exactly:
//
//   profiles      the subject's own row       (RLS: self-only; the id filter
//                                              positions the PK scan)
//   memberships   the subject's own seats     (RLS: self-only for
//                                              `authenticated`; the user_id
//                                              filter positions the PK scan)
//   notes         AUTHORED notes, per org     (RLS admits every ORG-MATE's
//                                              notes — authored-only is
//                                              APPLICATION LOGIC, filtered in
//                                              the query; see @app/notes
//                                              listAuthoredNotes)
//
// The profile/membership self-reads live HERE, beside the context's identity
// resolution, rather than in a vertical: they are reads about the ACCOUNT
// (the system router's subject), not about any feature domain, and a vertical
// that owned "the user's profile" would be a vertical nobody could delete.
//
// THE WALK. Notes span every org the subject holds a seat in, but the serving
// index leads with org_id, so the export pages ONE ORG AT A TIME in sorted
// org-id order: each page returns one org's slice, and the compound cursor
// (see @app/notes' export-cursor codec) records which org and where in it. A
// page may carry fewer than `limit` notes — an export is a batch job walking
// to completeness, not a screen filling a viewport — and pagination terminates
// when the last held org is drained. Seats can change between pages; each page
// is honest about the seats held at the moment it is read, which is the same
// answer RLS itself would give.
// ---------------------------------------------------------------------------

/** The verified subject and their RESOLVED seats (ctx.orgs — never the wire). */
export interface ExportScope {
  readonly actorId: string
  readonly orgIds: readonly string[]
}

/** Where the notes walk stands: one held org, and the keyset within it. */
interface WalkPosition {
  readonly note: string | null
  readonly orgId: string
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
 * SQLSTATE classes where retrying the identical request is sane — same set the
 * notes vertical's error seam names, restated for the two reads that are this
 * package's own.
 * SOURCE: https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
const RETRYABLE_CLASSES: ReadonlySet<string> = new Set(['08', '53', '57'])

function storeFailure(relation: 'memberships' | 'profiles', failure: PostgrestFailure): AppError {
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

/** Mirrors the notes vertical's rejected-cursor answer: restart the export. */
function invalidExportCursor(): AppError {
  return appError.validation({
    code: 'invalid_cursor',
    fields: ['cursor'],
    message: 'the page cursor is not one this server minted',
  })
}

/** The held seats in the walk's canonical order. Sorted HERE, never trusted sorted. */
function heldOrgsSorted(scope: ExportScope): readonly string[] {
  return [...scope.orgIds].sort()
}

/** The first held org strictly after `orgId` in the sorted walk, or null. */
function nextOrgAfter(sorted: readonly string[], orgId: string): string | null {
  return sorted.find((id) => id > orgId) ?? null
}

/**
 * Where this page reads from, resolved against the caller's REAL seats — the
 * cursor's org id is a selector in a token, and it is looked up in `orgIds`
 * before it reaches any query (the x-org-id law, applied to a token). A held
 * org resumes exactly where it stopped; an org the caller no longer holds
 * resumes at their next held org (its notes are no longer theirs to read, so
 * skipping it is what RLS would have answered anyway); `null` means the walk
 * is over — or never had anywhere to start, for a seatless caller.
 */
function resolveWalk(
  scope: ExportScope,
  token: string | undefined,
): ActionOutcome<WalkPosition | null> {
  const sorted = heldOrgsSorted(scope)
  if (token === undefined) {
    const first = sorted[0]
    return outcomeOk(first === undefined ? null : { note: null, orgId: first })
  }
  const decoded = decodeNotesExportCursor(token)
  if (decoded === null) return outcomeErr(invalidExportCursor())
  const held = sorted.find((id) => id === decoded.orgId)
  if (held !== undefined) return outcomeOk({ note: decoded.note, orgId: held })
  const next = nextOrgAfter(sorted, decoded.orgId)
  return outcomeOk(next === null ? null : { note: null, orgId: next })
}

/**
 * The subject's own profiles row. Zero rows is drift, not a domain state: the
 * account spine mints the profile with the account, and a signed-in caller
 * with no row is a tree the server must report, not paper over.
 */
async function readProfile(
  db: NotesDatabase,
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
  db: NotesDatabase,
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

/** One org's authored-notes slice, folded into the compound-cursor page. */
async function readNotesPage(
  db: NotesDatabase,
  scope: ExportScope,
  position: WalkPosition | null,
  limit: number,
): Promise<ActionOutcome<ExportedNotesPage>> {
  if (position === null) return outcomeOk({ items: [], nextCursor: null })
  const page = await listAuthoredNotes(
    db,
    { actorId: scope.actorId, orgId: position.orgId },
    { cursor: position.note, limit },
  )
  if (!page.ok) return page
  let nextCursor: string | null
  if (page.data.nextCursor !== null) {
    // More of THIS org remains: resume inside it.
    nextCursor = encodeNotesExportCursor({ note: page.data.nextCursor, orgId: position.orgId })
  } else {
    // This org is drained: the next page starts the next held org, or the walk ends.
    const next = nextOrgAfter(heldOrgsSorted(scope), position.orgId)
    nextCursor = next === null ? null : encodeNotesExportCursor({ note: null, orgId: next })
  }
  return outcomeOk({ items: page.data.items, nextCursor })
}

/**
 * One page of the subject's export. Sequential reads, first failure wins: an
 * export page is all-or-nothing — a page missing its memberships half would
 * read as "no seats" in the archive, which is a wrong answer, not a partial
 * one.
 */
export async function exportMyData(
  db: NotesDatabase,
  scope: ExportScope,
  query: ExportMyDataSchema,
): Promise<ActionOutcome<DataExportPage>> {
  const walk = resolveWalk(scope, query.cursor)
  if (!walk.ok) return walk
  const profile = await readProfile(db, scope.actorId)
  if (!profile.ok) return profile
  const memberships = await readMemberships(db, scope.actorId)
  if (!memberships.ok) return memberships
  const notes = await readNotesPage(db, scope, walk.data, query.limit)
  if (!notes.ok) return notes
  return outcomeOk({ memberships: memberships.data, notes: notes.data, profile: profile.data })
}
