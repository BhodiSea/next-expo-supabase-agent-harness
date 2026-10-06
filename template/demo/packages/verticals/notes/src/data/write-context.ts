import type { NoteEventSink } from '../events.js'
import type { NoteWriteContext } from './notes.js'

// ---------------------------------------------------------------------------
// The ONE place a NoteWriteContext is built. Both transports call it: the tRPC
// router's writeContext (packages/api/src/routers/notes.ts) and the web Server
// Action (apps/web/app/actions/notes.ts). Before it, each spelled the context
// out its own way, and the action's copy carried a no-op sink of its own, so a
// project that wired an event sink would have heard every tRPC write and none
// of the web's.
//
// Its own module, not data/notes.ts: query-probes.ts re-exports that file as the
// DAL, and gen-query-shapes fails generation on an exported function that no
// probe drives or that issues no query. This one never touches a database.
// ---------------------------------------------------------------------------

/**
 * Assemble what a write needs beyond its input. `actorId` comes from the
 * VERIFIED actor and `orgId` from the RESOLVED org, never from the input, and
 * `emit` and `now` are the caller's request ports, passed through unchanged.
 * The tRPC context satisfies `ports` as it is, because its `EventSink` accepts
 * every event a `NoteEventSink` is handed.
 */
export function noteWriteContext(
  actor: { readonly userId: string },
  org: { readonly id: string },
  ports: { readonly emit: NoteEventSink; readonly now: string },
): NoteWriteContext {
  return {
    actorId: actor.userId,
    emit: ports.emit,
    now: ports.now,
    orgId: org.id,
  }
}
