import type { EventSink } from '@app/api'

// The web host's request ports: where a write's domain events go, and the instant it happened.
//
// ONE SOURCE, because the host has two write transports. The tRPC route hands these to
// @app/api's createContext, and a Server Action hands them to the vertical's write-context
// builder. Before this file each spelled its own: the route passed nothing (so createContext
// fell back to its own drop sink and its own clock) and the action wrote a no-op sink and a
// `new Date()` inline. Both dropped every event, but the first project to wire a sink in one
// place would have heard one transport and not the other, with nothing turning red.
//
// THE SINK STILL DROPS EVERY EVENT, on purpose: this host has nowhere to send them yet. Wiring
// one is a change to `emit` below and nowhere else, and both transports pick it up.
// Synchronous and void, like every EventSink: a sink must not be able to fail a write that
// already committed, so one that needs IO buffers internally.
// SOURCE: packages/api/src/context.ts (CreateContextOptions.emit and .now)

/** No sink is wired on this host, so an event is dropped here, for both transports at once. */
const emit: EventSink = () => undefined

/**
 * The ports for one request. Call it once per request and pass the result on: `now` is minted
 * here, so every write in the request shares one instant.
 */
export function requestPorts(): { readonly emit: EventSink; readonly now: string } {
  return { emit, now: new Date().toISOString() }
}
