// Recently-run action ids, most recent first, persisted through the kv seam
// under an app-local key (the desktop original kept these in web storage; this
// host's src/lib/kv.ts is the same discipline with the platform swapped — every
// storage touch is corrupt-safe by construction). The store is defensive: a
// corrupt or foreign payload READS as empty — it never throws and never poisons
// the modal — and every read re-validates shape, dedupes, and re-caps, so no
// historical payload can overflow the pinned Recents section. Ids whose command
// no longer exists (a stale build) stay in storage but are filtered at the
// render seam in app/actions.tsx, where the LIVE command set is known.

import { kvGet, kvSet } from '../../lib/kv'

const STORAGE_KEY = 'actions.recents'
const MAX_RECENTS = 5

/** Parse an untrusted payload into at most MAX_RECENTS unique string ids. */
function sanitize(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  const ids: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string' && !ids.includes(entry)) ids.push(entry)
  }
  return ids.slice(0, MAX_RECENTS)
}

/** The persisted recents, newest first. Corrupt JSON or an unavailable store → []. */
export function readRecents(): readonly string[] {
  const raw = kvGet(STORAGE_KEY)
  if (raw === null) return []
  try {
    return sanitize(JSON.parse(raw))
  } catch {
    // Corrupt payload: reset to empty, never throw. (kvGet itself already
    // absorbs an unavailable native store — see src/lib/kv.ts.)
    return []
  }
}

/**
 * Record a command invocation: the id floats to the front, the list re-caps at
 * MAX_RECENTS, and the result is persisted AND returned so the caller can keep
 * component state in sync without a second read.
 */
export function pushRecent(id: string): readonly string[] {
  const next = [id, ...readRecents().filter((entry) => entry !== id)].slice(0, MAX_RECENTS)
  // kvSet swallows a non-persistent store — the in-session recents below still stand.
  kvSet(STORAGE_KEY, JSON.stringify(next))
  return next
}
