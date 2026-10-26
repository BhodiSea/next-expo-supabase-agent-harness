// Hermes Intl polyfills — imported FIRST in app/_layout.tsx, before anything can
// construct a formatter. UNCONDITIONAL (the /polyfill-force entries), never
// feature-detected: Hermes V1 ships Collator/NumberFormat/DateTimeFormat but NOT
// PluralRules, RelativeTimeFormat, or Locale (design record: EXPO-FACTS), and
// forcing the same @formatjs implementation everywhere — device iOS, device
// Android, and Node under vitest — means ONE CLDR dataset produces the strings
// the unit suite asserts on, so the vitest i18n suite stays authoritative for
// device behavior instead of testing a different engine.
//
// ORDER IS A DEPENDENCY CHAIN: getCanonicalLocales -> Locale -> PluralRules ->
// RelativeTimeFormat, then the locale data for every catalog BASE language
// (en + ar — the pseudo-locales format through their base; see baseLocale in
// src/i18n/index.ts). Adding a real locale means adding its two locale-data
// imports here in the same diff as its catalog.
//
// NOTE: Intl.NumberFormat.formatToParts is Android-only under Hermes; src/i18n
// deliberately uses plain .format() everywhere. If a future feature needs parts
// output, add @formatjs/intl-numberformat (+ locale data) here rather than
// calling the native gap.
// The explicit .js extensions are load-bearing: the @formatjs exports maps
// declare './polyfill-force.js' (not './polyfill-force'), so the extensionless
// specifier does not resolve under exports-respecting resolvers.
import '@formatjs/intl-getcanonicallocales/polyfill-force.js'
import '@formatjs/intl-locale/polyfill-force.js'
import '@formatjs/intl-pluralrules/polyfill-force.js'
import '@formatjs/intl-pluralrules/locale-data/en.js'
import '@formatjs/intl-pluralrules/locale-data/ar.js'
import '@formatjs/intl-relativetimeformat/polyfill-force.js'
import '@formatjs/intl-relativetimeformat/locale-data/en.js'
import '@formatjs/intl-relativetimeformat/locale-data/ar.js'
