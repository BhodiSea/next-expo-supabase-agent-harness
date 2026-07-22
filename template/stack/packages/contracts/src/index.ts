import { z } from 'zod'

// ---------------------------------------------------------------------------
// @app/contracts — the wire contracts, hand-authored in pure Zod. This package
// is the ONLY schema surface the mobile client may import (the architecture
// gate's mobile-contracts-not-schema rule): @app/schema keeps the drizzle
// table/policy definitions server-side, and the drift test in
// packages/schema/src/schema.test.ts proves these hand-authored DTOs stay
// structurally equal to what drizzle-zod would derive from the table — the
// single-source discipline survives the split as a test instead of a derivation.
// ---------------------------------------------------------------------------

/**
 * Single source of truth for the pgvector embedding dimension. The
 * `notes.embedding` column (packages/schema), the NoteDto below, and the
 * hand-authored migration in packages/schema/drizzle are all asserted against
 * this value (schema.test.ts).
 */
export const EMBEDDING_DIM = 1024

// ---------------------------------------------------------------------------
// Wire bounds — every string/number crossing the API boundary carries explicit
// limits. Unbounded wire input is a memory/storage amplification primitive, so
// contracts reject it at the edge instead of trusting callers.
// SOURCE: harness doctrine — contracts are the enforcement surface; no
// unbounded wire input [corpus: harness/doctrine]
// ---------------------------------------------------------------------------

/** Titles are single-line labels; 200 chars covers real titles without inviting body-in-title. */
export const NOTE_TITLE_MAX = 200
/** Bodies are prose, not blobs: 20 000 chars (~4 000 words), well under the 1 MiB HTTP body cap. */
export const NOTE_BODY_MAX = 20_000
/** Model identifiers ("gpt-…", "claude-…", registry paths) fit comfortably in 128 chars. */
export const SOURCE_MODEL_MAX = 128

/**
 * Keyset pagination bounds for GET /api/notes. Defaults follow large public
 * REST APIs (GitHub: per_page default 30, max 100) scaled to this payload
 * size; the max also caps the DAL's LIMIT so no request demands an unbounded scan.
 * SOURCE: https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api
 */
export const NOTES_PAGE_LIMIT_DEFAULT = 50
export const NOTES_PAGE_LIMIT_MAX = 200

/**
 * Page cursors are opaque tokens (base64url JSON of the last row's keyset).
 * 256 chars bounds the token while leaving headroom over the ~120 chars the
 * server actually emits.
 * SOURCE: opaque page tokens per Google AIP-158 https://google.aip.dev/158
 */
export const NOTES_CURSOR_MAX = 256

// timestamptz over the wire: the ISO-8601 or Postgres text form
// ('2026-01-01T00:00:00.000Z' / '2026-01-01 00:00:00.123456+00'). The DAL keeps
// the driver text verbatim (never re-parsed through a millisecond-truncating
// Date) because keyset cursors compare it back against the column.
const timestampText = (schema: z.ZodString) =>
  schema.regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/).max(64)

/**
 * Row shape the DAL returns (drizzle select + Zod parse at the DAL exit).
 *
 * Hand-authored equivalent of drizzle-zod's createSelectSchema(notes) with the
 * bound refinements below — nullable columns are .nullable(), the uuid columns
 * keep the derived uuid check, and the embedding array is pinned to
 * EMBEDDING_DIM. The schema drift test asserts structural equality with the
 * live derivation, so this object cannot rot as the table evolves.
 */
export const NoteDto = z.object({
  body: z.string().max(NOTE_BODY_MAX),
  createdAt: timestampText(z.string()),
  embedding: z.array(z.number()).length(EMBEDDING_DIM).nullable(),
  id: z.uuid(),
  ownerId: z.uuid(),
  sourceConfidence: z.number().min(0).max(1).nullable(), // provenance confidence is a probability
  sourceModel: z.string().max(SOURCE_MODEL_MAX).nullable(),
  title: z.string().min(1).max(NOTE_TITLE_MAX),
})
export type Note = z.infer<typeof NoteDto>

/**
 * Client-supplied fields only: `owner_id` is injected by the DAL from the
 * verified token subject and must never be accepted from the wire.
 *
 * body is .optional() — the column default ('') stands in when the client
 * omits it, mirroring what createInsertSchema derives for a defaulted column.
 */
export const NewNoteInput = z.object({
  body: z.string().max(NOTE_BODY_MAX).optional(),
  title: z.string().min(1).max(NOTE_TITLE_MAX),
})
export type NewNote = z.infer<typeof NewNoteInput>

/**
 * Query contract for GET /api/notes — keyset pagination, never OFFSET (an
 * offset scan re-reads and re-discards every skipped row; a keyset seek is
 * O(page) regardless of depth).
 * SOURCE: https://use-the-index-luke.com/no-offset
 */
export const NotesListQuery = z.object({
  cursor: z
    .string()
    .min(1)
    .max(NOTES_CURSOR_MAX)
    .regex(/^[A-Za-z0-9_-]+$/) // base64url alphabet — anything else is not our token
    .optional(),
  limit: z.coerce.number().int().min(1).max(NOTES_PAGE_LIMIT_MAX).default(NOTES_PAGE_LIMIT_DEFAULT),
})
export type NotesListQueryInput = z.infer<typeof NotesListQuery>

/** Response contract for GET /api/notes: one page + the cursor for the next. */
export const NotesPage = z.object({
  items: z.array(NoteDto).max(NOTES_PAGE_LIMIT_MAX),
  nextCursor: z.string().min(1).max(NOTES_CURSOR_MAX).nullable(),
})
export type NotesPageDto = z.infer<typeof NotesPage>

/** Contract for GET /healthz — `{ ok: true, version }`, no auth. */
export const HealthResponse = z.object({
  ok: z.literal(true),
  version: z.string().max(64),
})
export type Health = z.infer<typeof HealthResponse>

/**
 * The single error envelope: EVERY non-2xx JSON body the server emits —
 * validation failures, auth rejections, 404s, version skew, body-limit
 * rejections, and uncaught exceptions — parses against this schema. `code` is
 * the stable machine-readable contract clients switch on; `message` is for
 * humans and logs; `requestId` correlates a client-visible failure with server
 * logs. The nested code/message envelope follows the Microsoft REST API
 * Guidelines error shape (same family as Google's JSON `error.code/message`).
 * SOURCE: https://github.com/microsoft/api-guidelines/blob/vNext/azure/Guidelines.md
 */
export const ApiError = z.object({
  error: z.object({
    code: z.enum([
      'bad_request',
      'unauthorized',
      'not_found',
      'payload_too_large',
      'version_skew',
      'internal',
    ]),
    message: z.string().min(1).max(1024),
    requestId: z.guid().optional(),
  }),
})
export type ApiErrorBody = z.infer<typeof ApiError>
export type ApiErrorCode = ApiErrorBody['error']['code']
