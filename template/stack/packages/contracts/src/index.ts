import { z } from 'zod'

// ---------------------------------------------------------------------------
// @app/contracts — the wire contracts, hand-authored in pure Zod. `zod` is the
// ONLY runtime dependency: this package sits at the bottom of the import graph
// and is the one schema surface BOTH surfaces may import (Next server
// components, Next server actions, the tRPC router, and the Expo bundle all
// resolve the same ./src/index.ts — no build step, no transpile hop).
//
// Nothing here may reach for a database driver, a Supabase client, `next/*` or
// `react-native*`. A contract that imports a runtime is no longer a contract:
// it becomes a second place where the wire shape is decided, and the two drift.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Wire bounds — EVERY string and number crossing the API boundary carries an
// explicit limit. An unbounded wire string is a memory-amplification primitive:
// the server happily accepts a 50 MB "title" the client never meant to send,
// buffers it, parses it, and writes it. Bounds are cheap here and impossible to
// retrofit once a client depends on the slack.
// SOURCE: harness doctrine — contracts are the enforcement surface; no
// unbounded wire input [corpus: harness/doctrine]
// ---------------------------------------------------------------------------

/**
 * Addresses are bounded by the SMTP path limit, not by a guess: RFC 5321 §4.5.3.1.3
 * fixes the maximum reverse/forward path at 256 octets, of which 320 is the
 * commonly-cited local@domain ceiling (64 local + 1 + 255 domain).
 * SOURCE: https://www.rfc-editor.org/rfc/rfc5321#section-4.5.3.1
 */
export const EMAIL_MAX = 320
/** Display names are UI labels, not prose. */
export const DISPLAY_NAME_MAX = 120
/**
 * Both mirror a CHECK constraint in supabase/schemas/05_tenancy.sql, and both
 * must stay >= the database's bound rather than merely near it. A wire bound
 * TIGHTER than the column's turns a legal stored row into a parse failure on
 * read — the org exists, the policy admits it, and the client cannot render it.
 * `orgs_name_length` is 1..120; `orgs_slug_shape` admits 2..48 characters (the 48
 * is arithmetic, not taste: ensure_personal_org mints a 41-character slug).
 */
export const ORG_NAME_MAX = 120
export const ORG_SLUG_MAX = 48
/** Semver-ish release strings; 64 chars leaves room for a build metadata tail. */
export const VERSION_MAX = 64
/**
 * timestamptz text. The longest form Postgres emits is well under 40 chars
 * ('2026-01-01T00:00:00.123456+00:00'); 64 leaves headroom for a longer zone
 * spelling without leaving the field effectively unbounded.
 */
export const TIMESTAMP_TEXT_MAX = 64

/**
 * The header the client stamps on every request with its own release version.
 * It lives HERE, not in the router, because both ends of the wire must agree on
 * the spelling: the mobile fetch layer sets it and the version-skew middleware
 * reads it. A second literal in a second package is how a guard goes silently
 * inert.
 */
export const CLIENT_VERSION_HEADER = 'x-client-version'

/**
 * The header carrying WHICH org the caller is acting in. Here for the same
 * reason as the version header — both ends must agree on the spelling — and in a
 * HEADER rather than a payload field for a reason worth stating once, loudly:
 *
 * A header is a transport selector. It travels beside the request, applies to
 * the whole of it, and is resolved server-side against the caller's real
 * memberships before it means anything — so the worst a forged one can do is
 * select an org the caller does not belong to, which resolves to no active org
 * at all. A body field is DATA: it is parsed, it flows into handlers, and the
 * first handler that passes it to a query has made the client the author of its
 * own tenant boundary. The database would still refuse (the policies key on
 * public.memberships, not on anything the request said), but the application
 * would have stopped being a place where that mistake is visible.
 *
 * The `org-id-from-session-only` ESLint rule enforces the payload half; the
 * pgTAP + supabase-js suites prove the database is indifferent to this header.
 */
export const ORG_ID_HEADER = 'x-org-id'

/**
 * Transport-level failure codes. These are NOT domain errors — domain failures
 * ride the data channel as the `ActionOutcome` envelope from `@app/errors` and
 * never appear here. This closed set is exactly the conditions that are rejected
 * BEFORE any handler runs, so a client cannot receive an envelope for them; the
 * client normalize layer switches on these strings to fold them back into the
 * same discriminated union the screens already handle.
 *
 * `rate_limited` joined the set with the rate-limit seam. It belongs here for
 * the same structural reason as the other two and not by analogy: the guard runs
 * as middleware, and tRPC middleware has exactly two exits — call next(), or
 * throw. There is no third exit that returns a value on the data channel, so a
 * limit that refuses the work before the handler runs cannot ride the envelope.
 */
export const TransportErrorCode = z.enum(['rate_limited', 'unauthorized', 'version_skew'])
export type TransportErrorCode = z.infer<typeof TransportErrorCode>

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/**
 * timestamptz over the wire: the ISO-8601 text PostgREST emits
 * ('2026-01-01T00:00:00.123456+00:00'), carried VERBATIM. It is never re-parsed
 * through a JS `Date` on the way through — `Date` truncates to milliseconds,
 * and keyset cursors compare this exact string back against the column, so a
 * lost microsecond silently skips every row sharing that millisecond.
 *
 * Deliberately a prefix check, not an anchored one: this validates driver
 * OUTPUT (shape assurance), and Postgres is free to add precision. Wire INPUT
 * that is re-bound into a query — a page cursor — is anchored at both ends by
 * the schema of the vertical that mints it, where a loose tail is exploitable.
 */
export const WireTimestamp = z
  .string()
  .max(TIMESTAMP_TEXT_MAX)
  .regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/)
export type WireTimestamp = z.infer<typeof WireTimestamp>

/**
 * Org roles, ordered least to most privileged. A closed enum rather than a free
 * string: role checks are authorization decisions, and an unrecognised role must
 * fail parsing loudly rather than silently landing in a `default` branch that
 * grants nothing (or, worse, everything).
 *
 * `viewer` exists here and did not in the pre-org enum, because the database's
 * ladder has four rungs (10/20/30/40) and a wire enum missing one of them makes
 * every viewer's ActorView fail to parse — a signed-in user staring at a crash
 * screen for the crime of being read-only.
 */
export const OrgRole = z.enum(['viewer', 'member', 'admin', 'owner'])
export type OrgRole = z.infer<typeof OrgRole>

/**
 * The rank each role carries in `public.memberships.role_rank`. THE DATABASE IS
 * THE AUTHORITY — these are not the enforcement, they are the client-side mirror
 * that lets a screen hide a button the policy would refuse anyway. Kept as a
 * total map (`Record<OrgRole, …>`, not a partial one) so adding a rung to OrgRole
 * without a rank is a compile error rather than an `undefined` that compares
 * false against every floor and silently disables the feature for that role.
 *
 * The values match `tools/tenancy.json` `roles`, which the `tenancy` gate holds
 * every policy's rank floor against. Two records, one scale: drift between them
 * is a UI that offers an action the database then refuses — annoying — or hides
 * one it would have allowed — invisible.
 */
export const ORG_ROLE_RANK: Readonly<Record<OrgRole, number>> = Object.freeze({
  viewer: 10,
  member: 20,
  admin: 30,
  owner: 40,
})

/** Rank-first ordering helper, so a screen never re-derives `>=` from the map. */
export function atLeastRole(held: OrgRole, floor: OrgRole): boolean {
  return ORG_ROLE_RANK[held] >= ORG_ROLE_RANK[floor]
}

/**
 * One org as both surfaces render it, including the caller's own standing in it.
 * `slug` rides along because the web app routes on it (`/o/[orgSlug]/…`) and a
 * screen that had to fetch the org again just to build its own href would make
 * every navigation a round trip.
 */
/**
 * An org slug, shaped exactly like `orgs_slug_shape` in
 * supabase/schemas/05_tenancy.sql. ANCHORED at both ends, because unlike
 * `WireTimestamp` (which validates driver OUTPUT and may loosen as Postgres adds
 * precision) this validates wire INPUT that is re-bound into a lookup: a slug
 * arrives in a URL segment and in a Server Action's bound argument, and a loose
 * tail on a value that gets compared against a list is how a near-miss becomes a
 * match. It is the tighter of the two bounds by construction — a value this
 * rejects could never have been stored.
 */
export const OrgSlug = z
  .string()
  .min(2)
  .max(ORG_SLUG_MAX)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
export type OrgSlug = z.infer<typeof OrgSlug>

/**
 * The bearer invitation token as it travels in a URL. A uuid and nothing else: the table
 * stores only sha256(token), so a value that is not a uuid can never hash to a stored digest
 * — rejecting it here saves a round trip and, more usefully, keeps the malformed case
 * indistinguishable from the expired and already-used ones in every message the UI shows.
 */
export const InvitationToken = z.uuid()
/**
 * An org id as it comes BACK from the database — a definer RPC's return value, a row's
 * tenant key. It exists because @app/supabase's client is deliberately untyped by a
 * generated `Database` (rows are `unknown` at the entrance and re-parsed at the exit), so an
 * `.rpc()` result is `any` and re-parsing it here is the same law the DAL follows for rows.
 */
export const OrgId = z.uuid()
export type OrgId = z.infer<typeof OrgId>
export type InvitationToken = z.infer<typeof InvitationToken>

export const OrgSummary = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(ORG_NAME_MAX),
  role: OrgRole,
  slug: OrgSlug,
})
export type OrgSummary = z.infer<typeof OrgSummary>

// ---------------------------------------------------------------------------
// Actor — the reason the ladder above `publicProcedure` exists at all.
// ---------------------------------------------------------------------------

/**
 * The signed-in caller as both surfaces render it.
 *
 * `orgs` is the caller's REAL seat list, resolved server-side from
 * public.memberships on every request — never from a token claim, so revoking a
 * seat takes effect on the next request rather than at the next token refresh.
 * It may be empty: a user mid-invitation, or one whose last seat was revoked, is
 * a reachable state and modelling it as impossible is how a signed-in user ends
 * up staring at a crash screen.
 *
 * `activeOrg` is nullable for the same reason AND for a second one: the acting
 * org arrives as a TRANSPORT SELECTOR (the `x-org-id` header), and a selector
 * naming an org the caller does not belong to resolves to `null` — never to an
 * error, and never to an elevation. It is always an element of `orgs` or null;
 * there is no third case, which is what makes "the caller can act here" a lookup
 * rather than a judgement.
 *
 * NOTE THE ABSENCE: no `orgId` field on any input contract in this file. The
 * acting org is a header, never a payload — a request body that could name its
 * own tenant is one parse away from being trusted, and the
 * `org-id-from-session-only` ESLint rule reds any zod object here that grows one.
 */
export const ActorView = z.object({
  activeOrg: OrgSummary.nullable(),
  displayName: z.string().min(1).max(DISPLAY_NAME_MAX),
  email: z.string().max(EMAIL_MAX).nullable(),
  id: z.uuid(),
  orgs: z.array(OrgSummary),
})
export type ActorView = z.infer<typeof ActorView>

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/**
 * The public liveness contract, consumed by the dev-URL smoke check and by
 * deploy verification. `ok` is a literal `true`, not a boolean: a body that
 * says `{ ok: false }` must fail to parse rather than be reported as a
 * successfully-parsed failure.
 *
 * No timestamp field: a clock in the response makes the payload
 * non-deterministic and buys nothing the transport layer does not already
 * carry in `Date`.
 */
export const HealthReport = z.object({
  ok: z.literal(true),
  version: z.string().min(1).max(VERSION_MAX),
})
export type HealthReport = z.infer<typeof HealthReport>

// ---------------------------------------------------------------------------
// Data export — the DSR portability surface (`system.exportMyData`).
//
// These shapes are the WIRE form of the reviewed projection in
// tools/data-flow.json `export.projection` — profiles and memberships, exactly
// the columns a human reviewed there and no more. The projection file is the
// authority; these schemas are how it crosses the wire, so a column added to one
// without the other is a drift the export test suite catches. A vertical that
// stores the subject's data adds its own section to all three (the notes vertical
// that `init --with-demo` plants is the worked example of one).
// SOURCE: docs/runbooks/data-subject-requests.md (Art. 20 — the portability half)
// ---------------------------------------------------------------------------

/**
 * The unconditional LIMIT on the memberships read. A person's seat list is
 * small by nature (tens, not thousands), but the API doctrine admits no
 * unbounded read whatever the caller's expectations — 200 is an order of
 * magnitude past any real seat count while staying well under the PostgREST
 * `[api].max_rows` ceiling (1000), past which rows are truncated SILENTLY.
 * The honest limit: a subject holding more seats than this sees the first 200
 * (ordered by org id); the runbook records it beside the procedure.
 */
export const EXPORT_MEMBERSHIPS_LIMIT = 200

/**
 * The subject's own profiles row. `displayName` has NO min(1), unlike
 * ActorView's: the column default is '' and an export must return the stored
 * value verbatim, not fail to parse the account of someone who never set one.
 */
export const ProfileExport = z.object({
  createdAt: WireTimestamp,
  displayName: z.string().max(DISPLAY_NAME_MAX),
  id: z.uuid(),
  updatedAt: WireTimestamp,
})
export type ProfileExport = z.infer<typeof ProfileExport>

/**
 * One seat, as the reviewed projection returns it: the subject's RELATIONSHIP
 * to an org, which is exported precisely because the org row itself is not
 * (see tools/data-flow.json export.excluded — the org is another controller's
 * record).
 */
export const MembershipExport = z.object({
  createdAt: WireTimestamp,
  // eslint-disable-next-line local/org-id-from-session-only -- OUTPUT attribution, not an input field: this is a row the server READ BACK for the subject's archive, naming which org the seat is in (the reviewed export.projection's memberships.org_id). The rule's target is payload fields flowing INTO handlers; nothing parses this shape off a request.
  orgId: z.uuid(),
  /** Mirrors memberships_rank_known CHECK (role_rank IN (10,20,30,40)) — the tenancy ladder, closed like OrgRole. */
  roleRank: z.number().int().min(10).max(40),
  userId: z.uuid(),
})
export type MembershipExport = z.infer<typeof MembershipExport>

/**
 * The two self-reads' ROW shapes (snake_case, as the database returns them),
 * borrowing every field bound from the wire DTOs above so the two can never
 * drift — the rows.ts law, stated once, here, because this package owns zod:
 * the api package validates what it read against these before shaping the
 * wire form, and giving it a private zod dependency for two derived schemas
 * would put the same bound in two packages.
 */
export const ProfileExportRows = z.array(
  z.object({
    created_at: ProfileExport.shape.createdAt,
    display_name: ProfileExport.shape.displayName,
    id: ProfileExport.shape.id,
    updated_at: ProfileExport.shape.updatedAt,
  }),
)

export const MembershipExportRows = z.array(
  z.object({
    created_at: MembershipExport.shape.createdAt,
    org_id: MembershipExport.shape.orgId,
    role_rank: MembershipExport.shape.roleRank,
    user_id: MembershipExport.shape.userId,
  }),
)

/**
 * The export. Profile and memberships are small, so the whole archive is one
 * page; a vertical whose rows are unbounded adds a paged section and the cursor
 * that walks it.
 */
export const DataExportPage = z.object({
  memberships: z.array(MembershipExport).max(EXPORT_MEMBERSHIPS_LIMIT),
  profile: ProfileExport,
})
export type DataExportPage = z.infer<typeof DataExportPage>

/**
 * The input. NOTE THE ABSENCE, same law as every input in this file: no org
 * field, and nothing at all yet — the export reads the VERIFIED caller's own
 * rows, so there is nothing for a request to choose. `.strict()` makes a field a
 * client invents a parse failure rather than a silently ignored selector.
 */
export const ExportMyDataSchema = z.object({}).strict()
export type ExportMyDataSchema = z.infer<typeof ExportMyDataSchema>
