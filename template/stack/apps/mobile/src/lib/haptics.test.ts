// The haptics seam's engine mapping — this test is the ONE file besides the
// seam allowed to import expo-haptics (both named in the eslint one-door
// ignore), because proving the mapping requires mocking the engine itself.
// Everything else asserts against the seam (see primitives-a11y).
import * as Haptics from 'expo-haptics'
import { haptic } from './haptics'

jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  NotificationFeedbackType: {
    Success: 'success-type',
    Warning: 'warning-type',
    Error: 'error-type',
  },
}))

afterEach(() => {
  jest.clearAllMocks()
})

describe('the closed vocabulary maps onto the engine', () => {
  it("'selection' fires selectionAsync and nothing else", () => {
    haptic('selection')
    expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1)
    expect(Haptics.notificationAsync).not.toHaveBeenCalled()
  })

  it("'success' and 'warning' fire notificationAsync with the matching feedback type", () => {
    haptic('success')
    expect(Haptics.notificationAsync).toHaveBeenCalledWith('success-type')
    haptic('warning')
    expect(Haptics.notificationAsync).toHaveBeenCalledWith('warning-type')
  })

  it('a rejecting engine is swallowed — haptics are never load-bearing', async () => {
    jest.mocked(Haptics.selectionAsync).mockRejectedValueOnce(new Error('no engine'))
    expect(() => {
      haptic('selection')
    }).not.toThrow()
    // Let the rejection settle through the seam's catch (an unhandled rejection
    // would fail the suite).
    await Promise.resolve()
  })
})
