import { type Catalog, en, type Message, type MessageKey } from './catalog'

// The web locale seam. ONE module decides what language this surface speaks and how its
// numbers and dates are written; everything else calls `t()`.
//
// A PLAIN FUNCTION, NOT A HOOK, and that is the load-bearing difference from the mobile
// twin. Most copy on this surface is rendered by Server Components, `generateMetadata`, and
// Server Actions — none of which may call a hook. A context-based seam would have forced a
// second, untranslated code path for exactly the surfaces that render the most copy, which
// is how the web half came to have no seam at all in the first place. `useI18n()` exists
// below for client components and returns the same `t`, so a component that later moves
// across the server/client line does not change how it reads copy.
//
// NO LIBRARY, for the same reason as mobile: what is actually needed is `{name}`
// interpolation and CLDR plural selection, and the platform ships the hard half. next-intl
// was considered and is recorded as considered-and-rejected in the 0.6.0 notes — it wants a
// request-scoped provider and a proxy integration, and `apps/web/proxy.ts` is the one file
// this harness insists is NOT an authorization boundary. Putting locale negotiation there
// invites the next reader to put a second thing there.
// SOURCE: ECMA-402 Intl — PluralRules/NumberFormat/DateTimeFormat are the platform's CLDR
// implementation https://tc39.es/ecma402/ [corpus: harness/doctrine]

/**
 * Locales this build can speak.
 *
 * ONE at seed, and that is a deliberate floor rather than an aspiration: single-locale
 * English is a property you can only hold by checking it, and the gate checks it from the
 * first commit. Adding a locale is adding a catalog beside `en` and a member here — no code
 * change, because every consumer already goes through `t()`.
 *
 * NEGOTIATION IS THE CONSUMER'S TO ADD, stated plainly so its absence is not mistaken for a
 * bug: this seam resolves `en` unconditionally. A real deployment picks a locale from
 * `Accept-Language` or a cookie in a Server Component and threads it into `t()`. The shape
 * below takes a locale argument for exactly that reason; nothing here has to change.
 *
 * Parsed FAIL-CLOSED by tools/check-i18n.mjs — a seam whose locale list the gate cannot read
 * is a seam it cannot hold.
 */
export const LOCALES: readonly ['en'] = ['en']

export type Locale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: Locale = 'en'

const CATALOGS: Readonly<Record<Locale, Catalog>> = { en }

/** Interpolation values. Numbers are formatted through Intl, so separators are the locale's. */
export type MessageParams = Readonly<Record<string, string | number>>

/**
 * The plural category for `count` in `locale`.
 *
 * `Intl.PluralRules` and not an `if`: "1 row" / "2 rows" is the LANGUAGE's rule, not
 * English's, and a language with a dual or a paucal form gets its own branch by adding the
 * key rather than by editing a conditional somebody wrote while thinking in English.
 */
function pluralCategory(locale: Locale, count: number): string {
  return new Intl.PluralRules(locale).select(count)
}

function resolve(message: Message, locale: Locale, params: MessageParams | undefined): string {
  if (typeof message === 'string') return message
  // Bracket access, not `params?.count`: MessageParams is an index signature, and
  // `noPropertyAccessFromIndexSignature` makes dot access on one a compile error — the rule
  // exists so a typo'd param name reads as a missing key rather than as `undefined`.
  const count = params?.['count']
  if (typeof count !== 'number') {
    // A plural set rendered without a count cannot pick a branch. `other` is the honest
    // fallback and the type system cannot catch this, so it is the one place a plural
    // message degrades rather than throwing in a user's face.
    return message.other
  }
  // The cast is on the KEY, not the value: Intl.PluralRules returns `string` and the catalog's
  // plural keys are a closed set, so the index needs narrowing — but every one of those
  // properties is already `string | undefined`, which is why asserting the RESULT too is the
  // unnecessary assertion the lint rule catches.
  const category = pluralCategory(locale, count) as keyof Omit<typeof message, never>
  return message[category] ?? message.other
}

const PLACEHOLDER = /\{(\w+)\}/g

/**
 * Render a catalog key.
 *
 * @param key a key of the `en` catalog — a typo is a compile error, not a screen reading
 *   "notes.emty.title" in production.
 */
export function t(
  key: MessageKey,
  params?: MessageParams,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const message = CATALOGS[locale][key] as Message
  const text = resolve(message, locale, params)
  if (params === undefined) return text
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    const value = params[name]
    if (value === undefined) return whole
    return typeof value === 'number' ? formatNumber(value, locale) : value
  })
}

// ---- the Intl boundary ---------------------------------------------------------------
// Every locale-sensitive format lives in THIS module. The gate bans `Intl.`, `.toLocale*(`
// and `.toFixed(` everywhere else on this surface, and `.toFixed` in particular is not
// pedantry: it hardcodes `.` as the decimal mark, so a German reader gets "0.75" where they
// write "0,75" — inside a function called formatCell, which is exactly where you would look
// and not see it.

export function formatNumber(
  value: number,
  locale: Locale = DEFAULT_LOCALE,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(locale, options).format(value)
}

export function formatDate(
  value: Date | string | number,
  locale: Locale = DEFAULT_LOCALE,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
  return new Intl.DateTimeFormat(locale, options).format(new Date(value))
}

/**
 * The client-component door. Same `t`, so moving a component across the server/client line
 * never changes how it reads copy — and there is no provider to forget to mount.
 */
export function useI18n(): {
  readonly t: typeof t
  readonly locale: Locale
  readonly formatNumber: typeof formatNumber
  readonly formatDate: typeof formatDate
} {
  return { t, locale: DEFAULT_LOCALE, formatNumber, formatDate }
}
