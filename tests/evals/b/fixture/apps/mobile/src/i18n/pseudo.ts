import type { Catalog, Message, MessageKey } from './catalog'

// PSEUDO-LOCALES — the machinery that makes "is this app really localizable?" a question a
// machine can answer, without anyone writing a single translation.
//
// A hand-written second locale proves nothing: it is a snapshot, it rots the moment someone
// adds a string, and a missing key silently falls back to English — the exact failure it was
// meant to catch. A pseudo-locale is DERIVED from the catalog, so it is complete by
// construction and can never drift. Every message comes out visibly mangled, which turns the
// property into something you can assert:
//
//     under `en-XA`, ANY plain-English text still on screen is, necessarily, a string that
//     never went through the catalog.
//
// The pseudo-locale sweep (RNTL fast lane + the on-device Maestro lane) asserts exactly
// that, per route: no `en` source string may appear verbatim in the rendered tree. That is
// the behavioural half of the i18n gate — it catches the strings the static scan cannot see
// (built at runtime, assembled from fragments, returned by a helper), and it is why this
// file exists rather than a fixture translation.
//
// Two pseudo-locales, matching the industry convention (Chrome/Android ship the same pair):
//   en-XA — accented + bracketed + padded. Padding is not decoration: European translations
//           run ~30% longer than English, so a layout that only ever saw English silently
//           ships clipped labels. The pad makes that a visible, testable overflow.
//   ar-XB — right-to-left. This drives the RTL direction through the real layout system
//           (I18nManager) so the mirrored-layout assertions run against it.
//
// Placeholders are preserved EXACTLY: `{name}` must survive, or interpolation breaks and the
// pseudo-locale would fail for a reason that has nothing to do with localizability.
// SOURCE: pseudolocalization as a completeness check — the Unicode "expansion + accents +
// bracketing" convention https://cldr.unicode.org/index/cldr-spec/pseudolocalization
// [corpus: harness/doctrine]

/** ASCII → look-alike accented, so text stays readable while being unmistakably transformed. */
const ACCENTS: Readonly<Record<string, string>> = {
  a: 'á',
  b: 'ƀ',
  c: 'ç',
  d: 'ð',
  e: 'é',
  f: 'ƒ',
  g: 'ĝ',
  h: 'ĥ',
  i: 'í',
  j: 'ĵ',
  k: 'ĸ',
  l: 'ļ',
  m: 'ɱ',
  n: 'ñ',
  o: 'ö',
  p: 'þ',
  q: 'ǫ',
  r: 'ŕ',
  s: 'ş',
  t: 'ţ',
  u: 'ü',
  v: 'ṽ',
  w: 'ŵ',
  x: 'ẋ',
  y: 'ý',
  z: 'ž',
  A: 'Á',
  B: 'Ɓ',
  C: 'Ç',
  D: 'Ð',
  E: 'É',
  F: 'Ƒ',
  G: 'Ĝ',
  H: 'Ĥ',
  I: 'Í',
  J: 'Ĵ',
  K: 'Ķ',
  L: 'Ļ',
  M: 'Ɱ',
  N: 'Ñ',
  O: 'Ö',
  P: 'Þ',
  Q: 'Ǫ',
  R: 'Ŕ',
  S: 'Ş',
  T: 'Ţ',
  U: 'Ü',
  V: 'Ṽ',
  W: 'Ŵ',
  X: 'Ẋ',
  Y: 'Ý',
  Z: 'Ž',
}

// The bracket pair every pseudo message carries. NOT exported: a test that wants to know
// "is this string pseudo-localized?" should ask the catalog (`pseudoCatalog(en, …)[key]`),
// not re-implement the transform's private punctuation. Exporting the marker would let an
// assertion drift into checking for a bracket rather than checking for the actual message.
const PSEUDO_OPEN = '⟦'
const PSEUDO_CLOSE = '⟧'

/** Right-to-left embedding marks: force the runs RTL even inside an LTR container. */
const RLE = '‫'
const PDF = '‬'

/** Split on `{param}` so placeholders pass through untouched. */
const PLACEHOLDER = /(\{[a-zA-Z][\w.]*\})/g

function transform(text: string, accent: boolean, pad: number, rtl: boolean): string {
  const body = text
    .split(PLACEHOLDER)
    .map((part) => {
      if (part.startsWith('{') && part.endsWith('}')) return part // a placeholder — never touch
      // Replace per ASCII letter rather than spreading the string: spreading iterates code
      // POINTS, which decomposes anything outside the BMP — and this transform runs over copy
      // that may already contain '…' or '—'.
      return accent ? part.replace(/[A-Za-z]/g, (ch) => ACCENTS[ch] ?? ch) : part
    })
    .join('')
  // Expansion: ~30% more characters, which is what a European translation costs. A layout
  // that clips here would have clipped in German.
  const padding = '·'.repeat(Math.max(0, Math.round(body.length * pad)))
  const inner = padding === '' ? body : `${body}${padding}`
  const wrapped = `${PSEUDO_OPEN}${inner}${PSEUDO_CLOSE}`
  return rtl ? `${RLE}${wrapped}${PDF}` : wrapped
}

function pseudoMessage(message: Message, accent: boolean, pad: number, rtl: boolean): Message {
  if (typeof message === 'string') return transform(message, accent, pad, rtl)
  const out: Record<string, string> = {}
  for (const [category, text] of Object.entries(message)) {
    if (typeof text === 'string') out[category] = transform(text, accent, pad, rtl)
  }
  return out as unknown as Message
}

/** Derive a complete pseudo catalog from `en`. Complete BY CONSTRUCTION — it cannot drift. */
export function pseudoCatalog(
  base: Catalog,
  { accent, pad, rtl }: { accent: boolean; pad: number; rtl: boolean },
): Catalog {
  const out: Partial<Record<MessageKey, Message>> = {}
  for (const key of Object.keys(base) as MessageKey[]) {
    out[key] = pseudoMessage(base[key], accent, pad, rtl)
  }
  return out as Catalog
}
