import { Text } from '@app/design-system'
import type { ReactNode } from 'react'
import { t } from '../../../lib/i18n'
import { FactorsPanel } from './factors-panel'
import { meta } from './page.meta'

// The account-security page: the enrolled second factors, with enrol and remove
// actions. A server shell around one client island — and the island is where
// the data lives, deliberately: the factor list must be re-read after every
// enrol/unenroll WITHOUT a navigation, and the browser client is the thing
// whose session the MFA API mutates. A server-side read here would render a
// list one action stale.
//
// The signed-in check is the (protected) layout's; the page itself protects
// nothing. What ENFORCES the second factor is the database rail — this page
// only lets a user opt into it, and see what they have opted into.
// SOURCE: supabase/migrations/20260812000000_mfa_aal2.sql (aal2 enforced at
// the database for every user holding a verified factor)

// Title from the route's OWN meta — the registry and the browser tab read one
// declaration.
export const metadata = { title: t(meta.titleKey) }

export default function SecurityPage(): ReactNode {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10">
      <Text as="h1" size="2xl" weight="semibold">
        {t(meta.titleKey)}
      </Text>
      <Text tone="muted">{t('security.lede')}</Text>
      <FactorsPanel />
    </main>
  )
}
