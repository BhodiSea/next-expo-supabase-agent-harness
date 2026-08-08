import { Text } from '@app/design-system'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { t } from '../lib/i18n'

// The unmatched-route surface, and REQUIRED chrome — the route-manifest gate reds on its
// absence, the same way it reds on a missing apps/mobile/app/+not-found.tsx.
//
// Without this file Next renders its own built-in 404: unbranded, untranslated, and outside
// every lane this repo runs. That page is also where a mistyped or stale deep link lands, which
// makes it one of the few screens a user reaches while already confused — so it says what
// happened and offers exactly one way back, rather than being a dead end with a status code.
// SOURCE: https://nextjs.org/docs/app/api-reference/file-conventions/not-found (the built-in
// not-found UI is used when no not-found file is provided)
//
// It is deliberately NOT registered in the route registry: it has no URL of its own (it renders
// AT the URL that did not match) and no data states, so it is reviewed chrome by nature. The
// gate excludes it from enumeration by convention rather than by allowlist, because a
// not-found file is never a page.
export default function NotFound(): ReactNode {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-6 py-16">
      <Text as="h1" size="2xl" weight="semibold">
        {t('notFound.title')}
      </Text>
      <Text tone="muted">{t('notFound.description')}</Text>
      <Link
        href="/"
        className="bg-accent text-canvas inline-flex w-fit items-center rounded-lg px-4 py-2 font-medium"
      >
        {t('notFound.home')}
      </Link>
    </main>
  )
}
