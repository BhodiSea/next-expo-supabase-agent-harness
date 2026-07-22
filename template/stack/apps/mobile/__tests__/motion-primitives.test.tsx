// The motion-seam + loading-primitive contract. Loading surfaces are skeletons/
// spinners with a progressbar role and the catalog's loading copy as accessible
// name (never bare prose), the reduce-motion signal is subscribed with a paired
// teardown (the perf-budget leak-scan contract, asserted behaviorally here), and
// a reduce-motion host still renders the full a11y surface — the collapse is
// visual only.
import { act, render, screen } from '@testing-library/react-native'
import { AccessibilityInfo } from 'react-native'
import { Skeleton } from '../src/components/Skeleton'
import { Spinner } from '../src/components/Spinner'
import { en } from '../src/i18n/catalog'

afterEach(() => {
  jest.restoreAllMocks()
})

describe('Skeleton', () => {
  it('exposes role=progressbar with the catalog loading copy as its accessible name', () => {
    render(<Skeleton />)
    expect(screen.getByRole('progressbar', { name: en['common.loading'] })).toBeTruthy()
  })

  it('the testID rides the announced container — route states.loading ids bind here', () => {
    render(<Skeleton testID="home-loading" />)
    const block = screen.getByTestId('home-loading')
    expect(block.props['accessibilityRole'] as string).toBe('progressbar')
  })

  it('under OS reduce-motion the a11y surface is unchanged — the collapse is visual only', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true)
    render(<Skeleton />)
    // Let the async reduce-motion read resolve and re-render before asserting.
    await act(() => Promise.resolve())
    expect(screen.getByRole('progressbar', { name: en['common.loading'] })).toBeTruthy()
  })

  it('tears down its reduce-motion subscription on unmount (the leak-scan contract, behaviorally)', () => {
    const remove = jest.fn()
    const addListener = jest
      .spyOn(AccessibilityInfo, 'addEventListener')
      .mockReturnValue({ remove } as unknown as ReturnType<
        typeof AccessibilityInfo.addEventListener
      >)
    const { unmount } = render(<Skeleton />)
    expect(addListener).toHaveBeenCalledWith('reduceMotionChanged', expect.any(Function))
    expect(remove).not.toHaveBeenCalled()
    unmount()
    expect(remove).toHaveBeenCalledTimes(1)
  })
})

describe('Spinner', () => {
  it('exposes role=progressbar with the catalog loading copy as its accessible name', () => {
    render(<Spinner />)
    expect(screen.getByRole('progressbar', { name: en['common.loading'] })).toBeTruthy()
  })

  it('passes the testID through for state-surface binding', () => {
    render(<Spinner testID="footer-busy" size="large" />)
    expect(screen.getByTestId('footer-busy')).toBeTruthy()
  })
})
