'use client'

// 'use client': it IS a React context provider.

import type { ThemeName } from '@app/design-tokens'
import { createContext, type ReactNode, useContext, useMemo } from 'react'
import { cn } from './cn'

// The theme root. It does exactly one thing on this platform: stamp `data-theme` on a
// wrapper element, which the generated stylesheet's `[data-theme="dark"]` block reads.
//
// The web override is deliberately THIN because the default already works: the
// generated CSS resolves light/dark from `prefers-color-scheme` with no JavaScript at
// all, so a server-rendered first paint is already correct and there is no theme flash
// to patch over. This component exists for the case the media query cannot express —
// a user who chose a theme explicitly.
//
// A *resolved* theme name is required, never 'system'. Collapsing 'system' to a
// concrete value needs the OS signal plus the persisted preference, which is app state
// (and on this platform, state that must not differ between the server render and the
// hydrated one). A design system that guessed would guess differently on each side and
// produce exactly the hydration mismatch it was meant to avoid.

interface ThemeContextValue {
  readonly theme: ThemeName
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export interface ThemeProviderProps {
  /** The RESOLVED theme. 'system' is collapsed by the app, not here. */
  readonly theme: ThemeName
  readonly children: ReactNode
  readonly className?: string
  readonly testID?: string
}

export function ThemeProvider({ theme, children, className, testID }: ThemeProviderProps) {
  const value = useMemo(() => ({ theme }), [theme])
  return (
    <ThemeContext.Provider value={value}>
      <div data-theme={theme} data-testid={testID} className={cn('bg-canvas text-ink', className)}>
        {children}
      </div>
    </ThemeContext.Provider>
  )
}

/**
 * The active theme name.
 *
 * Throws outside a ThemeProvider rather than defaulting: a silent default is a
 * component that renders the wrong palette on one route and nobody notices until a
 * screenshot diff.
 *
 * WEB NOTE: components here never call this — they name semantic classes and the
 * cascade resolves the values. It exists for app code that has to branch on the theme
 * (an image asset, a map style, a chart library that takes concrete colours). The
 * native counterpart additionally returns a `palette`, because React Native has no
 * cascade to resolve a token name for it.
 */
export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext)
  if (value === null) {
    throw new Error('useTheme must be called inside a <ThemeProvider>')
  }
  return value
}
