import { type Palette, palettes, type ThemeName } from '@app/design-tokens/native'
import { useSyncExternalStore } from 'react'
import type { ImageStyle, TextStyle, ViewStyle } from 'react-native'
import { Appearance } from 'react-native'
import { kvGet, kvSet } from '../lib/kv'

// Light/dark theming — the desktop original's store logic (module-level store +
// useSyncExternalStore), re-seamed for this host: persistence goes through
// src/lib/kv.ts instead of web storage, and the OS signal is react-native's
// Appearance (the same event source useColorScheme subscribes to) instead of a
// media query. `dark` is the design base and the native launch frame
// (app.config.ts splash lockstep); `light` is a full token override. The user's
// explicit choice is persisted; `system` defers to the OS and tracks it live.
// SOURCE: the OS color scheme is a read-only signal — persisting an explicit
// override layered over it is the app's own responsibility
// [corpus: web/prefers-color-scheme]
/** @public — seam API: the persisted preference vocabulary (test-asserted; consumers narrow with it). */
export type ThemePreference = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'theme'

function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system'
}

function readPreference(): ThemePreference {
  // kvGet is corrupt-safe; an unknown or missing value is the system default.
  const stored = kvGet(STORAGE_KEY)
  return isThemePreference(stored) ? stored : 'system'
}

// Query the LIGHT preference (not dark): a mocked Appearance (jest) reports
// null, so the resolved default stays `dark` — the design base — exactly like
// the desktop original's stubbed media query.
function systemPrefersLight(): boolean {
  try {
    return Appearance.getColorScheme() === 'light'
  } catch {
    return false
  }
}

/** The concrete theme actually painted, collapsing `system` to light/dark. */
function resolveTheme(preference: ThemePreference): ThemeName {
  if (preference === 'system') return systemPrefersLight() ? 'light' : 'dark'
  return preference
}

let preference: ThemePreference = readPreference()
let resolved: ThemeName = resolveTheme(preference)
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

// While the preference is `system`, an OS theme flip must repaint live.
function onSystemChange(): void {
  if (preference !== 'system') return
  const next = resolveTheme(preference)
  if (next === resolved) return
  resolved = next
  emit()
}

let systemSubscription: { remove: () => void } | null = null

/**
 * Resolve the persisted preference and start tracking the OS signal. Called
 * from app/_layout.tsx at module scope, BEFORE the first render, so the first
 * frame already paints the right palette (no theme flash). The subscription is
 * module-lifetime BY DESIGN — the theme store outlives every screen, so there
 * is deliberately no teardown path; re-init (fast refresh) swaps it instead of
 * stacking a second listener.
 */
export function initTheme(): void {
  preference = readPreference()
  resolved = resolveTheme(preference)
  systemSubscription?.remove()
  systemSubscription = Appearance.addChangeListener(onSystemChange)
}

/** @public — seam API: a settings screen sets an explicit preference; the shipped chrome only cycles. */
export function setThemePreference(next: ThemePreference): void {
  preference = next
  kvSet(STORAGE_KEY, next)
  resolved = resolveTheme(next)
  emit()
}

// system → light → dark → system. A toggle control walks this ring.
const CYCLE: Record<ThemePreference, ThemePreference> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
}

/** @public — seam API: the pure cycle step, exported for tests and custom toggles. */
export function nextPreference(current: ThemePreference): ThemePreference {
  return CYCLE[current]
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}

// The snapshot covers BOTH facets: a preference change and a resolved-theme
// change (OS flip under `system`) must each invalidate subscribers.
function getSnapshot(): string {
  return `${preference}:${resolved}`
}

interface ThemeControls {
  readonly preference: ThemePreference
  readonly resolved: ThemeName
  /** Advance system → light → dark → system, persisting + applying the choice. */
  readonly cycle: () => void
}

export function useTheme(): ThemeControls {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return {
    preference,
    resolved,
    cycle: () => {
      setThemePreference(nextPreference(preference))
    },
  }
}

/** The active theme's token set — for the rare prop that needs a raw color
 * (placeholderTextColor, navigator tint). Styling goes through useThemedStyles. */
export function usePalette(): Palette {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return palettes[resolved]
}

type NamedStyles<T> = { readonly [K in keyof T]: ViewStyle | TextStyle | ImageStyle }
type StyleFactory = (palette: Palette) => unknown

// Style factories are cached per (factory, resolved theme): pass a MODULE-LEVEL
// factory so each theme's style object is built once for the app's lifetime,
// not once per render — the WeakMap also means a hot-reloaded factory simply
// starts a fresh cache entry.
const styleCache = new WeakMap<StyleFactory, Partial<Record<ThemeName, unknown>>>()

/**
 * Tokens-only styling helper: the factory receives the ACTIVE palette and
 * returns plain RN style objects. Subscribing here is what makes a theme
 * switch restyle every mounted component.
 */
export function useThemedStyles<T extends NamedStyles<T>>(factory: (palette: Palette) => T): T {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  let byTheme = styleCache.get(factory)
  if (byTheme === undefined) {
    byTheme = {}
    styleCache.set(factory, byTheme)
  }
  let styles = byTheme[resolved]
  if (styles === undefined) {
    styles = factory(palettes[resolved])
    byTheme[resolved] = styles
  }
  return styles as T
}

// ---------------------------------------------------------------------------
// THE ONE LOCAL TOKEN SEAM.
//
// Every visual constant this app paints with is re-exported HERE, and screens
// import it from `../theme/theme` rather than reaching for the package
// directly. The reason is the one that made the app's old hand-generated local
// token module a liability: a per-file import of a token module is
// a per-file decision about WHICH token module, and the moment a second one
// exists (a raw source barrel and a platform-resolved adapter that re-use the
// names `radius`/`typeScale` with DIFFERENT value types) half the tree paints
// from one and half from the other, typechecking perfectly the whole way.
//
// `@app/design-tokens/native` — not `@app/design-tokens` — is deliberate and is
// the whole of that hazard: the package barrel carries the OKLCH SOURCE values
// (numbers, `Oklch` objects) that generate both platforms; the `/native`
// subpath carries the same names resolved to what React Native's style system
// can actually parse (hex strings, dp numbers). Importing the barrel here would
// hand a component an OKLCH triple where it wants '#6ad8de' and paint nothing.
// SOURCE: design/W1-STACK-SPEC.md §5 (tokens are TS → both platforms; the two
// generated adapters ride their own subpaths precisely because they re-use the
// source names with platform-resolved values) · packages/design-tokens/src/index.ts
// ---------------------------------------------------------------------------
export {
  elevation,
  fontScaleCap,
  fontWeight,
  iconSize,
  minTouchTarget,
  motion,
  radius,
  space,
  typeScale,
} from '@app/design-tokens/native'
export type { Palette, ThemeName } from '@app/design-tokens/native'
