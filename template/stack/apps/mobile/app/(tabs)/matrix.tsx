import { View } from 'react-native'
import { AppText } from '../../src/components/AppText'
import { Button } from '../../src/components/Button'
import { Card } from '../../src/components/Card'
import { EmptyState } from '../../src/components/EmptyState'
import { Screen } from '../../src/components/Screen'
import { Skeleton } from '../../src/components/Skeleton'
import { Spinner } from '../../src/components/Spinner'
import { useToast } from '../../src/components/Toast'
import { MatrixList } from '../../src/features/matrix/MatrixList'
import { MATRIX_COLUMNS, notesToMatrixRows } from '../../src/features/matrix/matrixData'
import { useKeysetQuery } from '../../src/features/matrix/useKeysetQuery'
import { useI18n } from '../../src/i18n'
import { ROUTES } from '../../src/routes'
import { type Palette, useThemedStyles } from '../../src/theme/theme'
import { spacing } from '../../src/theme/tokens.gen'

// The matrix route's screen. Same three canonical data states as the home panel
// (loading/empty/error testIDs from src/routes.ts, driven by the states sweep),
// then the ready surface: the dense FlatList and a reachable Load-more control
// that mirrors the near-end scroll trigger — the trigger is silent and
// touch-only, the button is neither.

// ROUTES entry 1 IS the matrix entry (id 'matrix') — literal-typed testIDs.
const MATRIX = ROUTES[1]

const matrixStyles = (_palette: Palette) => ({
  loadMoreRow: {
    alignItems: 'center' as const,
    flexDirection: 'row' as const,
    gap: spacing * 2,
  },
})

export default function MatrixScreen() {
  const { t } = useI18n()
  const styles = useThemedStyles(matrixStyles)
  const toast = useToast()
  const { state, loadMore, reload } = useKeysetQuery((message) => {
    // `message` is the translated envelope copy from useKeysetQuery — the
    // sentence around it is the catalog's.
    toast.show(t('matrix.loadMore.toast', { message }), 'error')
  })
  const rows = notesToMatrixRows(state.rows)

  return (
    <Screen testID="matrix-screen">
      <AppText variant="title">{t('matrix.heading')}</AppText>
      {state.status === 'loading' && (
        // Skeleton, not prose: six placeholder lines approximate the dense list
        // about to paint. The state testID rides the skeleton's accessible
        // container (design record: CI-LANE-FACTS).
        <Skeleton lines={6} testID={MATRIX.states.loading} />
      )}
      {state.status === 'empty' && (
        <EmptyState
          testID={MATRIX.states.empty}
          title={t('matrix.empty.title')}
          description={t('matrix.empty.description')}
          cta={{ label: t('common.reload'), onPress: reload }}
        />
      )}
      {state.status === 'error' && (
        // The danger-toned Card: the failure surface must not be the same box
        // as the empty one, and the container-level testID survives Fabric on
        // the styled Card — it must CONTAIN the retry button per the manifest.
        <Card tone="danger" testID={MATRIX.states.error}>
          {/* Three registers — the same contract NotesPanel documents: WHAT
              failed (catalog), WHY (catalog copy selected by the envelope's
              stable `code`), and the raw failure text, untranslatable by
              nature, quiet and last. */}
          <AppText variant="label">{t('matrix.error.title')}</AppText>
          {state.error !== null && <AppText role="alert">{state.error.message}</AppText>}
          {state.error !== null && state.error.detail !== null && state.error.detail !== '' && (
            <AppText variant="muted">
              {state.error.detail}
              {state.error.requestId !== null &&
                ` — ${t('error.reference', { id: state.error.requestId })}`}
            </AppText>
          )}
          <Button label={t('common.retry')} onPress={reload} />
        </Card>
      )}
      {state.status === 'ready' && (
        <>
          {/* One key, not a sentence assembled from fragments: `count` picks the
              plural branch via Intl.PluralRules, so a single-row matrix never
              reads "1 rows" — and a language whose rule is not English's
              two-form split gets its own branch from the catalog. */}
          <AppText variant="muted" testID="matrix-summary">
            {t('matrix.summary', {
              count: rows.length,
              rows: rows.length,
              columns: MATRIX_COLUMNS.length,
            })}
          </AppText>
          <MatrixList
            rows={rows}
            columns={MATRIX_COLUMNS}
            onEndReached={loadMore}
            onRefresh={reload}
          />
          {state.loadMoreFailed && (
            <View style={styles.loadMoreRow}>
              <AppText variant="muted" role="alert">
                {t('matrix.loadMore.failed')}
              </AppText>
              <Button variant="outline" label={t('common.retry')} onPress={loadMore} />
            </View>
          )}
          {state.cursor !== null && (
            <View style={styles.loadMoreRow}>
              <Button
                label={state.loadingMore ? t('matrix.loadingMore') : t('matrix.loadMore')}
                disabled={state.loadingMore}
                onPress={loadMore}
                testID="matrix-load-more"
              />
              {/* The in-flight page fetch gets a visible pulse next to the
                  disabled control — the label alone reads as a frozen button. */}
              {state.loadingMore && <Spinner testID="matrix-load-more-busy" />}
            </View>
          )}
        </>
      )}
    </Screen>
  )
}
