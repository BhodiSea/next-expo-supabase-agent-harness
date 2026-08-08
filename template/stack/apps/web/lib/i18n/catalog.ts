// The web message catalog — the ONE place user-facing copy lives on this surface.
//
// The mobile twin is apps/mobile/src/i18n/catalog.ts and this file is deliberately the same
// SHAPE: same `Message` union, same `{name}` placeholders, same CLDR plural categories, same
// key style. Two surfaces of one product should not need two mental models for copy, and the
// `i18n` gate reads both roots with one set of rules.
//
// WHY THE WEB HALF EXISTS AT ALL (0.6.0). Through 0.5.0 the `i18n` gate's scan root was
// `apps/mobile/src` and nothing else, which docs/harness/enforcement-tiers.md recorded as a
// declared tier: "the web app has no catalog seam and no `Intl` confinement, so a hardcoded
// user-facing string in a Server Component is caught by nothing." That row carried
// `Target 0.6.0`, and `Target` is a commitment the docs-sync gate now reads. This is the
// commitment being met rather than moved a second time.
//
// WHAT THIS SURFACE DOES NOT NEED, stated so the asymmetry is a decision and not a gap:
// Hermes ships no Intl.PluralRules / RelativeTimeFormat / Locale, so the mobile seam force-
// installs @formatjs polyfills plus per-language CLDR data and the gate holds that closure.
// Node and every browser ship full ICU, so the web half has no polyfill layer to close over.
// The gate scopes check 4 to the mobile surface for that reason — see check-i18n.mjs.
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
  // ---- app shell / document titles --------------------------------------------
  // These are the strings `generateMetadata` renders into <title>. They are copy in the
  // fullest sense — a search result and a browser tab are both places a human reads them.
  'app.description': 'Next.js web client and API host.',
  'route.home': 'Welcome',
  'route.signIn': 'Sign in',
  'route.orgs': 'Organizations',
  'route.notes': 'Notes',
  'route.acceptInvite': 'Accept invitation',

  // ---- the unmatched-route surface --------------------------------------------
  // app/not-found.tsx is REQUIRED chrome (the route-manifest gate reds on its absence): without
  // it a mistyped or stale deep link renders Next's built-in 404, which is unbranded and
  // untranslated. It is one of the few screens a user reaches while already confused, so the
  // copy says what happened and offers exactly one way back.
  'notFound.title': 'This page does not exist',
  'notFound.description':
    'The link may be out of date, or the address may have a typo in it. Nothing was lost.',
  'notFound.home': 'Go to the home page',

  // ---- loading regions ---------------------------------------------------------
  // The `aria-label` on each route's loading.tsx. Skeletons are aria-hidden by construction, so
  // this is the ONE thing a screen reader hears while a segment streams — which makes it copy,
  // not decoration, and it belongs here like every other sentence.
  'orgs.loading': 'Loading your organizations',
  'notes.loading': 'Loading notes',

  // ---- home -------------------------------------------------------------------
  'home.lede':
    'One Supabase backend, two surfaces: this web app and the Expo client. Both call the same tRPC router and the same domain packages — the API you are looking at is served from this deployment.',
  'home.signIn': 'Sign in',
  'home.openApp': 'Go to your organizations',

  // ---- auth -------------------------------------------------------------------
  'auth.signIn': 'Sign in',
  'auth.signOut': 'Sign out',
  'auth.email': 'Email',
  'auth.password': 'Password',
  'auth.signIn.lede':
    'Your session is verified server-side on every request, and every row you can reach is decided by row-level security in Postgres — never by this browser.',

  // ---- organizations ----------------------------------------------------------
  'nav.organization': 'Organization',
  'orgs.empty.title': 'You are not in any organization yet.',
  'orgs.empty.description':
    'Create your personal workspace to get started, or open an invitation link someone sent you.',
  'orgs.create': 'Create my workspace',

  // ---- notes ------------------------------------------------------------------
  'notes.new': 'New note',
  'notes.add': 'Add note',
  'notes.empty.title': 'No notes yet',
  'notes.empty.description': 'Anything you write here is visible to everyone in this organization.',

  // ---- invitations ------------------------------------------------------------
  'invite.accept': 'Accept invitation',
  'invite.lede':
    'Accepting adds your account to the organization that issued this link. The link works once and then stops working.',

  // ---- the error envelope, by KIND --------------------------------------------
  // Chosen from `kind` + `code`, NEVER from `error.message`: AppError.message is documented
  // as developer-facing English for logs, written by whichever layer constructed the error,
  // unlocalized, and free to carry internals. Rendering it is how "duplicate key value
  // violates unique constraint notes_pkey" reaches a customer's screen. `code` is the stable
  // machine-readable identity a translation key is explicitly allowed to depend on.
  // SOURCE: packages/platform/errors/src/index.ts (message is developer-facing; copy is
  // chosen from kind + code on the client)
  'error.conflict': 'Someone else changed this first. Reload and try again.',
  'error.forbidden': 'You do not have access to do that.',
  'error.notFound': 'That is not here.',
  // No "try again" here, unlike rateLimited below, and the difference is the whole reason
  // the two kinds are separate: waiting does not free a quota. The only actions that do are
  // deleting rows or raising the ceiling, so the copy points at those instead of inviting a
  // retry that cannot succeed.
  // SOURCE: packages/platform/errors/src/index.ts (quotaExceeded carries no retry hint)
  'error.quotaExceeded':
    'This organization has reached its limit. Remove some items, or contact an admin to raise it.',
  // "wait a moment" rather than a number: the kernel carries `retryAfterSeconds` when the
  // server sent one, and inventing a duration here would contradict it.
  // SOURCE: https://www.rfc-editor.org/rfc/rfc9110#field.retry-after
  'error.rateLimited': 'Too many attempts. Wait a moment and try again.',
  'error.rlsDenied': 'You do not have access to do that.',
  'error.unauthorized': 'Please sign in and try again.',
  'error.unavailable': 'The service is temporarily unavailable. Try again shortly.',
  'error.unknown': 'Something went wrong. Try again.',
  'error.validation': 'Check the fields and try again.',

  // ---- the error envelope, by CODE (overrides) --------------------------------
  // Keyed by `code` because that is the fine identity; `kind` alone would collapse "you are
  // not in an organization" into the same sentence as every other refusal, and the two need
  // different next actions from the reader.
  'error.code.org_context_required': 'Choose an organization to continue.',
} as const satisfies Record<string, Message>

export type Catalog = typeof en
export type MessageKey = keyof Catalog
