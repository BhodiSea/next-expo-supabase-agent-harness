import { Link } from 'expo-router'
import { AppText } from '../src/components/AppText'
import { Screen } from '../src/components/Screen'
import { useI18n } from '../src/i18n'

// Unmatched-route surface (expo-router convention file). Chrome, not content:
// no src/routes.ts entry — there is no data state to declare, only a way home.
export default function NotFoundScreen() {
  const { t } = useI18n()
  return (
    <Screen testID="not-found-screen">
      <AppText variant="title">{t('notFound.title')}</AppText>
      <AppText variant="muted">{t('notFound.body')}</AppText>
      {/* Link renders an accessible link role; the child AppText keeps the
          copy inside the catalog + tokens like every other string. */}
      <Link href="/">
        <AppText>{t('notFound.home')}</AppText>
      </Link>
    </Screen>
  )
}
