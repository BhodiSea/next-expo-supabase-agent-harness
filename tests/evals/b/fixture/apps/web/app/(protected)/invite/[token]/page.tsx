import { Card, Text } from '@app/design-system'
import type { ReactNode } from 'react'
import { t } from '../../../../lib/i18n'
import { AcceptInviteButton } from './accept-invite-button'

// Invitation acceptance — in scope despite the "no member-management UI" cut, because
// without it no second user can ever join an org and the cross-tenant browser test cannot
// be written at all.
//
// This route is under (protected), so a signed-out visitor is sent to sign in first and
// arrives back here. That ordering is not a convenience: accept_invitation binds the seat to
// auth.uid(), so there is no way to redeem a token without first being someone.
//
// The page renders NOTHING about the invitation before it is redeemed — no org name, no
// inviter, no role. It cannot: the acceptor holds no seat yet, so every policy that could
// describe the org returns nothing to them. That is the design working, not a gap. Showing a
// preview would require a definer RPC that answers questions about an org to anyone holding
// a guessable token, which is the token oracle the whole invitation design avoids.

export const metadata = { title: t('route.acceptInvite') }

export default async function InvitePage({
  params,
}: {
  readonly params: Promise<{ readonly token: string }>
}): Promise<ReactNode> {
  const { token } = await params

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-6 px-6 py-16">
      <Text as="h1" size="2xl" weight="semibold">
        {t('route.acceptInvite')}
      </Text>
      <Card>
        <div className="flex flex-col items-start gap-3">
          <Text tone="muted" size="sm">
            {t('invite.lede')}
          </Text>
          {/* The token is passed to a CLIENT component and straight back to a Server Action.
              It is never rendered, never logged, and never put in a query string — the URL
              path already carries it, and that is one place too many to add a second. */}
          <AcceptInviteButton token={token} />
        </div>
      </Card>
    </main>
  )
}
