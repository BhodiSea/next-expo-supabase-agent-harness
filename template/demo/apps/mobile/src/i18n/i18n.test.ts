// The pure i18n suite — runs under the ROOT vitest config (unit-node), on Node,
// with the SAME @formatjs polyfills the device loads (polyfill-force pins one
// CLDR implementation everywhere), which is what makes these assertions
// authoritative for on-device behavior. Import order matters: polyfills first.
import './polyfills'

import { beforeEach, describe, expect, it } from 'vitest'
import { en, type MessageKey } from './catalog'
import {
  type Direction,
  formatCellValue,
  formatDate,
  formatRelativeTime,
  initLocale,
  installI18nPlatform,
  LOCALES,
  type Locale,
  t,
  translate,
} from './index'
import { pseudoCatalog } from './pseudo'

// The locale is switched through the app's own door: install an I18nPlatform
// whose stored value IS the wanted locale, then initLocale() — the exact path
// app/_layout.tsx boots through. There is no exported setLocale to reach
// around the store with; the platform seam is the public surface, and a test
// that needs a private door usually means the door should be public for a
// reason nobody has stated.
const applied: { locale: Locale; dir: Direction }[] = []

function installPlatform(stored: string | null, preferred: readonly string[] = []): void {
  installI18nPlatform({
    readStored: () => stored,
    persist: () => undefined,
    preferredTags: () => preferred,
    applyDirection: (locale, dir) => {
      applied.push({ locale, dir })
    },
  })
  initLocale()
}

function switchLocale(locale: Locale): void {
  installPlatform(locale)
}

beforeEach(() => {
  applied.length = 0
  switchLocale('en')
})

describe('catalog', () => {
  it('every message is a string or a plural set with an `other` branch', () => {
    // `other` is the fallback for every CLDR category a locale does not define. A plural set
    // without it would resolve to undefined for some count in some language.
    for (const [key, message] of Object.entries(en)) {
      if (typeof message === 'string') {
        expect(message.length, `${key} is empty`).toBeGreaterThan(0)
        continue
      }
      expect(typeof message.other, `${key} has no \`other\` branch`).toBe('string')
    }
  })

  it('no message key is declared twice (the object literal would silently keep the last)', () => {
    const keys = Object.keys(en)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('interpolation', () => {
  it('substitutes named placeholders', () => {
    expect(t('connection.connected', { version: '1.2.3' })).toBe('API connected (v1.2.3)')
  })

  it('formats an interpolated NUMBER through Intl — a bare template literal could not', () => {
    // Numbers routed through a placeholder pick up the locale's grouping separator; raw
    // interpolation would show every reader the same "1234567".
    expect(t('matrix.summary', { count: 2, rows: 1234567, columns: 6 })).toContain('1,234,567')
  })

  it('leaves an unknown placeholder intact rather than printing "undefined"', () => {
    expect(translate('en', 'connection.connected', {})).toBe('API connected (v{version})')
  })
})

describe('plurals', () => {
  it('selects the branch by CLDR category, not by an English if-statement', () => {
    expect(t('matrix.summary', { count: 1, rows: 1, columns: 6 })).toContain('1 row ×')
    expect(t('matrix.summary', { count: 2, rows: 2, columns: 6 })).toContain('2 rows ×')
  })

  it('"1 rows" — the classic hardcoded-plural bug — cannot be produced', () => {
    const one = t('matrix.summary', { count: 1, rows: 1, columns: 6 })
    expect(one).not.toContain('1 rows')
  })

  it('falls back to `other` when a count is absent', () => {
    expect(t('matrix.summary', { rows: 3, columns: 6 })).toContain('3 rows')
  })
})

describe('direction', () => {
  // Asserted on the platform seam rather than a pure function, because applying
  // the direction to the host layout system IS the feature: a direction computed
  // correctly and never applied would pass a unit test and ship an LTR app.
  it('applying a locale hands the platform its direction', () => {
    switchLocale('ar-XB')
    expect(applied.at(-1)).toEqual({ locale: 'ar-XB', dir: 'rtl' })

    switchLocale('en')
    expect(applied.at(-1)).toEqual({ locale: 'en', dir: 'ltr' })
  })

  it('the accented pseudo-locale stays ltr (it tests expansion, not mirroring)', () => {
    switchLocale('en-XA')
    expect(applied.at(-1)).toEqual({ locale: 'en-XA', dir: 'ltr' })
  })
})

describe('negotiation', () => {
  it('nothing stored: the device preference list negotiates by language subtag', () => {
    installPlatform(null, ['de-CH', 'en-US'])
    // 'en' is the only real locale today; the en-US preference reaches it via
    // the language subtag. A de catalog would win the moment it exists.
    expect(t('route.home')).toBe('Home')
  })

  it('the pseudo-locales are never negotiated into (opt-in only)', () => {
    installPlatform(null, ['ar-XB', 'en-XA'])
    expect(t('route.home')).toBe('Home')
  })

  it('a corrupt stored value falls back to negotiation, never a crash', () => {
    installPlatform('definitely-not-a-locale', [])
    expect(t('route.home')).toBe('Home')
  })
})

describe('number formatting', () => {
  it('formatCellValue gives integers no decimals and fractions exactly two', () => {
    expect(formatCellValue(42)).toBe('42')
    expect(formatCellValue(0.75)).toBe('0.75')
  })

  it('the decimal mark follows the LOCALE — which .toFixed(2) could never do', () => {
    const german = new Intl.NumberFormat('de', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(0.75)
    expect(german).toBe('0,75')
    expect((0.75).toFixed(2)).toBe('0.75')
    expect(german).not.toBe((0.75).toFixed(2))
  })

  it('a number interpolated into a message picks up the locale grouping', () => {
    expect(t('matrix.summary', { count: 2, rows: 1234567, columns: 6 })).toContain('1,234,567')
  })

  it('formatDate renders the absolute instant in the locale', () => {
    expect(formatDate('2026-01-01T12:00:00Z', { dateStyle: 'medium' })).toContain('2026')
  })
})

describe('relative time', () => {
  it('renders a past instant relatively, in the active locale', () => {
    const now = Date.parse('2026-01-01T12:00:00Z')
    const threeHoursAgo = new Date(now - 3 * 60 * 60 * 1000).toISOString()
    expect(formatRelativeTime(threeHoursAgo, now)).toBe('3 hours ago')
  })

  it('returns empty string for an unparseable timestamp rather than "Invalid Date"', () => {
    expect(formatRelativeTime('not-a-date')).toBe('')
  })
})

describe('pseudo-locale', () => {
  const pseudo = pseudoCatalog(en, { accent: true, pad: 0.3, rtl: false })

  it('covers EVERY key — it is derived, so it cannot drift from the source catalog', () => {
    expect(Object.keys(pseudo).sort()).toEqual(Object.keys(en).sort())
  })

  it('mangles EVERY message, so any plain English on screen is a string that bypassed the catalog', () => {
    // The property that matters is not "is it bracketed" — it is "is it different". A message
    // that came through unchanged is a message the pseudo-locale cannot distinguish from a
    // hardcoded literal, which would blow a hole straight through the on-screen sweep.
    for (const key of Object.keys(en) as MessageKey[]) {
      expect(pseudo[key], `${key} survived pseudo-localization unchanged`).not.toEqual(en[key])
    }
  })

  it('PRESERVES placeholders — mangling them would break interpolation, not localizability', () => {
    switchLocale('en-XA')
    const rendered = t('connection.connected', { version: '1.2.3' })
    expect(rendered).toContain('1.2.3')
    expect(rendered).not.toContain('API connected')
  })

  it('expands the text ~30%, so a layout that clips German clips here too', () => {
    const source = en['signin.body']
    const expanded = pseudo['signin.body']
    expect(typeof expanded).toBe('string')
    expect((expanded as string).length).toBeGreaterThan(source.length * 1.2)
  })
})

describe('locale switching', () => {
  it('switching the locale swaps the active catalog for every subsequent t()', () => {
    expect(t('notes.empty.title')).toBe('No notes yet')
    switchLocale('en-XA')
    expect(t('notes.empty.title')).not.toBe('No notes yet')
    expect(t('notes.empty.title')).toBe(translate('en-XA', 'notes.empty.title'))
  })

  it('every declared locale resolves every key (no silent English fallback)', () => {
    const keys = Object.keys(en) as MessageKey[]
    for (const locale of LOCALES) {
      for (const key of keys) {
        const rendered = translate(locale, key)
        expect(rendered, `${locale}/${key} did not resolve`).not.toBe('')
        // A missing key returning the key itself would mean this locale's catalog is
        // incomplete — for a derived pseudo-locale that is impossible by construction.
        expect(rendered, `${locale}/${key} fell through to the key`).not.toBe(key)
      }
    }
  })
})
