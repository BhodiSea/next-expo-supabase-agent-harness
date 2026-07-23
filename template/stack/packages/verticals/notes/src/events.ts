import { defineEventCatalog, type EventDefinition } from '@app/events'

// ---------------------------------------------------------------------------
// The events this vertical emits.
//
// Declared HERE, beside the code that emits them, and registered through
// @app/events' `defineEventCatalog` so the contracts generator can walk them.
// The platform registry owns the MECHANISM; it does not own the declarations —
// a registry that authored every vertical's events would be a file every slice
// has to edit, which is the shared-file contention this layout exists to avoid.
//
// Three properties are deliberate and all three are load-bearing:
//
//   1. Payload fields are PLAIN types — strings, booleans, string arrays. No zod
//      schema, no imported union. Analytics rows outlive the code that wrote
//      them: binding a warehouse column to a live union makes a rename rewrite
//      history. (@app/events module header states the same rule.)
//   2. The constructors are PURE. `occurredAt` is a parameter, never
//      `Date.now()`. Callers pass the instant the DATABASE assigned (the row's
//      created_at / updated_at), so the event timeline and the row timeline are
//      the same timeline — no client clock and no second server can reorder it.
//   3. The payloads carry IDENTIFIERS, never note content. An event stream is
//      copied into logs, traces and analytics sinks with retention and access
//      rules the notes table never agreed to; putting a body in one exports the
//      data past its own RLS policy.
// ---------------------------------------------------------------------------

/** Which fields an update touched. Named WHAT changed, never what it changed to. */
export type NoteField = 'body' | 'isArchived' | 'title'

/** Everything every note event carries. */
export interface NoteEventBase {
  readonly actorId: string
  readonly noteId: string
  /** ISO-8601 UTC, taken from the row the database wrote. */
  readonly occurredAt: string
  /** Null for an actor with no active membership — a reachable state, not an error. */
  readonly workspaceId: string | null
}

export type NoteCreatedPayload = NoteEventBase

export interface NoteUpdatedPayload extends NoteEventBase {
  readonly fields: readonly NoteField[]
}

export type NoteDeletedPayload = NoteEventBase

// The declaration idiom is an ANNOTATED const: the annotation is what carries
// the phantom payload type into the catalog. A `satisfies` clause would keep
// only the literal's inferred shape and silently drop the payload.
const noteCreatedEvent: EventDefinition<'notes.created', NoteCreatedPayload> = {
  name: 'notes.created',
  version: 1,
  description: 'A note was inserted by its owner.',
}

const noteUpdatedEvent: EventDefinition<'notes.updated', NoteUpdatedPayload> = {
  name: 'notes.updated',
  version: 1,
  description: 'One or more fields of an existing note changed, including archive state.',
}

const noteDeletedEvent: EventDefinition<'notes.deleted', NoteDeletedPayload> = {
  name: 'notes.deleted',
  version: 1,
  description: 'A note was removed permanently. Archiving is an update, not this.',
}

/** The vertical's catalog. The generator walks it exactly as it walks the platform's. */
export const noteEvents = defineEventCatalog({
  'notes.created': noteCreatedEvent,
  'notes.deleted': noteDeletedEvent,
  'notes.updated': noteUpdatedEvent,
})

/**
 * An emitted event: the wire name plus its payload.
 *
 * Discriminated on `name`, so a sink's `switch` is exhaustive-checkable and a
 * newly declared event reds every consumer that forgot it — which is the point
 * of a closed union rather than a bag of loose objects.
 */
export type NoteEvent =
  | { readonly name: 'notes.created'; readonly payload: NoteCreatedPayload }
  | { readonly name: 'notes.deleted'; readonly payload: NoteDeletedPayload }
  | { readonly name: 'notes.updated'; readonly payload: NoteUpdatedPayload }

/**
 * The sink the vertical writes to. Contravariant by design: a host that accepts
 * any `{ name, payload }` event — the platform's observability sink — is
 * assignable here, so the vertical never has to know which sink it got.
 *
 * Synchronous, returning void: emitting must not be able to fail a write that
 * already committed. A sink needing IO buffers internally.
 */
export type NoteEventSink = (event: NoteEvent) => void

interface EventOrigin {
  readonly actorId: string
  readonly workspaceId: string | null
}

export function noteCreated(origin: EventOrigin, noteId: string, occurredAt: string): NoteEvent {
  return {
    name: 'notes.created',
    payload: { actorId: origin.actorId, noteId, occurredAt, workspaceId: origin.workspaceId },
  }
}

export function noteUpdated(
  origin: EventOrigin,
  noteId: string,
  occurredAt: string,
  fields: readonly NoteField[],
): NoteEvent {
  return {
    name: 'notes.updated',
    payload: {
      actorId: origin.actorId,
      fields,
      noteId,
      occurredAt,
      workspaceId: origin.workspaceId,
    },
  }
}

export function noteDeleted(origin: EventOrigin, noteId: string, occurredAt: string): NoteEvent {
  return {
    name: 'notes.deleted',
    payload: { actorId: origin.actorId, noteId, occurredAt, workspaceId: origin.workspaceId },
  }
}
