// The message catalog — the ONE place user-facing copy lives.
//
// Every string the UI shows is a key here. That is not a style preference: a literal in a
// component is a string no translator can reach, no reviewer can find, and no gate can see.
// The i18n gate reds on a hardcoded user-facing literal anywhere under apps/mobile/src, and
// the pseudo-locale lane proves it behaviourally — under `en-XA` every catalog string is
// visibly mangled, so any plain-English text still on screen is, by construction, a string
// that bypassed this file.
//
// SHAPE. A message is either a plain string or a plural set keyed by CLDR category. `t()`
// picks the category with Intl.PluralRules for the ACTIVE locale, so "1 row" / "2 rows" is
// the language's rule, not English's — a language with a dual or a paucal form gets its own
// branch by adding the key, with no code change.
//
// PLACEHOLDERS are `{name}`. Numbers interpolated through them are formatted with
// Intl.NumberFormat, so a thousands separator is the locale's, not a hardcoded comma.
// SOURCE: Unicode CLDR plural rules — the categories Intl.PluralRules selects between
// https://cldr.unicode.org/index/cldr-spec/plural-rules [corpus: unicode/cldr-plurals]

/** A plural set. `other` is required — it is the fallback for every category a locale lacks. */
interface PluralMessage {
  readonly zero?: string
  readonly one?: string
  readonly two?: string
  readonly few?: string
  readonly many?: string
  readonly other: string
}

export type Message = string | PluralMessage

export const en = {
  // ---- shell ------------------------------------------------------------------
  'route.home': 'Home',
  'route.matrix': 'Matrix',
  'route.actions': 'Actions',

  // ---- common -----------------------------------------------------------------
  'common.reload': 'Try again',
  'common.retry': 'Retry',
  'common.loading': 'Loading…',
  'common.dismiss': 'Dismiss notification',

  // ---- notes (the home screen's data panel) -------------------------------------
  'notes.heading': 'Notes',
  'notes.error.title': 'Could not load notes.',
  'notes.empty.title': 'No notes yet',
  'notes.empty.description': 'The first note you create will appear here.',
  'notes.composer.label': 'Add a note',
  'notes.composer.placeholder': 'Note title',
  'notes.composer.submit': 'Add note',
  'notes.composer.pending': 'Adding…',
  'notes.composer.invalid': 'Enter a title between 1 and {max} characters.',
  'notes.createdAt': 'Created {when}',
  // The accessible name of an optimistic row: ONE key, not the title glued to a
  // status fragment — a locale is free to reorder the two halves.
  'notes.row.pending': '{title} — not yet saved',

  // ---- matrix -----------------------------------------------------------------
  'matrix.heading': 'Matrix',
  'matrix.list': 'Notes matrix',
  'matrix.error.title': 'Could not load the matrix.',
  'matrix.empty.title': 'No rows to chart yet',
  'matrix.empty.description':
    'Once notes exist, their numeric columns appear here as a dense, virtualized matrix.',
  // Plural on the ROW count — "1 rows" must be unconstructable.
  'matrix.summary': {
    one: '{rows} row × {columns} columns, virtualized.',
    other: '{rows} rows × {columns} columns, virtualized.',
  },
  'matrix.pagination.hint': 'Scrolling to the end loads more rows.',
  'matrix.loadMore': 'Load more',
  'matrix.loadingMore': 'Loading…',
  'matrix.loadMore.failed': 'Loading more failed.',
  // `{message}` is the server's envelope text — a support detail we interpolate,
  // never copy we author. The sentence around it is the catalog's.
  'matrix.loadMore.toast': 'Could not load more rows: {message}',
  'matrix.column.note': 'Note',
  'matrix.column.confidence': 'Confidence',
  'matrix.column.title': 'Title length',
  'matrix.column.body': 'Body length',
  'matrix.column.words': 'Words',
  'matrix.column.lines': 'Lines',
  'matrix.column.day': 'Day',
  'matrix.row': 'Row {n}',

  // ---- actions ----------------------------------------------------------------
  'actions.search': 'Search actions',
  'actions.placeholder': 'Type an action…',
  'actions.noMatch.title': 'No matching action',
  'actions.noMatch.description': 'Try a different search term.',
  // Section headers, keyed by the machine group id (`actions.group.<id>`) — the
  // registry's group union carries IDS, never copy (see features/actions/registry.ts).
  'actions.group.recents': 'Recents',
  'actions.group.navigation': 'Navigation',
  'actions.group.notes': 'Notes',
  'actions.group.session': 'Session',
  'command.goHome': 'Go to Home',
  'command.goMatrix': 'Go to Matrix',
  'command.createNote': 'Create a note',
  'command.signOut': 'Sign out',
  'command.deleteAccount': 'Delete account…',
  // In-app account deletion (Apple 5.1.1(v)) — the ellipsis on the command and
  // this native confirm are the deliberate two-step.
  'account.delete.confirmTitle': 'Delete account?',
  'account.delete.confirmBody':
    'This permanently deletes your data on this server and signs you out. It cannot be undone.',
  'account.delete.confirm': 'Delete',
  'account.delete.cancel': 'Cancel',

  // ---- sign-in (dev) ----------------------------------------------------------
  'signin.title': 'Sign in',
  'signin.body':
    'Development sign-in: mints a local token from the API server’s stub authority. Production auth (Entra) replaces this screen.',
  'signin.subject.label': 'Dev subject (optional)',
  'signin.subject.placeholder': 'uuid — blank mints a fresh user',
  'signin.subject.invalid': 'Must be a uuid (8-4-4-4-12 hex) or blank.',
  'signin.submit': 'Sign in (dev)',
  'signin.pending': 'Signing in…',
  // Entra mode (rendered when EXPO_PUBLIC_ENTRA_* IDs are present — see
  // src/auth/providers/entra.ts).
  'signin.entra.body': 'Sign in with your organization’s Microsoft Entra account.',
  'signin.entra.submit': 'Sign in with Microsoft',

  // ---- perf harness (dev chrome — app/perf-harness.tsx) ------------------------
  'perf.title': 'Performance harness',
  'perf.running': 'Measuring interaction latency…',
  'perf.pass': 'All interaction budgets pass',
  'perf.fail': 'Interaction budget exceeded',
  // {metric} is a machine id (tabSwitchMs / actionsOpenMs / droppedFrames) — a
  // diagnostic key, deliberately untranslated; the numbers localize via t().
  'perf.over': '{metric}: measured {measured}, budget {cap}',
  'perf.unavailable': 'The performance harness is a development-build surface.',

  // ---- not found --------------------------------------------------------------
  'notFound.title': 'Screen not found',
  'notFound.body': 'That link does not match any screen in this app.',
  'notFound.home': 'Go home',

  // ---- connection -------------------------------------------------------------
  'connection.connecting': 'Connecting to API…',
  'connection.connected': 'API connected (v{version})',
  'connection.unreachable': 'API unreachable — retrying',

  // ---- errors -----------------------------------------------------------------
  'error.title': 'Something went wrong',
  'error.body': 'An unexpected error occurred while rendering this screen.',
  // The server's error envelope carries a stable `code` — THAT is what the client
  // localizes. The server's English `message` is a developer detail (and a support
  // reference), never the sentence a user is asked to read.
  'error.api.bad_request': 'That request was not valid.',
  'error.api.unauthorized': 'You are not signed in.',
  'error.api.not_found': 'That item no longer exists.',
  'error.api.payload_too_large': 'That is too large to send.',
  'error.api.version_skew': 'This app is out of date — update to continue.',
  'error.api.internal': 'Something went wrong on the server.',
  'error.api.unknown': 'The request failed ({status}).',
  'error.api.offline': 'Could not reach the server.',
  // The requestId suffix quoted next to a failure — what turns "it failed" into
  // a ticket an engineer can trace. A key so the word "Reference" translates too.
  'error.reference': 'Reference {id}',
} as const satisfies Record<string, Message>

export type MessageKey = keyof typeof en
export type Catalog = Readonly<Record<MessageKey, Message>>
