// The ONE synchronous key-value seam. expo-sqlite/kv-store is the current
// drop-in for async-storage with a sync API (design record: EXPO-FACTS), which
// is what lets theme + locale resolve BEFORE the first frame — no async
// hydration gap, no flash of the wrong theme or direction.
//
// Corrupt-safe by construction (the same discipline as the desktop original's
// storage seams): every touch is try/caught, so storage that is missing (fresh
// install), corrupt, or unavailable (jest's mocked native layer) reads as
// ABSENT — never a throw at boot, and never a poisoned store. Callers
// re-validate every value they read; a stored string is untrusted input.
import Storage from 'expo-sqlite/kv-store'

/** Read a value; a missing, corrupt, or unavailable store reads as null. */
export function kvGet(key: string): string | null {
  try {
    return Storage.getItemSync(key)
  } catch {
    return null
  }
}

/** Persist a value; a non-persistent store still keeps the in-session state. */
export function kvSet(key: string, value: string): void {
  try {
    Storage.setItemSync(key, value)
  } catch {
    // The module-level stores (theme, locale) hold the live value regardless.
  }
}

/** Delete a value; absence is the goal, so an unreachable store already counts. @public — seam API (test-driven; features delete through their own stores). */
export function kvDelete(key: string): void {
  try {
    Storage.removeItemSync(key)
  } catch {
    // Already indistinguishable from deleted on the next read.
  }
}
