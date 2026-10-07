// The change signal behind this app's module-level stores (theme.ts, i18n/index.ts). Each
// store keeps its own state and its own getSnapshot; what they share is the part that is
// identical by nature: a listener set, an `emit` that calls every listener, and the
// `subscribe` useSyncExternalStore takes. One copy of it here, one signal per store.
//
// IMPORTS NOTHING, on purpose: i18n/index.ts must keep its import closure free of
// react-native so the pure vitest suite can run the real store, and this module is in it.

interface ChangeSignal {
  /** Tell every current subscriber the store changed. */
  readonly emit: () => void
  /** Register a callback; the returned function unregisters it. */
  readonly subscribe: (callback: () => void) => () => void
}

/** A fresh signal with its own listener set: two stores never wake each other's subscribers. */
export function createChangeSignal(): ChangeSignal {
  const listeners = new Set<() => void>()
  return {
    emit: () => {
      for (const listener of listeners) listener()
    },
    subscribe: (callback) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    },
  }
}
