import { useSyncExternalStore } from 'react'
import { type Catalog, en, type Message, type MessageKey } from './catalog'
import { pseudoCatalog } from './pseudo'

// The locale seam. ONE place decides what language the UI speaks, how its numbers and dates
// are written, and which way it reads. Everything else calls `t()`.
//
// Deliberately a MODULE-LEVEL STORE, not a React context — the same shape as theme.ts, and
// for a load-bearing reason: `t()` has to work outside a component tree (route titles in
// src/routes.ts consumers, class components like ErrorBoundary, plain data modules). A
// context would have forced a second, untranslated code path for exactly those surfaces.
//
// NO LIBRARY. i18next/FormatJS-runtime bring a plugin system and an ICU parser for a catalog
// that fits on one screen. What is actually needed is `{name}` interpolation and CLDR plural
// selection — and the platform (plus src/i18n/polyfills.ts for the Hermes gaps) already
// ships the hard half. This file is the other half, and it is small enough to read.
// SOURCE: ECMA-402 Intl — PluralRules/NumberFormat/DateTimeFormat/RelativeTimeFormat are the
// platform's CLDR implementation https://tc39.es/ecma402/ [corpus: harness/doctrine]
//
// PLATFORM SEAM. Persistence, device-locale negotiation input, and layout-direction
// application are injected through installI18nPlatform (src/i18n/platform.ts is the app's
// adapter over kv + expo-localization + I18nManager). The default is a no-op platform, which
// is what keeps THIS module's import closure free of react-native — the pure vitest suite
// runs the real store through the same door the app boots through.

/**
 * Locales this build can speak. `en` is the source of truth; the two pseudo-locales are
 * DERIVED from it (see pseudo.ts) and exist so the test lanes can prove — mechanically, on
 * every route — that no string bypasses the catalog and that the layout survives RTL.
 * Add a real locale by adding a catalog below (and its locale data in polyfills.ts).
 */
export type Locale = 'en' | 'en-XA' | 'ar-XB'

/** @public — test-facing seam API: the vitest i18n suite enumerates locales; production code resolves one. */
export const LOCALES: readonly Locale[] = ['en', 'en-XA', 'ar-XB']

const CATALOGS: Readonly<Record<Locale, Catalog>> = {
  en,
  'en-XA': pseudoCatalog(en, { accent: true, pad: 0.3, rtl: false }),
  'ar-XB': pseudoCatalog(en, { accent: false, pad: 0.3, rtl: true }),
}

/**
 * Scripts written right-to-left, by ISO-639 language subtag. `Intl.Locale#getTextInfo()` is
 * the platform answer and the @formatjs Intl.Locale polyfill (polyfills.ts) implements it,
 * but the polyfill import is the APP's job — this module must stay meaningful even when a
 * consumer reorders boot, so the subtag list stays as the floor and getTextInfo is used
 * when present.
 * SOURCE: Intl Locale Info proposal (getTextInfo) — hence the fallback
 * https://tc39.es/proposal-intl-locale-info/ [corpus: harness/doctrine]
 */
const RTL_LANGUAGES = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv'])

export type Direction = 'ltr' | 'rtl'

/** @public — test-facing seam API: the direction suite pins the rtl/ltr answers directly. */
export function directionOf(locale: Locale): Direction {
  try {
    const info = new Intl.Locale(locale)
    // Ask getTextInfo about the LANGUAGE subtag, not the full tag: script
    // direction is a property of the language, and the pseudo-locale carries a
    // private-use region ('ar-XB') the direction data does not key on — the
    // @formatjs implementation answers 'ltr' for the full tag but 'rtl' for
    // the bare 'ar' (measured; the vitest direction suite pins this).
    // Typed with getTextInfo OPTIONAL — it is a polyfill-provided extension on this
    // host (polyfills.ts), so the platform lib type must not promise it exists and
    // the optional chain below stays honest.
    const base = new Intl.Locale(info.language) as {
      getTextInfo?: () => { direction: string }
    }
    const direction = base.getTextInfo?.().direction
    if (direction === 'rtl' || direction === 'ltr') return direction
    return RTL_LANGUAGES.has(info.language) ? 'rtl' : 'ltr'
  } catch {
    return 'ltr'
  }
}

/**
 * What the store needs from the host platform. src/i18n/platform.ts installs the real
 * adapter at boot; tests install in-memory fakes. The no-op default keeps this module pure.
 */
export interface I18nPlatform {
  /** The persisted locale choice, or null when none was ever stored. */
  readonly readStored: () => string | null
  readonly persist: (locale: Locale) => void
  /** BCP-47 tags in user preference order (device settings). */
  readonly preferredTags: () => readonly string[]
  /** Apply the resolved direction to the host layout system. */
  readonly applyDirection: (locale: Locale, dir: Direction) => void
}

const NOOP_PLATFORM: I18nPlatform = {
  readStored: () => null,
  persist: () => undefined,
  preferredTags: () => [],
  applyDirection: () => undefined,
}

let platform: I18nPlatform = NOOP_PLATFORM

export function installI18nPlatform(next: I18nPlatform): void {
  platform = next
}

function isLocale(value: string | null): value is Locale {
  return value !== null && (LOCALES as readonly string[]).includes(value)
}

function readLocale(): Locale {
  const stored = platform.readStored()
  if (isLocale(stored)) return stored
  return negotiate()
}

/**
 * Pick the best supported locale for this user. Exact match wins, then the language subtag
 * (a `de-CH` user gets `de` once it exists), then `en`. The pseudo-locales are never
 * negotiated into — they are opt-in, or the test lane would be the only thing anyone saw.
 */
function negotiate(): Locale {
  const preferred = platform.preferredTags()
  const real = LOCALES.filter((locale) => locale === 'en')
  for (const want of preferred) {
    const exact = real.find((locale) => locale.toLowerCase() === want.toLowerCase())
    if (exact !== undefined) return exact
    const base = want.split('-')[0]?.toLowerCase()
    const byLanguage = real.find((locale) => locale.split('-')[0]?.toLowerCase() === base)
    if (byLanguage !== undefined) return byLanguage
  }
  return 'en'
}

let current: Locale = 'en'
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/**
 * Hand the resolved direction to the platform. On this host the direction is applied
 * through I18nManager (see platform.ts) and a DIRECTION CHANGE REQUIRES AN APP RELOAD —
 * the layout system snapshots isRTL at startup. The seam stays synchronous and honest
 * about that: it applies the flag; the reload policy lives in the adapter.
 */
function applyLocale(locale: Locale): void {
  platform.applyDirection(locale, directionOf(locale))
}

/**
 * Resolve + apply the persisted (or negotiated) locale. Called from app/_layout.tsx at
 * module scope, BEFORE the first render — the first frame already carries the right
 * language and direction (the same no-flash discipline initTheme() follows).
 */
export function initLocale(): void {
  current = readLocale()
  applyLocale(current)
  emit()
}

function setLocale(next: Locale): void {
  current = next
  platform.persist(next)
  applyLocale(next)
  emit()
}

// ---- formatting ------------------------------------------------------------------
// Intl formatter construction is the expensive part (it parses CLDR data); the formatters
// themselves are cheap and immutable. Cache per (locale, kind) — a grid of 10 000 cells
// would otherwise build 10 000 NumberFormats.
const numberFormats = new Map<string, Intl.NumberFormat>()
const dateFormats = new Map<string, Intl.DateTimeFormat>()
const pluralRules = new Map<string, Intl.PluralRules>()
const relativeFormats = new Map<string, Intl.RelativeTimeFormat>()

function numberFormat(locale: Locale, options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options ?? {})}`
  let formatter = numberFormats.get(key)
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(baseLocale(locale), options)
    numberFormats.set(key, formatter)
  }
  return formatter
}

/**
 * The pseudo-locales are not real BCP-47 languages Intl can resolve for FORMATTING (there is
 * no CLDR data for `en-XA`), so numbers and dates fall back to their base language. Text is
 * pseudo-localized; numbers stay legible — which is what you want when reading a pseudo build.
 */
function baseLocale(locale: Locale): string {
  if (locale === 'en-XA') return 'en'
  if (locale === 'ar-XB') return 'ar'
  return locale
}

/** Format a number for the ACTIVE locale — grouping separator, decimal mark, digits and all.
 * Module-private: components never format a number directly. They interpolate it through a
 * message placeholder, and `translate()` runs it through here — so a number can only reach the
 * screen inside a sentence, in the locale of that sentence. Plain .format() only: Hermes
 * lacks formatToParts on iOS (see polyfills.ts). */
function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return numberFormat(current, options).format(value)
}

/**
 * A matrix cell. Integers render bare; fractions get exactly two decimals — but the decimal
 * mark is the LOCALE's ("0,75" in de, "٠٫٧٥" in ar), which `.toFixed(2)` could never be.
 */
export function formatCellValue(value: number): string {
  return Number.isInteger(value)
    ? formatNumber(value, { maximumFractionDigits: 0 })
    : formatNumber(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** @public — seam API: reached from tests today; the formatting door features must use, never Intl. */
export function formatDate(iso: string, options?: Intl.DateTimeFormatOptions): string {
  const key = `${current}|${JSON.stringify(options ?? {})}`
  let formatter = dateFormats.get(key)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(baseLocale(current), options ?? { dateStyle: 'medium' })
    dateFormats.set(key, formatter)
  }
  const at = Date.parse(iso)
  return Number.isNaN(at) ? '' : formatter.format(at)
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "3 minutes ago" / "last week" — in the active locale, with its own grammar. */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  let formatter = relativeFormats.get(current)
  if (formatter === undefined) {
    formatter = new Intl.RelativeTimeFormat(baseLocale(current), { numeric: 'auto' })
    relativeFormats.set(current, formatter)
  }
  const delta = at - now
  const magnitude = Math.abs(delta)
  if (magnitude < HOUR) return formatter.format(Math.round(delta / MINUTE), 'minute')
  if (magnitude < DAY) return formatter.format(Math.round(delta / HOUR), 'hour')
  return formatter.format(Math.round(delta / DAY), 'day')
}

function selectPlural(locale: Locale, count: number): Intl.LDMLPluralRule {
  let rules = pluralRules.get(locale)
  if (rules === undefined) {
    rules = new Intl.PluralRules(baseLocale(locale))
    pluralRules.set(locale, rules)
  }
  return rules.select(count)
}

// ---- translation -----------------------------------------------------------------

export type TranslationParams = Readonly<Record<string, string | number>>

/**
 * Resolve a message and interpolate it.
 *
 * A `count` param selects the plural branch through Intl.PluralRules, so the RULE is the
 * locale's — English's two-form split is not baked into the code, and a language with a dual
 * or a paucal form gets it by adding a key.
 *
 * There is deliberately NO runtime fallback for a missing key, because there is no such thing:
 * a locale's catalog is a full `Record<MessageKey, Message>`, so TypeScript — not a defensive
 * `?? en[key]` — is what guarantees completeness. Adding a message and forgetting a locale is a
 * COMPILE error. A silent English fallback would have turned that compile error into a shipped
 * bug that only a native speaker of the other language would ever notice.
 * @public — test-facing seam API: the vitest suite drives every locale explicitly; components use t()/useI18n.
 */
export function translate(locale: Locale, key: MessageKey, params?: TranslationParams): string {
  const template = resolve(locale, CATALOGS[locale][key], params)
  if (params === undefined) return template
  return template.replace(/\{([a-zA-Z][\w.]*)\}/g, (whole, name: string) => {
    const value = params[name]
    if (value === undefined) return whole
    return typeof value === 'number' ? formatNumber(value) : value
  })
}

function resolve(locale: Locale, message: Message, params?: TranslationParams): string {
  if (typeof message === 'string') return message
  const count = params?.['count']
  if (typeof count !== 'number') return message.other
  const category = selectPlural(locale, count)
  return message[category] ?? message.other
}

/** Translate with the ACTIVE locale — usable outside React (routes, ErrorBoundary). */
export function t(key: MessageKey, params?: TranslationParams): string {
  return translate(current, key, params)
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}

function getSnapshot(): Locale {
  return current
}

export interface I18n {
  readonly locale: Locale
  readonly dir: Direction
  readonly t: (key: MessageKey, params?: TranslationParams) => string
  readonly setLocale: (next: Locale) => void
}

/** Subscribe a component to the active locale: a locale switch re-renders the tree. */
export function useI18n(): I18n {
  const locale = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return {
    locale,
    dir: directionOf(locale),
    t: (key, params) => translate(locale, key, params),
    setLocale,
  }
}

export type { MessageKey } from './catalog'
