import { SEMANTIC_TOKENS } from '@app/design-tokens'
import type { Palette, ThemeName } from '@app/design-tokens/native'
import { palettes } from '@app/design-tokens/native'
import { vars } from 'nativewind'
import { createContext, type ReactNode, useContext, useMemo } from 'react'
import { View } from 'react-native'
import { cn } from './cn'
import { colorVarName } from './preset'

// The theme root, and on this platform it is not optional.
//
// React Native has no cascade and no `prefers-color-scheme`, so nothing resolves
// `bg-canvas` until something declares what `--color-canvas` is. NativeWind's `vars()`
// writes CSS variables onto a style object; every descendant class then reads them,
// and swapping `theme` re-resolves every colour in the tree WITHOUT recompiling a
// single class string.
//
// The alternative — compiling both themes into the classes and switching with the
// `dark:` variant — was rejected: it doubles every colour utility in the bundle, and
// it ties the app's own theme preference (which is persisted, and can differ from the
// OS) to a signal the class layer reads directly.
//
// A RESOLVED theme name is required, never 'system'. Collapsing 'system' needs the OS
// signal plus the persisted preference, which is app state; the design system does not
// own it and would only be guessing.

interface ThemeContextValue {
  readonly theme: ThemeName
  /**
   * NATIVE-ONLY. The web twin returns only `theme`, because the browser resolves a
   * token name through the cascade and JavaScript never needs the value. Here the
   * platform APIs that are not styleable by class — ActivityIndicator's `color`,
   * TextInput's `placeholderTextColor`, a status-bar style — need the concrete string.
   */
  readonly palette: Palette
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export interface ThemeProviderProps {
  /** The RESOLVED theme. 'system' is collapsed by the app, not here. */
  readonly theme: ThemeName
  readonly children: ReactNode
  readonly className?: string
  readonly testID?: string
}

// Built from SEMANTIC_TOKENS rather than Object.keys(palette): the canonical array is
// the same one the token generators walk, so a token added to the design system cannot
// end up defined in the stylesheet and missing from the runtime variables.
function themeVars(theme: ThemeName): Record<string, string> {
  const palette = palettes[theme]
  const declarations: Record<string, string> = {}
  for (const token of SEMANTIC_TOKENS) {
    declarations[colorVarName(token)] = palette[token]
  }
  return declarations
}

export function ThemeProvider({ theme, children, className, testID }: ThemeProviderProps) {
  const value = useMemo(() => ({ theme, palette: palettes[theme] }), [theme])
  const style = useMemo(() => vars(themeVars(theme)), [theme])
  return (
    <ThemeContext.Provider value={value}>
      <View style={style} className={cn('flex-1 bg-canvas', className)} testID={testID}>
        {children}
      </View>
    </ThemeContext.Provider>
  )
}

/**
 * The active theme name and its resolved palette.
 *
 * Throws outside a ThemeProvider rather than defaulting to dark: a silent default here
 * would render a screen whose classes resolve to nothing (every `bg-canvas` becomes an
 * undefined variable) while `useTheme()` cheerfully reports a palette — an invisible
 * screen with no error, which is the single hardest failure of this kind to diagnose.
 */
export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext)
  if (value === null) {
    throw new Error('useTheme must be called inside a <ThemeProvider>')
  }
  return value
}
