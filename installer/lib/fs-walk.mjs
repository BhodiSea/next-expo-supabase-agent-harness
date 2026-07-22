// Shared recursive file walker — the one implementation behind doctor's
// pending scan and the repo's hygiene/syntax/residue gates, so exclude and
// ordering semantics can never fork per caller. Semantics are identical to
// template/base/tools/lib/fs-walk.mjs (dirent-based: directory-only pruning,
// and a broken symlink can never crash the walk the way a stat would).
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Deterministic (per-directory code-unit-sorted, depth-first) file listing as
// POSIX-relative paths under root. A missing/unreadable root yields [] —
// callers that must fail loud on an empty scan guard that themselves
// (false-green prevention is a caller policy, not a walker one).
// excludeDirs prunes by DIRECTORY name at every depth; filter sees the POSIX
// relative path of each file.
/**
 * @param {string} root
 * @param {{ excludeDirs?: Iterable<string>, filter?: (rel: string) => boolean }} [opts]
 * @returns {string[]}
 */
export function walkFiles(root, { excludeDirs = [], filter } = {}) {
  if (!existsSync(root)) return []
  const excluded = new Set(excludeDirs)
  const out = []
  const visit = (dir, prefix) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      // Built by string concat, never path.join — output must be POSIX on
      // every OS (manifest keys, gate messages, and tests compare these).
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        if (!excluded.has(entry.name)) visit(join(dir, entry.name), rel)
      } else if (!filter || filter(rel)) {
        out.push(rel)
      }
    }
  }
  visit(root, '')
  return out
}
