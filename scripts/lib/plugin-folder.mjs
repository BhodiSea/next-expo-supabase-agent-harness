// The installable plugin folder (#163): what plugin/ must hold, and how far the tree on disk
// is from it. One home for the rule, read by the generator (scripts/generate-plugin-folder.mjs)
// and the drift check in scripts/check-plugin-manifest.mjs, so the two can never disagree on
// which files are generated.
//
// The marketplace entry points at plugin/, and Claude Code installs exactly that folder. It
// used to point at the repository root, so an install copied every tracked file to deliver
// the thirty component files, and the plugin directory's automated checks hold for a
// reviewer any folder with more than 512 files or a non-image file over 256 KiB.
//
// Generated: agents/, commands/ and skills/, byte copies of template/base/.claude/, and
// LICENSE, a byte copy of the root LICENSE. All are regular files, because the plugin
// directory rejects a symbolic link for anything a plugin loads. Hand-edited: the manifest
// (.claude-plugin/plugin.json, whose version the release bump sets) and README.md. Anything
// else under plugin/ is drift.
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { walkFiles } from '../../installer/lib/fs-walk.mjs'

export const PLUGIN_DIR = 'plugin'
const COMPONENT_SOURCE = 'template/base/.claude'
const COMPONENTS = ['agents', 'commands', 'skills']
const HAND_EDITED = ['.claude-plugin/plugin.json', 'README.md']

// The plugin directory's pre-submission limits ("Files in the plugin folder").
const MAX_FILES = 512
const MAX_FILE_BYTES = 256 * 1024
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|svg)$/i

/**
 * Every generated file of plugin/, keyed by its POSIX path inside plugin/, with the
 * repository path it is copied from.
 * @param {string} root
 * @returns {Map<string, string>}
 */
export function generatedFiles(root) {
  const out = new Map()
  for (const sub of COMPONENTS) {
    for (const rel of walkFiles(join(root, COMPONENT_SOURCE, sub))) {
      out.set(`${sub}/${rel}`, `${COMPONENT_SOURCE}/${sub}/${rel}`)
    }
  }
  out.set('LICENSE', 'LICENSE')
  return out
}

/**
 * The difference between plugin/ on disk and what it must hold, as one line per problem.
 * `stale` lists the generated paths a write would create or replace, `extra` the paths a
 * write would delete; `problems` adds what no write fixes (a missing hand-edited file, a
 * symbolic link in a source, the directory's size limits).
 * @param {string} root
 * @returns {{ stale: string[], extra: string[], problems: string[] }}
 */
export function pluginDrift(root) {
  const pluginAbs = join(root, PLUGIN_DIR)
  const want = generatedFiles(root)
  const stale = []
  const problems = []
  for (const [rel, src] of want) {
    if (lstatSync(join(root, src)).isSymbolicLink()) {
      problems.push(`${src} is a symbolic link: the plugin directory rejects links, so the source must be a regular file`)
      continue
    }
    const dest = join(pluginAbs, rel)
    if (!existsSync(dest) || lstatSync(dest).isSymbolicLink()) stale.push(rel)
    else if (!readFileSync(dest).equals(readFileSync(join(root, src)))) stale.push(rel)
  }
  const onDisk = walkFiles(pluginAbs)
  const extra = onDisk.filter((rel) => !want.has(rel) && !HAND_EDITED.includes(rel))
  for (const rel of HAND_EDITED) {
    if (!existsSync(join(pluginAbs, rel))) problems.push(`${PLUGIN_DIR}/${rel}: missing (hand-edited, never generated)`)
  }
  if (onDisk.length >= MAX_FILES) {
    problems.push(`${PLUGIN_DIR}/ holds ${String(onDisk.length)} files: the plugin directory holds a folder of ${String(MAX_FILES)} or more for a reviewer`)
  }
  for (const rel of onDisk) {
    if (IMAGE_EXT.test(rel)) continue
    const size = lstatSync(join(pluginAbs, rel)).size
    if (size > MAX_FILE_BYTES) {
      problems.push(`${PLUGIN_DIR}/${rel} is ${String(size)} bytes: the plugin directory holds a non-image file over 256 KiB for a reviewer`)
    }
  }
  return { stale, extra, problems }
}

/**
 * Words outside fenced code blocks, as the plugin directory counts a README (it asks for 40).
 * @param {string} text
 * @returns {number}
 */
export function proseWordCount(text) {
  let fenced = false
  let words = 0
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (!fenced) words += line.split(/\s+/).filter((w) => /\w/.test(w)).length
  }
  return words
}
