import { Text, View } from 'react-native'
import { formatCellValue } from '../../i18n'
import { MATRIX_COLUMNS, makeSyntheticRows } from './matrixData'

// Perf-budget subject — an ISLAND, and a CONTRACT with the W5 mobile-perf gate.
//
// The desktop original rendered its grid to an HTML string (react-dom/server)
// and counted role="gridcell" markers; this host has no server renderer, so the
// subject is a PURE component the gate mounts under the jest-expo/test-renderer
// pipeline instead. The contract the gate relies on:
//
//   1. <PerfSubject cells={N} /> materializes EVERY cell — no FlatList, no
//      virtualization, no measurement-dependent windows. A plain map is the
//      point: the budget measures a full dense render, not a clever partial one.
//   2. Every cell carries role="cell" (the ARIA-style RN `role` prop) — the
//      countable marker. Rendered cells == round(cells / columns) * columns.
//   3. Rows come from makeSyntheticRows (seeded PRNG): the same N renders the
//      same tree every run, on every machine — a budget over nondeterministic
//      content would measure the content, not the renderer.
//   4. `tick` (0.1.2, optional) is the UPDATE-phase handle: the harness
//      re-renders the mounted tree with a changed tick per run and times the
//      reconciliation pass. Rendering it into the grid's testID keeps the
//      update observable — and because props change every update, wrapping the
//      subject in React.memo cannot fake a fast update either.
//
// Nothing reachable from the app shell imports this module (bundle purity — the
// subject exists for its unit test and the perf gate's harness only).
export function PerfSubject({
  cells,
  tick = 0,
}: {
  readonly cells: number
  readonly tick?: number
}) {
  const columnCount = MATRIX_COLUMNS.length
  const rowCount = Math.max(1, Math.round(cells / columnCount))
  const rows = makeSyntheticRows(rowCount)
  return (
    <View role="grid" testID={`perf-grid-${String(tick)}`}>
      {rows.map((row) => (
        <View key={row.id} role="row">
          <Text role="rowheader">{row.label}</Text>
          {row.values.map((value, index) => (
            <Text key={MATRIX_COLUMNS[index]?.key ?? String(index)} role="cell">
              {formatCellValue(value)}
            </Text>
          ))}
        </View>
      ))}
    </View>
  )
}
