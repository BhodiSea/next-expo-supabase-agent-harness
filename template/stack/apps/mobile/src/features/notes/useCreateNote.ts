import { NewNoteInput, NOTE_TITLE_MAX, NoteDto } from '@app/contracts'
import { useCallback, useReducer, useRef } from 'react'
import { t } from '../../i18n'
import { translateError } from '../../i18n/errors'
import { apiPost } from '../../lib/api-client'

// The write-UX exemplar: ONE plain reducer drives the whole optimistic
// create-note lifecycle. Submit validates against the @app/contracts contract at
// the fetch boundary, inserts a temp row (pending: true) BEFORE the POST so the
// list answers instantly, then reconciles the temp row with the server row on
// 2xx or rolls it back (removes it) on failure — a single rollback path, no
// retry queue, no cache layer. Failures surface through the injected callback
// (the Toast pattern, same seam as useKeysetQuery's onLoadMoreError).
// SOURCE: harness doctrine — latency feel is a first-class UI concern; the
// optimistic row must never outlive a failed write [corpus: harness/doctrine]

/** What the list renders for an optimistic entry — temp while pending, server after. */
export interface ComposerRow {
  readonly id: string
  readonly title: string
  readonly pending: boolean
  /**
   * The server's creation timestamp, or null while the row is still optimistic. It is null
   * ON PURPOSE and not `Date.now()`: the client does not know when the note was created — the
   * server assigns that, and inventing a local guess would show the user a time that is about
   * to change under them. A pending row shows no time; the reconciled row shows the real one.
   */
  readonly createdAt: string | null
}

export type CreateNoteStatus = 'idle' | 'pending' | 'error'

export interface CreateNoteState {
  readonly status: CreateNoteStatus
  /** Inline catalog copy for the title field (Field renders it) — null when valid. */
  readonly fieldError: string | null
  /** Optimistic overlay, newest first: temp rows in flight, server rows once reconciled. */
  readonly rows: readonly ComposerRow[]
}

type CreateNoteAction =
  | { readonly type: 'reject'; readonly message: string }
  | { readonly type: 'start'; readonly row: ComposerRow }
  | { readonly type: 'settle'; readonly tempId: string; readonly row: ComposerRow }
  | { readonly type: 'fail'; readonly tempId: string }

const CREATE_NOTE_INITIAL: CreateNoteState = { status: 'idle', fieldError: null, rows: [] }

// Every transition is reachable through submit(), so the hook's unit tests
// drive the whole machine via the public API — nothing test-only is exported.
function createNoteReducer(state: CreateNoteState, action: CreateNoteAction): CreateNoteState {
  switch (action.type) {
    case 'reject': // contract validation failed — nothing was inserted
      return { ...state, status: 'idle', fieldError: action.message }
    case 'start': // optimistic insert at the head (newest first, like the server order)
      return { status: 'pending', fieldError: null, rows: [action.row, ...state.rows] }
    case 'settle': // reconcile: the server row replaces the temp row in place
      return {
        status: 'idle',
        fieldError: null,
        rows: state.rows.map((row) => (row.id === action.tempId ? action.row : row)),
      }
    case 'fail': // rollback: the temp row is REMOVED — never a phantom row after a failed write
      return {
        status: 'error',
        fieldError: null,
        rows: state.rows.filter((row) => row.id !== action.tempId),
      }
  }
}

export type SubmitOutcome = 'rejected' | 'settled' | 'failed'

// What the failure toast says. It used to be the raw error text — whatever the server, the
// fetch layer or a TypeError happened to produce, shown verbatim to the person who just tried
// to save a note. translateError() turns the envelope's stable `code` into catalog copy
// instead. The requestId is still quoted (that is what makes "it failed" a ticket an engineer
// can trace) but now through a message key, so the word "Reference" is translatable too.
function failureMessage(cause: unknown): string {
  const error = translateError(cause)
  if (error.requestId === null) return error.message
  return `${error.message} ${t('error.reference', { id: error.requestId.slice(0, 8) })}`
}

// PORT NOTE (desktop original used crypto.randomUUID): Hermes ships no Web
// Crypto, so the uuid comes from the global when the host has one (node under
// the unit runners, some dev hosts) and otherwise from Math.random. That is
// deliberately NOT a security decision to revisit: the temp id is a client-local
// placeholder that exists only until the server row replaces it — it is never
// sent, never stored, never an identity. What matters is the uuid SHAPE (the
// same 8-4-4-4-12 shape the server mints), so reconcile-by-id stays uniform and
// the row key never changes semantics.
function tempNoteId(): string {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const random = Math.trunc(Math.random() * 16)
    const value = ch === 'x' ? random : (random & 0x3) | 0x8
    return value.toString(16)
  })
}

export function useCreateNote(onFailure: (message: string) => void): {
  readonly state: CreateNoteState
  /** Validate → optimistic insert → POST → reconcile or rollback. */
  readonly submit: (input: { readonly title: string }) => Promise<SubmitOutcome>
} {
  const [state, dispatch] = useReducer(createNoteReducer, CREATE_NOTE_INITIAL)
  // Single-flight: the composer disables its button while pending; this ref
  // backstops against a second entry point racing the same reducer.
  const inFlight = useRef(false)

  const submit = useCallback(
    async (input: { readonly title: string }): Promise<SubmitOutcome> => {
      if (inFlight.current) return 'rejected'
      // Zod at the fetch boundary: invalid input never reaches the network and never
      // inserts a row. The CONTRACT decides validity; the CATALOG decides what the human
      // reads. Those used to be the same string, and that was the bug: zod's built-in
      // issue message is hardcoded English no translator can reach ("String must contain
      // at least 1 character(s)"), and the 'invalid input' fallback behind it was worse —
      // it told a user nothing and told a German user nothing in English. NOTE_TITLE_MAX
      // comes from the same contracts module the parse enforces, so the bound quoted in
      // the sentence cannot drift from the bound that actually rejected the input.
      const parsed = NewNoteInput.safeParse(input)
      if (!parsed.success) {
        dispatch({ type: 'reject', message: t('notes.composer.invalid', { max: NOTE_TITLE_MAX }) })
        return 'rejected'
      }
      // Temp id in the same uuid shape the server mints, so reconcile-by-id is
      // uniform and the row key never changes semantics.
      const tempId = tempNoteId()
      inFlight.current = true
      dispatch({
        type: 'start',
        row: { id: tempId, title: parsed.data.title, pending: true, createdAt: null },
      })
      try {
        // apiPost attaches the host-held bearer token and throws ApiRequestError
        // carrying the envelope's own message — so the ONE rollback path below covers
        // a 4xx, a 5xx, an offline socket, and an unauthenticated session alike.
        const response = await apiPost('/api/notes', parsed.data)
        const note = NoteDto.parse(await response.json())
        dispatch({
          type: 'settle',
          tempId,
          row: { id: note.id, title: note.title, pending: false, createdAt: note.createdAt },
        })
        return 'settled'
      } catch (cause) {
        dispatch({ type: 'fail', tempId })
        onFailure(failureMessage(cause))
        return 'failed'
      } finally {
        inFlight.current = false
      }
    },
    [onFailure],
  )

  return { state, submit }
}
