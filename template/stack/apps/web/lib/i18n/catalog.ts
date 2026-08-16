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
  'route.signUp': 'Create account',
  'route.mfa': 'Two-factor check',
  'route.orgs': 'Organizations',
  'route.notes': 'Notes',
  'route.security': 'Security',
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
  // DSR erase, web half (0.11.0). Deliberately the same five-key shape the mobile catalog
  // carries, so the two surfaces say the same thing about the same irreversible act.
  'account.delete': 'Delete account',
  'account.delete.confirmBody': 'This permanently deletes your account and content.',
  'account.delete.confirm': 'Delete permanently',
  'account.delete.cancel': 'Cancel',
  'account.delete.failed': 'Your account was not deleted. You are still signed in.',
  'auth.email': 'Email',
  'auth.password': 'Password',
  'auth.signIn.lede':
    'Your session is verified server-side on every request, and every row you can reach is decided by row-level security in Postgres — never by this browser.',
  // The ONE sentence a failed sign-in may show — deliberately not distinguishing
  // "no such account" from "wrong password" (an enumeration oracle otherwise).
  'auth.signIn.failed': 'That email and password did not match an account.',
  'auth.signUp': 'Create account',
  'auth.signUp.lede':
    'An account is an email and a password. After it exists you can add an authenticator app — optional now, and available any time from Security.',
  // Same non-enumerating discipline as sign-in: "already registered" tells an
  // attacker which addresses have accounts, so the failure sentence never does.
  'auth.signUp.failed': 'An account could not be created with that email and password.',
  // Deployed projects run email confirmations (local dev does not — see
  // supabase/config.toml), so sign-up may legitimately end without a session.
  'auth.signUp.confirmSent': 'Check your email to confirm the account, then sign in.',
  'auth.signUp.haveAccount': 'Already have an account? Sign in',
  'auth.signIn.needAccount': 'New here? Create an account',

  // ---- MFA ceremonies ----------------------------------------------------------
  // Enrolment is an OFFERED step, never mandated — GoTrue's MFA configuration
  // carries no `required` field, so a "mandatory at sign-up" surface cannot be
  // built on this platform; the copy says "optional" because it truly is.
  'mfa.enrol.title': 'Set up an authenticator app',
  'mfa.enrol.lede':
    'Scan the QR code with an authenticator app, or enter the setup key by hand, then confirm with the six-digit code the app shows.',
  'mfa.enrol.qrAlt': 'QR code for your authenticator app',
  'mfa.enrol.secret': 'Setup key',
  'mfa.enrol.verify': 'Verify code',
  'mfa.enrol.skip': 'Skip for now',
  'mfa.enrol.cancel': 'Cancel',
  'mfa.code': 'Six-digit code',
  'mfa.code.invalid': 'Enter the six-digit code from your authenticator app.',
  // Codes rotate; the most common "wrong code" is a stale one, so the copy
  // points at the fix instead of restating the failure.
  'mfa.code.failed':
    'That code did not verify. Codes rotate every thirty seconds — try the current one.',
  'mfa.challenge.lede':
    'Enter the six-digit code from your authenticator app to finish signing in.',
  'mfa.challenge.verify': 'Verify',
  'mfa.challenge.unavailable': 'The two-factor check could not start. Sign in again to retry.',

  // ---- security (enrolled factors) ---------------------------------------------
  'security.lede':
    'Second factors on this account. While one is enrolled, a password alone can no longer reach your data — the database refuses it on every surface.',
  'security.empty.title': 'No authenticator enrolled',
  'security.empty.description': 'Add an authenticator app to require a six-digit code at sign-in.',
  'security.enrol': 'Add authenticator',
  'security.enrol.failed': 'The authenticator step could not start. Try again.',
  // The aria-label on the loading region — skeletons are aria-hidden by
  // construction, so this is the one thing a screen reader hears while it loads.
  'security.loading': 'Loading your authenticators',
  'security.factor.unnamed': 'Authenticator',
  'security.unenroll': 'Remove',
  'security.unenroll.failed': 'The authenticator was not removed.',
  'security.error.title': 'Could not load your authenticators.',
  'security.retry': 'Try again',

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
