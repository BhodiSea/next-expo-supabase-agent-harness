// change-signal suite (pure vitest: the module imports nothing). What is under test is the
// contract theme.ts and i18n/index.ts hand to useSyncExternalStore: an emit reaches every
// subscriber, an unsubscribed callback is never called again, and two stores' signals never
// share a listener.
import { describe, expect, it, vi } from 'vitest'
import { createChangeSignal } from './change-signal'

describe('createChangeSignal', () => {
  it('emit reaches every subscriber', () => {
    const { emit, subscribe } = createChangeSignal()
    const first = vi.fn()
    const second = vi.fn()
    subscribe(first)
    subscribe(second)
    emit()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('an unsubscribed listener is not called', () => {
    const { emit, subscribe } = createChangeSignal()
    const kept = vi.fn()
    const dropped = vi.fn()
    subscribe(kept)
    const unsubscribe = subscribe(dropped)
    unsubscribe()
    emit()
    expect(kept).toHaveBeenCalledTimes(1)
    expect(dropped).not.toHaveBeenCalled()
  })

  it('two signals do not share listeners', () => {
    const theme = createChangeSignal()
    const locale = createChangeSignal()
    const onTheme = vi.fn()
    const onLocale = vi.fn()
    theme.subscribe(onTheme)
    locale.subscribe(onLocale)
    theme.emit()
    expect(onTheme).toHaveBeenCalledTimes(1)
    expect(onLocale).not.toHaveBeenCalled()
  })
})
