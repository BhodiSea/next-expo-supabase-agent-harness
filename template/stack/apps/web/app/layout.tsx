import { oklchToHex, themes } from '@app/design-tokens'
import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import './globals.css'
import { Providers } from './providers'

// The root layout: the only place in the app that renders <html> and <body>, and the only
// place globals.css is imported. It stays a SERVER component — the shell is the largest
// component in the tree, and marking it 'use client' would drag every page under it across
// the boundary and ship the whole app to the browser. The client-only concerns it needs
// (the query cache) are isolated in ./providers.tsx, which is the correct shape: push
// 'use client' as far down the tree as it will go.

export const metadata: Metadata = {
  // Literal text, NOT the {{...}} project-name placeholder. A rendered name containing an
  // apostrophe would terminate this string literal and break the very first `next build`
  // after init — the same hazard supabase/seed.sql documents at its own literal. This is the
  // first string to change by hand after scaffolding, and the only one that matters for
  // browser tabs and link previews.
  //
  // `template` is what gives every nested page a suffixed title for free — a page setting
  // `title: 'Notes'` becomes "Notes · Web" without repeating the product name in thirty
  // files.
  title: {
    default: 'Web',
    template: '%s · Web',
  },
  description: 'Next.js web client and API host.',
  // Explicitly non-indexable by default. A scaffold that ships crawlable is a scaffold whose
  // half-built staging deploy ends up in search results; turning this off is a deliberate
  // act at launch, which is the right direction for the default to fail in.
  robots: { index: false, follow: false },
}

// themeColor drives the browser/OS chrome around the page (the Android status bar, Safari's
// toolbar tint). It reads the SAME token module the stylesheet is generated from, so the
// chrome cannot drift from the canvas the way a hand-copied hex always eventually does.
//
// SOURCE: the source is @app/design-tokens' framework-neutral `.` barrel (`themes`, the OKLCH
// SemanticPalette the web `@theme` block is generated from) — NOT `@app/design-tokens/native`,
// whose `palettes` is the React Native adapter and is off-limits to a web surface (apps/web
// must not import react-native*, W1-STACK-SPEC §2). The web bundle otherwise consumes tokens
// through the generated CSS @theme, but a <meta name="theme-color"> is emitted server-side and
// needs a concrete colour string, not a `var(--color-canvas)` the browser resolves later — so
// the OKLCH source is converted to hex here with the package's own `oklchToHex`. Hex, not an
// `oklch()` string, because theme-color must render on the OS chrome of older engines too.
// SOURCE: docs/harness/README.md (design tokens are the single source; nothing hand-copies a
// colour) · design/W1-STACK-SPEC.md §5 (the native adapter rides its own subpath)
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: oklchToHex(themes.light.canvas) },
    { media: '(prefers-color-scheme: dark)', color: oklchToHex(themes.dark.canvas) },
  ],
}

export default function RootLayout({
  children,
}: {
  readonly children: ReactNode
}): ReactNode {
  return (
    // lang is not decoration: screen readers pick pronunciation from it, and browsers pick
    // hyphenation and translation prompts. An unset lang is a WCAG failure.
    // SOURCE: https://www.w3.org/WAI/WCAG22/Understanding/language-of-page.html
    <html lang="en">
      <body className="min-h-dvh bg-canvas text-ink antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
