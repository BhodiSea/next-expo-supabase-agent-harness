import { Text } from '@app/design-system'
import type { ReactNode } from 'react'
import { t } from '../../../../lib/i18n'

// The org's landing page. The layout above has already resolved the slug against the
// caller's real seats (a 404 for anything else) and renders the org's name and the
// switcher, so this page reads nothing: it is what an org shows before the project has a
// content route of its own. Reviewed CHROME in tools/web-route-allowlist.json for that
// reason — with no query there is no loading, empty or error state to declare.
//
// The first content route a vertical adds becomes the org's landing: point the org picker,
// the switcher and the invitation redirect at it. The notes route `init --with-demo` plants
// is the worked example.
export default function OrgHomePage(): ReactNode {
  return (
    <Text as="p" tone="muted" testID="org-home">
      {t('org.home.description')}
    </Text>
  )
}
