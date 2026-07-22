// Template tree walker: resolves storage names to installed paths, strips
// .tmpl suffixes, applies top-level dotless renames, and renders placeholders.
// Walking (walkTemplate) and rendering (renderEntry) are split so callers that
// only need paths — doctor's seeded advisory, update --refresh-seeded — never
// pay to render the whole tree.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RENAMES } from './layout.mjs'
import { render } from './placeholders.mjs'

// Manifest keys, mode prefixes (SEEDED_PREFIXES 'apps/'), RETROFIT_ADDITIVE
// lookups, and doctor's '.claude/hooks/' classifier all assume POSIX
// separators. path.join yields backslashes on Windows, which silently
// reclassified every stack file as 'owned' there and made manifests
// non-portable across OSes — normalize once, at the only emit point.
// Split on the literal '\\', not path.sep: update also heals manifests
// WRITTEN by pre-0.1.3 Windows installs while running on any OS, where sep
// is '/' and a sep-split would silently keep the broken keys.
export function toPosix(p) {
  return p.split('\\').join('/')
}

export function templateRoot() {
  // fileURLToPath, NOT URL.pathname: on Windows the latter yields /D:/… which
  // readdirSync cannot open — the walker's error guard then produced a silent
  // empty plan and `init` "succeeded" with 0 files (caught by bootstrap-windows CI).
  return fileURLToPath(new URL('../../template/', import.meta.url))
}

// Binary assets (icons, fonts, …) must round-trip byte-for-byte: decoding them
// as UTF-8 replaces non-UTF-8 bytes with U+FFFD and corrupts the file, and
// placeholder rendering makes no sense inside them. They are copied as Buffers.
const BINARY_EXT = /\.(png|ico|icns|gif|jpe?g|webp|avif|bmp|woff2?|ttf|otf|eot|pdf|zip|bin)$/i

// THE template→install rename rule, as one pure function over a TREE-RELATIVE
// storage path ('gitignore', 'github/workflows/ci.yml', 'tools/x.mjs.tmpl'):
// the FIRST segment maps through the top-level dotless RENAMES (dir or file —
// nested names never rename), and the last segment drops a `.tmpl` suffix.
// walkTemplate routes every installPath through here, and the harness repo's
// seeded-migrations selftest gate maps `git diff` paths through the same
// function — so the two can never disagree about where a stored file lands.
export function storageToInstall(treeRelPath) {
  const parts = toPosix(treeRelPath).split('/')
  if (RENAMES.has(parts[0])) parts[0] = RENAMES.get(parts[0])
  parts[parts.length - 1] = parts[parts.length - 1].replace(/\.tmpl$/, '')
  return parts.join('/')
}

// Walk one template tree ('base' | 'stack' | 'modules/<name>') and return
// [{ storagePath, installPath, sourcePath }] WITHOUT content — pass an entry
// to renderEntry to materialize it.
export function walkTemplate(tree) {
  const root = join(templateRoot(), tree)
  const out = []
  walk(root, '', '')
  return out

  // relStorage tracks the as-stored names (feeds storageToInstall); relInstall
  // tracks the renamed names, purely to keep storagePath byte-identical to its
  // historical shape (renamed dir segments, raw leaf name — consumers key off
  // the `stack/` prefix and the `.tmpl` suffix).
  function walk(dir, relStorage, relInstall) {
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries.sort()) {
      const abs = join(dir, entry)
      const st = statSync(abs)
      // Top-level dotless names map back to their dot-path installs.
      const name = relInstall === '' && RENAMES.has(entry) ? RENAMES.get(entry) : entry
      if (st.isDirectory()) {
        walk(abs, join(relStorage, entry), join(relInstall, name))
        continue
      }
      out.push({
        storagePath: toPosix(join(tree, relInstall, entry)),
        installPath: storageToInstall(toPosix(join(relStorage, entry))),
        sourcePath: abs,
      })
    }
  }
}

export function renderEntry(entry, answers) {
  return BINARY_EXT.test(entry.sourcePath)
    ? readFileSync(entry.sourcePath) // Buffer, verbatim — no placeholder rendering
    : render(readFileSync(entry.sourcePath, 'utf8'), answers)
}

// Walk + render one template tree and return
// [{ storagePath, installPath, content }] with placeholders rendered.
// (`module` is stamped post-hoc by init on module-tree entries.)
/**
 * @returns {{ storagePath: string, installPath: string, content: string | Buffer, module?: string }[]}
 */
export function planTree(tree, answers) {
  return walkTemplate(tree).map(({ storagePath, installPath, sourcePath }) => ({
    storagePath,
    installPath,
    content: renderEntry({ sourcePath }, answers),
  }))
}
