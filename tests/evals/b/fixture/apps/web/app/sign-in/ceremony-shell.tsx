import { Text } from '@app/design-system'
import type { ReactNode } from 'react'

// The credential ceremony's page shell — one centered column, a heading, a
// lede, and the ceremony's client island. Sign-in, sign-up and the MFA
// challenge are three steps of ONE ceremony and must read as one place; a
// shared shell is what keeps a copy tweak on one of them from quietly
// restyling the other two apart. A SERVER component with no data reads — each
// page keeps its own metadata export and its own already-signed-in redirect,
// because those are per-step decisions (the challenge redirects the SIGNED-OUT
// visitor, the other two redirect the signed-in one).

interface CeremonyShellProps {
  readonly title: string
  readonly lede: string
  readonly children: ReactNode
}

export function CeremonyShell({ title, lede, children }: CeremonyShellProps): ReactNode {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-6 py-16">
      <Text as="h1" size="2xl" weight="semibold">
        {title}
      </Text>
      <Text tone="muted">{lede}</Text>
      {children}
    </main>
  )
}
