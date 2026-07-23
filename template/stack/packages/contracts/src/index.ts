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

/** Titles are single-line labels; 200 chars covers real titles without inviting body-in-title. */
export const NOTE_TITLE_MAX = 200
/** Bodies are prose, not blobs: 20 000 chars (~4 000 words), well under a 1 MiB request cap. */
export const NOTE_BODY_MAX = 20_000
/**
 * The excerpt is the list-row summary both surfaces render. 160 chars is two
 * comfortable lines on a phone at the body type scale and one line on the web
 * list — chosen so neither surface has to re-truncate and invent its own limit.
 */
export const NOTE_EXCERPT_MAX = 160

/**
 * Addresses are bounded by the SMTP path limit, not by a guess: RFC 5321 §4.5.3.1.3
 * fixes the maximum reverse/forward path at 256 octets, of which 320 is the
 * commonly-cited local@domain ceiling (64 local + 1 + 255 domain).
 * SOURCE: https://www.rfc-editor.org/rfc/rfc5321#section-4.5.3.1
 */
export const EMAIL_MAX = 320
/** Display names are UI labels, not prose. */
export const DISPLAY_NAME_MAX = 120
/** Semver-ish release strings; 64 chars leaves room for a build metadata tail. */
export const VERSION_MAX = 64
/**
 * timestamptz text. The longest form Postgres emits is well under 40 chars
 * ('2026-01-01T00:00:00.123456+00:00'); 64 leaves headroom for a longer zone
 * spelling without leaving the field effectively unbounded.
 */
export const TIMESTAMP_TEXT_MAX = 64

/**
 * Keyset pagination bounds. Defaults follow large public REST APIs (GitHub:
 * per_page default 30, max 100) scaled to this payload size; the max also caps
 * the DAL's LIMIT so no request can demand an unbounded scan.
 * SOURCE: https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api
 */
export const NOTES_PAGE_LIMIT_DEFAULT = 50
export const NOTES_PAGE_LIMIT_MAX = 200

/**
 * Page cursors are opaque tokens (base64url of the last row's keyset). 256
 * chars bounds the token while leaving headroom over the ~120 chars the server
 * actually emits.
 * SOURCE: opaque page tokens per Google AIP-158 https://google.aip.dev/158
 */
export const NOTES_CURSOR_MAX = 256

/**
 * The header the client stamps on every request with its own release version.
 * It lives HERE, not in the router, because both ends of the wire must agree on
 * the spelling: the mobile fetch layer sets it and the version-skew middleware
 * reads it. A second literal in a second package is how a guard goes silently
 * inert.
 */
export const CLIENT_VERSION_HEADER = 'x-client-version'

/**
 * Transport-level failure codes. These are NOT domain errors — domain failures
 * ride the data channel as the `ActionOutcome` envelope from `@app/errors` and
 * never appear here. This closed set is exactly the two conditions that are
 * rejected BEFORE any handler runs, so a client cannot receive an envelope for
 * them; the client normalize layer switches on these strings to fold them back
 * into the same discriminated union the screens already handle.
 */
export const TransportErrorCode = z.enum(['unauthorized', 'version_skew'])
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
 * that is re-bound into a query — the page cursor — is anchored at both ends by
 * its own schema in the notes vertical, where a loose tail is exploitable.
 */
export const WireTimestamp = z
  .string()
  .max(TIMESTAMP_TEXT_MAX)
  .regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/)
export type WireTimestamp = z.infer<typeof WireTimestamp>

/**
 * Workspace roles, ordered least to most privileged. A closed enum rather than
 * a free string: role checks are authorization decisions, and an unrecognised
 * role must fail parsing loudly rather than silently landing in a `default`
 * branch that grants nothing (or, worse, everything).
 */
export const MembershipRole = z.enum(['member', 'admin', 'owner'])
export type MembershipRole = z.infer<typeof MembershipRole>

// ---------------------------------------------------------------------------
// Note — the seeded reference entity
//
// Two shapes per entity, and the split is load-bearing:
//
//   *Record  the persisted contract. What the DAL parses rows INTO and what
//            server-side code reasons about. Carries ownership and lifecycle
//            columns the UI has no business rendering.
//   *View    the ONE shape both surfaces render. Web and mobile import the same
//            type, so a field rename is a compile error on both at once instead
//            of a silent divergence where the phone says `updatedAt` and the
//            web says `modified_at`.
//
// The Record -> View mapping is a single pure function in @app/notes; there is
// no second one, which is what keeps the two surfaces honest.
// ---------------------------------------------------------------------------

/**
 * The persisted note contract — the DAL's exit shape. Column names are
 * camelCased here on purpose: snake_case belongs to the table, and letting it
 * leak onto the wire welds every consumer to the physical schema.
 */
export const NoteRecord = z.object({
  archivedAt: WireTimestamp.nullable(),
  body: z.string().max(NOTE_BODY_MAX),
  createdAt: WireTimestamp,
  id: z.uuid(),
  ownerId: z.uuid(),
  title: z.string().min(1).max(NOTE_TITLE_MAX),
  updatedAt: WireTimestamp,
})
export type NoteRecord = z.infer<typeof NoteRecord>

/**
 * The render contract. `ownerId` is deliberately absent: the list a caller can
 * see is already the list RLS let through, so echoing the owner back adds an
 * identifier to every payload and buys the UI nothing.
 */
export const NoteView = z.object({
  createdAt: WireTimestamp,
  excerpt: z.string().max(NOTE_EXCERPT_MAX),
  hasBody: z.boolean(),
  id: z.uuid(),
  isArchived: z.boolean(),
  title: z.string().min(1).max(NOTE_TITLE_MAX),
  updatedAt: WireTimestamp,
})
export type NoteView = z.infer<typeof NoteView>

/**
 * Client-supplied fields only. `ownerId` is injected by the DAL from the
 * verified actor and must NEVER be accepted from the wire — an owner-bearing
 * create input is an account-takeover primitive dressed as a convenience.
 *
 * `body` is optional: the column default ('') stands in when the client omits it.
 */
export const NewNoteInput = z.object({
  body: z.string().max(NOTE_BODY_MAX).optional(),
  title: z.string().min(1).max(NOTE_TITLE_MAX),
})
export type NewNoteInput = z.infer<typeof NewNoteInput>

/**
 * A partial patch. The refinement rejects an empty patch outright rather than
 * letting it through as a no-op UPDATE: a no-op still bumps `updated_at`, which
 * reorders the list and invalidates every live cursor for no reason at all.
 */
export const NoteUpdateInput = z
  .object({
    body: z.string().max(NOTE_BODY_MAX).optional(),
    id: z.uuid(),
    isArchived: z.boolean().optional(),
    title: z.string().min(1).max(NOTE_TITLE_MAX).optional(),
  })
  .refine(
    (patch) =>
      patch.body !== undefined || patch.isArchived !== undefined || patch.title !== undefined,
    { message: 'an update must change at least one field' },
  )
export type NoteUpdateInput = z.infer<typeof NoteUpdateInput>

/** Addressing a single note. Its own schema so the router never hand-rolls `{ id }`. */
export const NoteRef = z.object({ id: z.uuid() })
export type NoteRef = z.infer<typeof NoteRef>

/**
 * List query — keyset pagination, never OFFSET. An offset scan re-reads and
 * re-discards every skipped row, so page 500 costs 500 pages of work; a keyset
 * seek is O(page) regardless of depth.
 * SOURCE: https://use-the-index-luke.com/no-offset
 */
export const NotesListQuery = z.object({
  cursor: z
    .string()
    .min(1)
    .max(NOTES_CURSOR_MAX)
    .regex(/^[A-Za-z0-9_-]+$/) // base64url alphabet — anything else is not our token
    .optional(),
  includeArchived: z.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(NOTES_PAGE_LIMIT_MAX).default(NOTES_PAGE_LIMIT_DEFAULT),
})
export type NotesListQuery = z.infer<typeof NotesListQuery>

/** One page of the render shape, plus the cursor for the next. */
export const NotesPage = z.object({
  items: z.array(NoteView).max(NOTES_PAGE_LIMIT_MAX),
  nextCursor: z.string().min(1).max(NOTES_CURSOR_MAX).nullable(),
})
export type NotesPage = z.infer<typeof NotesPage>

/** What a delete reports back: enough to reconcile a client cache, nothing more. */
export const NoteDeletion = z.object({ id: z.uuid() })
export type NoteDeletion = z.infer<typeof NoteDeletion>

// ---------------------------------------------------------------------------
// Actor — the second entity, and the reason the ladder above `publicProcedure`
// exists at all.
// ---------------------------------------------------------------------------

/**
 * The signed-in caller as both surfaces render it. `role`/`workspaceId` are
 * nullable because an authenticated user with no active membership is a real,
 * reachable state (invitation pending, seat revoked, trial lapsed) — modelling
 * it as impossible is how a signed-in user ends up staring at a crash screen.
 */
export const ActorView = z.object({
  displayName: z.string().min(1).max(DISPLAY_NAME_MAX),
  email: z.string().max(EMAIL_MAX).nullable(),
  id: z.uuid(),
  role: MembershipRole.nullable(),
  workspaceId: z.uuid().nullable(),
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
