import type {
  HealthReport,
  NewNoteInput,
  NotesListQuery,
  NotesPage,
  NoteView,
} from '@app/contracts'
import type { ActionOutcome } from '@app/errors'
import type { ApiClient } from '../lib/trpc/use-api'

// The network seam for component and screen tests, and the reason it moved.
//
// It used to wrap global `fetch`: the app had exactly one caller of fetch (an
// HTTP client module), so intercepting fetch mocked the whole network in one
// move while that client's real code — origin resolution, bearer attachment,
// envelope decoding — still ran. That property is what made it worth doing.
//
// Under tRPC it stops being true. `httpBatchLink` coalesces N procedure calls
// into ONE request whose URL is a comma-joined procedure list and whose body is
// a positional map, and whose response is a positional ARRAY of
// `{ result: { data } }` / `{ error: { … } }` frames. A fetch-level fake would
// therefore have to reimplement tRPC's batch wire format to answer at all — and
// a test double that reimplements a protocol is a test of that reimplementation.
// It would go green against a batch encoding the installed client had stopped
// using, which is the worst failure a seam can have.
//
// So the seam moved UP one layer, to the typed client. What is still under test:
// every screen, every hook, the contract parses, and `callProcedure` — the fold
// that makes one envelope true end to end (src/lib/trpc/normalize.ts). What is
// no longer under test here: the HTTP link itself (batching, the bearer header,
// the origin). That is honest rather than free — those belong to a lane that can
// speak to a real server, and pretending a hand-written fetch stub covered them
// was the more expensive lie.

/** A procedure handler: input in, the procedure's own return shape out. */
export type MockProcedure<I, O> = (input: I) => O | Promise<O>

/**
 * The procedures this app actually calls, named ONE BY ONE rather than as an
 * open `Record<string, …>`. An open map would let a test stub a procedure that
 * does not exist and pass; this list is a census of the app's real API surface,
 * so adding a call site means adding a line here — which is exactly the moment
 * to notice a new server dependency.
 */
export interface MockApiHandlers {
  /** `notes.create` — the envelope; a domain refusal is `{ ok: false }`, never a throw. */
  readonly notesCreate?: MockProcedure<NewNoteInput, ActionOutcome<NoteView>>
  /**
   * `notes.list` — the envelope wrapping one keyset page.
   *
   * `Partial<NotesListQuery>` deliberately. The contract's `limit` and
   * `includeArchived` carry zod DEFAULTS, and a default is applied by the
   * parse — which happens on the SERVER. What actually leaves the client is
   * whatever the screen passed, so a handler typed against the parsed shape
   * would promise a `limit` this double never fills in, and a test asserting on
   * it would be asserting a value no request contains.
   */
  readonly notesList?: MockProcedure<Partial<NotesListQuery>, ActionOutcome<NotesPage>>
  /** `system.health` — the ONE un-enveloped procedure (health has no failure mode). */
  readonly systemHealth?: MockProcedure<undefined, HealthReport>
}

let handlers: MockApiHandlers | null = null

/**
 * Reject an unstubbed call LOUDLY, and synchronously.
 *
 * Synchronously is the load-bearing half. A rejected promise here would be
 * caught by `callProcedure` and folded into `appError.unavailable()` — the
 * offline variant — so a test that forgot to stub a procedure would render a
 * plausible "could not reach the server" surface and pass or fail for a reason
 * unrelated to what it was written to check. Throwing before a promise exists
 * puts the message where the test author will read it.
 */
function unstubbed(procedure: string): never {
  throw new Error(
    `mock server: no handler installed for ${procedure} — declare it in installMockServer(), ` +
      'or the screen under test is calling a procedure the test did not expect',
  )
}

function live(): MockApiHandlers {
  if (handlers === null) {
    throw new Error('mock server: not installed — call installMockServer() first')
  }
  return handlers
}

/**
 * A stand-in for the typed tRPC client.
 *
 * IDENTITY-STABLE, and that is not tidiness. The real `useApi()` returns one
 * client per session precisely so `useEffect`/`useCallback` can depend on it;
 * a double that minted a fresh object per render would make every one of those
 * dependencies change every render — `useKeysetQuery`'s initial-load effect
 * would re-fire forever and the suite would hang rather than fail. One object
 * for the process, reading a mutable handler table, keeps the double honest
 * about the property the production hook guarantees.
 *
 * The cast is the one this file cannot avoid: `ApiClient` is tRPC's recursive
 * proxy type, carrying inference machinery (`$types`, per-procedure option
 * overloads) that no hand-written object literal can structurally satisfy. It is
 * contained HERE, in a test-only module, and the shape it produces is checked
 * where it matters — each handler's input and output are typed against the same
 * @app/contracts declarations the real procedures use, so a contract change reds
 * the fixtures instead of silently letting them lie.
 */
let client: ApiClient | null = null

export function mockApiClient(): ApiClient {
  client ??= buildClient()
  return client
}

function buildClient(): ApiClient {
  return {
    notes: {
      create: {
        mutate: (input: NewNoteInput) => {
          const handler = live().notesCreate ?? unstubbed('notes.create')
          return Promise.resolve(handler(input))
        },
      },
      list: {
        query: (input: Partial<NotesListQuery>) => {
          const handler = live().notesList ?? unstubbed('notes.list')
          return Promise.resolve(handler(input))
        },
      },
    },
    system: {
      health: {
        query: () => {
          const handler = live().systemHealth ?? unstubbed('system.health')
          return Promise.resolve(handler(undefined))
        },
      },
    },
  } as unknown as ApiClient
}

/** Install the procedure table for one test. Paired with uninstall in afterEach. */
export function installMockServer(next: MockApiHandlers): void {
  if (handlers !== null) throw new Error('mock server already installed — uninstall first')
  handlers = next
}

export function uninstallMockServer(): void {
  handlers = null
}
