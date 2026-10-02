// Drift classification for update's reconcile loops — pure (no IO), so the
// overwrite/park decision table is testable without a scaffold and can never
// diverge between the plan sweep and refresh-seeded.
import { sha256 } from './manifest.mjs'

// current: raw Buffer of the installed file, or null when the destination is
// absent. incoming: rendered template content (Buffer or string — sha256
// hashes both identically). recordedSha absent (or empty) means "no
// provenance", and this table reads it as unmodified. Both callers add their
// own policy for a missing record on top — that is caller policy, not
// classification: update's sweep keeps an owned file whose bytes no release
// shipped and parks the incoming copy (lib/provenance.mjs, 1.0.4), and
// refresh-seeded parks any file it cannot prove untouched.
/** @param {{ current: Buffer | string | null, recordedSha?: string, incoming: Buffer | string, force?: boolean }} spec */
export function classifyDrift({ current, recordedSha, incoming, force = false }) {
  if (current === null) return 'create'
  const currentSha = sha256(current)
  const incomingSha = sha256(incoming)
  if (!recordedSha || currentSha === recordedSha) {
    return currentSha === incomingSha ? 'skip-same' : 'update-clean'
  }
  // Local content already matches the incoming version (e.g. a fix was
  // applied by hand before updating): just re-record, no drift.
  if (currentSha === incomingSha) return 'record-only'
  return force ? 'force-overwrite' : 'park'
}
