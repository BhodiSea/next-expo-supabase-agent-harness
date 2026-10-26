// The app's I18nPlatform adapter — the ONLY i18n module that touches
// react-native or expo native code (kv persistence, device locales, layout
// direction). src/i18n/index.ts stays pure so the vitest suite can drive the
// real store; this file is what app/_layout.tsx installs at boot.
import { getLocales } from 'expo-localization'
import { I18nManager } from 'react-native'
import { kvGet, kvSet } from '../lib/kv'
import { type Direction, initLocale, installI18nPlatform, type Locale } from './index'

const STORAGE_KEY = 'locale'

function preferredTags(): readonly string[] {
  try {
    return getLocales().map((entry) => entry.languageTag)
  } catch {
    // A mocked or absent native layer (jest) negotiates from nothing -> 'en'.
    return []
  }
}

function applyDirection(_locale: Locale, dir: Direction): void {
  const wantRTL = dir === 'rtl'
  if (I18nManager.isRTL === wantRTL) return
  // forceRTL flips the flag FOR THE NEXT APP START — react-native's layout
  // system snapshots isRTL at startup, so a live direction change requires a
  // reload (expo-updates reloadAsync / dev-menu reload). The seam applies the
  // flag and leaves the reload as a deliberate, user-visible act in whatever
  // screen offers the locale switch. The device e2e lane never hits this
  // branch: the Maestro flows PRE-SEED the locale before launch, so the app
  // boots already-mirrored.
  I18nManager.forceRTL(wantRTL)
}

/**
 * Install the platform adapter and resolve the boot locale. Called from
 * app/_layout.tsx at module scope: allowRTL must run before the first layout
 * pass, and the locale must be resolved before the first t().
 */
export function initI18n(): void {
  // Opt the app into mirrored layout support up front; without this, forceRTL
  // is a no-op and an RTL locale ships an LTR app.
  I18nManager.allowRTL(true)
  installI18nPlatform({
    readStored: () => kvGet(STORAGE_KEY),
    persist: (locale) => {
      kvSet(STORAGE_KEY, locale)
    },
    preferredTags,
    applyDirection,
  })
  initLocale()
}
