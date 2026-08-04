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
  // The columns are the numeric projection of a NoteView (@app/contracts) — the
  // ONE shape both surfaces render. They changed with the contract: `NoteView`
  // deliberately carries no `body` and no model-confidence column (the render
  // contract exposes an `excerpt` and a `hasBody` flag instead, so a list row
  // never ships a 20 000-character body it will not draw), so a "Body length"
  // or "Confidence" header here would be a column with nothing behind it.
  'matrix.column.note': 'Note',
  'matrix.column.hasBody': 'Has body',
  'matrix.column.title': 'Title length',
  'matrix.column.excerpt': 'Excerpt length',
  'matrix.column.words': 'Words',
  'matrix.column.archived': 'Archived',
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

  // ---- sign-in ----------------------------------------------------------------
  // Supabase Auth, email + password. The screen validates both fields inline
  // BEFORE any request (the Field/Input three-channel error contract) so a typo
  // never costs a round trip and never reads as a credential failure.
  'signin.title': 'Sign in',
  'signin.body': 'Sign in with the email and password for your account.',
  'signin.email.label': 'Email',
  'signin.email.placeholder': 'you@example.com',
  'signin.email.invalid': 'Enter an email address.',
  'signin.password.label': 'Password',
  'signin.password.placeholder': 'Your password',
  'signin.password.invalid': 'Enter your password.',
  'signin.submit': 'Sign in',
  'signin.pending': 'Signing in…',
  // The ONE sentence a failed sign-in may show. It does NOT distinguish "no such
  // account" from "wrong password", and that is a security decision, not vague
  // copy: a form that tells an attacker which half was right is an account
  // enumeration oracle. The provider's own message stays available as the quiet
  // technical detail underneath.
  'signin.failed': 'That email and password did not match an account.',

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
  // One line per AppError KIND (@app/errors), plus the one `code` override that
  // needs its own instruction. THAT union is what the client localizes; the
  // envelope's English `message` is a developer detail (and a support
  // reference), never the sentence a user is asked to read. src/i18n/errors.ts
  // pins the kind → key map exhaustively, so a kind with no line here is a
  // compile error rather than an untranslated string in production.
  'error.api.bad_request': 'That request was not valid.',
  'error.api.unauthorized': 'You are not signed in.',
  'error.api.forbidden': 'You do not have access to that.',
  'error.api.not_found': 'That item no longer exists.',
  'error.api.conflict': 'That changed somewhere else — reload and try again.',
  'error.api.rate_limited': 'Too many requests — wait a moment and try again.',
  'error.api.quota_exceeded':
    'This organization has reached its limit. Remove some items, or ask an admin to raise it.',
  'error.api.version_skew': 'This app is out of date — update to continue.',
  'error.api.internal': 'Something went wrong on the server.',
  'error.api.offline': 'Could not reach the server.',
  // The stable machine code quoted next to a failure — what turns "it failed"
  // into a ticket an engineer can trace. A key so the word "Reference"
  // translates too.
  'error.reference': 'Reference {id}',
} as const satisfies Record<string, Message>

export type MessageKey = keyof typeof en
export type Catalog = Readonly<Record<MessageKey, Message>>
