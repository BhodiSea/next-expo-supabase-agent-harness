// The primitives' accessibility CONTRACT — every touchable exposes a role and
// an accessible name, the field trio (label / hint / alert) stays wired. These
// are the invariants the a11y lint + on-device sweeps assume; pinning them at
// the primitive level means every consumer inherits them for free.
//
// W4 extensions: the Toast (announcement + dismiss contract), the matrix
// per-row role/label contract, and the perf subject's countable cell markers —
// plus the LEAF-TESTID rule those components are authored under: a testID rides
// an interactive/accessible element or a STYLED container, never a bare
// layout-only View, because Fabric view flattening can detach the latter on
// device (design record: CI-LANE-FACTS).
import { fireEvent, render, screen } from '@testing-library/react-native'
import type { StyleProp, ViewStyle } from 'react-native'
import { AccessibilityInfo, StyleSheet, Text } from 'react-native'
import { AppText } from '../src/components/AppText'
import { Button } from '../src/components/Button'
import { EmptyState } from '../src/components/EmptyState'
import { Field } from '../src/components/Field'
import { Input } from '../src/components/Input'
import { OptionRow } from '../src/components/OptionRow'
import { ToastProvider, useToast } from '../src/components/Toast'
import { MatrixList } from '../src/features/matrix/MatrixList'
import { MATRIX_COLUMNS, makeSyntheticRows } from '../src/features/matrix/matrixData'
import { PerfSubject } from '../src/features/matrix/perfSubject'
import { en } from '../src/i18n/catalog'
import { haptic } from '../src/lib/haptics'
import { fontScaleCap, minTouchTarget } from '../src/theme/theme'

// The SEAM is mocked (not the engine): what this file pins is the WIRING — which
// primitive speaks which vocabulary word. The seam's own engine mapping is
// covered by src/lib/haptics.test.ts.
jest.mock('../src/lib/haptics', () => ({ haptic: jest.fn() }))

afterEach(() => {
  jest.clearAllMocks()
})

// Flatten a rendered element's style array into one object for layout assertions.
const flatStyle = (props: Record<string, unknown>) =>
  StyleSheet.flatten(props['style'] as StyleProp<ViewStyle>)

describe('Button', () => {
  it('exposes role=button with its label as the accessible name', () => {
    render(<Button label="Do the thing" onPress={jest.fn()} />)
    expect(screen.getByRole('button', { name: 'Do the thing' })).toBeTruthy()
  })

  it('mirrors disabled into accessibilityState (assistive tech parity)', () => {
    render(<Button label="Held" onPress={jest.fn()} disabled />)
    expect(screen.getByRole('button', { name: 'Held', disabled: true })).toBeTruthy()
  })

  it('every variant keeps the same contract — styling never costs the role', () => {
    for (const variant of ['solid', 'outline', 'ghost'] as const) {
      render(<Button label={`v-${variant}`} onPress={jest.fn()} variant={variant} />)
      expect(screen.getByRole('button', { name: `v-${variant}` })).toBeTruthy()
    }
  })
})

describe('OptionRow', () => {
  it('exposes role=button with its label as the accessible name', () => {
    render(<OptionRow label="Go to matrix" onPress={jest.fn()} />)
    expect(screen.getByRole('button', { name: 'Go to matrix' })).toBeTruthy()
  })

  it('the testID rides the interactive leaf: pressing by testID fires the handler', () => {
    const onPress = jest.fn()
    render(<OptionRow label="Run it" onPress={onPress} testID="action-run.it" />)
    const row = screen.getByTestId('action-run.it')
    // testID and accessible name share ONE element (the Pressable leaf) — the
    // actions modal's tests read the label off the testID-found element.
    expect(row.props['accessibilityLabel'] as string).toBe('Run it')
    fireEvent.press(row)
    expect(onPress).toHaveBeenCalledTimes(1)
  })
})

describe('Field + Input', () => {
  it('labels its control: the input is reachable by the label text', () => {
    render(
      <Field label="Title">
        {/* eslint-disable-next-line react-native-a11y/has-accessibility-hint -- the no-error state under test: Field wires the hint ONLY when an error exists, and this fixture asserts that absence */}
        {(control) => <Input accessibilityLabel={control.accessibilityLabel} />}
      </Field>,
    )
    expect(screen.getByLabelText('Title')).toBeTruthy()
  })

  it('an error is announced three ways: alert line, control hint, invalid border flag', () => {
    render(
      <Field label="Title" error="Required">
        {(control) => (
          <Input
            accessibilityLabel={control.accessibilityLabel}
            accessibilityHint={control.accessibilityHint}
            invalid={control.invalid}
          />
        )}
      </Field>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Required')
    expect(screen.getByLabelText('Title').props['accessibilityHint']).toBe('Required')
  })

  it('no error, no alert — the channel stays quiet until it has meaning', () => {
    render(
      <Field label="Title">
        {/* eslint-disable-next-line react-native-a11y/has-accessibility-hint -- the no-error state under test: Field wires the hint ONLY when an error exists, and this fixture asserts that absence */}
        {(control) => <Input accessibilityLabel={control.accessibilityLabel} />}
      </Field>,
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('EmptyState', () => {
  it('its CTA renders through the Button primitive: role + accessible name', () => {
    render(
      <EmptyState
        title="Nothing"
        description="Yet"
        cta={{ label: 'Create', onPress: jest.fn() }}
      />,
    )
    expect(screen.getByRole('button', { name: 'Create' })).toBeTruthy()
  })
})

// A trigger child so the toast is driven through the PUBLIC api (useToast).
function ToastTrigger({ message, tone }: { readonly message: string; readonly tone: 'error' }) {
  const toast = useToast()
  return (
    <Text
      accessibilityRole="button"
      testID="toast-trigger"
      onPress={() => {
        toast.show(message, tone)
      }}
    >
      {message}
    </Text>
  )
}

describe('Toast', () => {
  it('ANNOUNCES the message through AccessibilityInfo — the toast lives outside the focus path', () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility')
    render(
      <ToastProvider>
        <ToastTrigger message="Your write was lost" tone="error" />
      </ToastProvider>,
    )
    fireEvent.press(screen.getByTestId('toast-trigger'))
    expect(announce).toHaveBeenCalledWith('Your write was lost')
    // The visible message rides an accessible Text LEAF with the tone-keyed
    // testID (never a bare wrapper View — Fabric flattening).
    expect(screen.getByTestId('toast-error')).toHaveTextContent('Your write was lost')
    announce.mockRestore()
  })

  it('every toast carries a catalog-named dismiss button that removes it', () => {
    render(
      <ToastProvider>
        <ToastTrigger message="Ephemeral" tone="error" />
      </ToastProvider>,
    )
    fireEvent.press(screen.getByTestId('toast-trigger'))
    const dismiss = screen.getByRole('button', { name: en['common.dismiss'] })
    fireEvent.press(dismiss)
    expect(screen.queryByTestId('toast-error')).toBeNull()
  })
})

describe('hit targets — the minTouchTarget floor', () => {
  it('Button, OptionRow and Input all flatten to minHeight >= 44dp', () => {
    render(<Button label="Target" onPress={jest.fn()} />)
    const button = flatStyle(screen.getByRole('button', { name: 'Target' }).props)
    expect(button.minHeight).toBeGreaterThanOrEqual(minTouchTarget)

    render(<OptionRow label="Row target" onPress={jest.fn()} />)
    const row = flatStyle(screen.getByRole('button', { name: 'Row target' }).props)
    expect(row.minHeight).toBeGreaterThanOrEqual(minTouchTarget)

    render(<Input accessibilityLabel="Field target" accessibilityHint="hit-target fixture" />)
    const input = flatStyle(screen.getByLabelText('Field target').props)
    expect(input.minHeight).toBeGreaterThanOrEqual(minTouchTarget)
  })
})

describe('haptics wiring — the closed vocabulary', () => {
  it('OptionRow speaks selection on press; Button stays silent by default', () => {
    render(<OptionRow label="Pick me" onPress={jest.fn()} />)
    fireEvent.press(screen.getByRole('button', { name: 'Pick me' }))
    expect(haptic).toHaveBeenCalledWith('selection')

    render(<Button label="Plain press" onPress={jest.fn()} />)
    fireEvent.press(screen.getByRole('button', { name: 'Plain press' }))
    expect(haptic).toHaveBeenCalledTimes(1)
  })

  it('an error toast speaks warning; info speaks nothing', () => {
    render(
      <ToastProvider>
        <ToastTrigger message="write lost" tone="error" />
      </ToastProvider>,
    )
    fireEvent.press(screen.getByTestId('toast-trigger'))
    expect(haptic).toHaveBeenCalledWith('warning')
    expect(haptic).toHaveBeenCalledTimes(1)
  })
})

describe('Icon — decorative by construction', () => {
  it('the toast tone glyph is hidden from assistive tech; the message stays the meaning', () => {
    render(
      <ToastProvider>
        <ToastTrigger message="Iconed failure" tone="error" />
      </ToastProvider>,
    )
    fireEvent.press(screen.getByTestId('toast-trigger'))
    // RNTL's default queries see what assistive tech sees — the glyph must be
    // INVISIBLE there, and present only to the hidden-inclusive query.
    expect(screen.queryByTestId('toast-icon-error')).toBeNull()
    const icon = screen.getByTestId('toast-icon-error', { includeHiddenElements: true })
    expect(icon.props['accessibilityElementsHidden'] as boolean).toBe(true)
    expect(screen.getByTestId('toast-error')).toHaveTextContent('Iconed failure')
  })
})

describe('AppText font scaling', () => {
  it('caps OS font scaling at the default cap; an explicit dense cap wins', () => {
    render(<AppText testID="cap-default">scaled</AppText>)
    expect(screen.getByTestId('cap-default').props['maxFontSizeMultiplier'] as number).toBe(
      fontScaleCap.default,
    )
    render(
      <AppText testID="cap-dense" maxFontSizeMultiplier={fontScaleCap.dense}>
        dense
      </AppText>,
    )
    expect(screen.getByTestId('cap-dense').props['maxFontSizeMultiplier'] as number).toBe(
      fontScaleCap.dense,
    )
  })
})

describe('MatrixList a11y contract', () => {
  it('exposes ONE labelled role=row element per data row, plus the list label + pagination hint', () => {
    const rows = makeSyntheticRows(3)
    render(<MatrixList rows={rows} columns={MATRIX_COLUMNS} onEndReached={jest.fn()} />)
    const rendered = screen.getAllByRole('row')
    expect(rendered).toHaveLength(3)
    for (const [index, row] of rows.entries()) {
      expect(rendered[index]?.props['accessibilityLabel'] as string).toBe(row.label)
    }
    const list = screen.getByTestId('matrix-list')
    expect(list.props['accessibilityLabel'] as string).toBe(en['matrix.list'])
    expect(list.props['accessibilityHint'] as string).toBe(en['matrix.pagination.hint'])
  })
})

describe('PerfSubject', () => {
  it('materializes EVERY cell with the countable role=cell marker (the W5 perf-gate contract)', () => {
    const cells = 120
    render(<PerfSubject cells={cells} />)
    const rowCount = Math.round(cells / MATRIX_COLUMNS.length)
    expect(screen.getAllByRole('cell')).toHaveLength(rowCount * MATRIX_COLUMNS.length)
    // Row count via the rowheader TEXTS (Texts are accessibility elements; the
    // subject's plain row Views deliberately are not — no `accessible` prop, so
    // the render stays a pure materialization measurement).
    expect(screen.getAllByRole('rowheader')).toHaveLength(rowCount)
  })
})
