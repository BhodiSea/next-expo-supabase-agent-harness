// tools/lib/fs-walk.mjs — the ONE recursive file walker for gate scripts. Every
// gate that enumerates a tree imports this instead of hand-rolling readdir
// recursion (six drifted copies before v0.1.4 of the source harness): output is
// depth-first with code-unit-sorted siblings, so digests, error lists, and
// counts are order-stable across platforms and runs.
// SOURCE: docs/harness/README.md (the gate is the enforcement) [corpus: harness/doctrine]
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// join() yields backslashes on Windows; every path a gate emits, compares, or
// hashes must be POSIX first.
export const toPosix = (p) => p.split('\\').join('/')

// walkFiles(root, { excludeDirs, filter }) — files only, POSIX paths RELATIVE
// TO root. A missing root returns []: surface-absence policy (skip vs fail)
// belongs to the calling gate, not the walker. excludeDirs prunes by directory
// NAME at every depth; filter sees the relative POSIX path.
/**
 * @param {string} root
 * @param {{ excludeDirs?: Set<string>, filter?: (rel: string) => boolean }} [opts]
 * @returns {string[]}
 */
export function walkFiles(root, { excludeDirs = new Set(), filter } = {}) {
  if (!existsSync(root)) return []
  const out = []
  const visit = (dir, prefix) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        if (!excludeDirs.has(entry.name)) visit(join(dir, entry.name), rel)
      } else if (filter === undefined || filter(rel)) {
        out.push(rel)
      }
    }
  }
  visit(root, '')
  return out
}
