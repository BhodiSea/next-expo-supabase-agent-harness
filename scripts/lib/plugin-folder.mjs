// The installable plugin folder (#163): what plugin/ must hold, and how far the tree on disk
// is from it. One home for the rule, read by the generator (scripts/generate-plugin-folder.mjs)
// and the drift check in scripts/check-plugin-manifest.mjs, so the two can never disagree on
// which files are generated or what they hold.
//
// The marketplace entry points at plugin/, and Claude Code installs exactly that folder. It
// used to point at the repository root, so an install copied every tracked file to deliver
// the thirty component files, and the plugin directory's automated checks hold for a
// reviewer any folder with more than 512 files or a non-image file over 256 KiB.
//
// Generated: agents/, commands/ and skills/, copied from template/base/.claude/, and LICENSE,
// a byte copy of the root LICENSE. All are regular files, because the plugin directory
// rejects a symbolic link for anything a plugin loads. A command or skill is copied with two
// changes (pluginCopy), both to what it runs; every other file is a byte copy. Its source
// runs the slice scaffolder as `node .claude/skills/...`, a path only an installed project
// has, so the copy names the plugin's own file from ${CLAUDE_PLUGIN_ROOT}, which Claude Code
// replaces with the plugin's folder in the text and in allowed-tools. And the copy's
// allowed-tools keep a Bash rule only for a command its own `!` lines and blocks run, or for
// that script. The source's other rules pre-approve a project's own commands (pnpm scripts,
// node tools/*.mjs, the supabase CLI), which run that project's code: an installed project
// vouches for them, a plugin cannot. Kept by hand: the manifest (.claude-plugin/plugin.json,
// whose version the release bump sets), its icon and README.md. Anything else under plugin/
// is drift.
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { walkFiles } from '../../installer/lib/fs-walk.mjs'

export const PLUGIN_DIR = 'plugin'
const COMPONENT_SOURCE = 'template/base/.claude'
const COMPONENTS = ['agents', 'commands', 'skills']
const HAND_EDITED = ['.claude-plugin/plugin.json', '.claude-plugin/icon.png', 'README.md']

// The plugin directory's pre-submission limits ("Files in the plugin folder").
const MAX_FILES = 512
const MAX_FILE_BYTES = 256 * 1024
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|svg)$/i

// The plugin's icon: a square PNG of 512 to 2048 pixels a side, under 2 MB.
const ICON_SIDE = { min: 512, max: 2048 }
const ICON_MAX_BYTES = 2_000_000
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Why an image cannot be the plugin's icon, or null when it can.
 * @param {Buffer} bytes
 * @returns {string | null}
 */
export function iconProblem(bytes) {
  if (bytes.length >= ICON_MAX_BYTES) return `is ${String(bytes.length)} bytes; an icon must be under 2 MB`
  const complete =
    bytes.length > 32 &&
    bytes.subarray(0, 8).equals(PNG_SIGNATURE) &&
    bytes.toString('latin1', 12, 16) === 'IHDR' &&
    bytes.toString('latin1', bytes.length - 8, bytes.length - 4) === 'IEND'
  if (!complete) return 'is not a complete PNG'
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (width !== height || width < ICON_SIDE.min || width > ICON_SIDE.max) {
    return `is ${String(width)} x ${String(height)} pixels; an icon must be square, 512 to 2048 pixels a side`
  }
  return null
}

const PROMPT_FILE = /^(?:commands|skills)\/.*\.md$/
const PROJECT_SCRIPT = 'node .claude/skills/'
export const PLUGIN_SCRIPT = 'node ${CLAUDE_PLUGIN_ROOT}/skills/'

/**
 * A tool list split as Claude Code 2.1.292 splits allowed-tools: at each comma or space
 * outside parentheses. The first `)` closes a rule's parentheses; they do not nest.
 * @param {string} list
 * @returns {string[]}
 */
export function toolEntries(list) {
  const out = ['']
  let inRule = false
  for (const ch of list) {
    if (!inRule && (ch === ',' || ch === ' ')) {
      out.push('')
      continue
    }
    if (ch === '(') inRule = true
    if (ch === ')') inRule = false
    out[out.length - 1] += ch
  }
  return out.map((entry) => entry.trim()).filter((entry) => entry !== '')
}

/**
 * An allowed-tools value's entries as Claude Code 2.1.292 reads them, or null when the value
 * is not a plain or wholly quoted list. Claude Code parses the frontmatter as YAML, which
 * reads a flow list, an anchor, alias or tag, a block scalar, a comment or a double-quoted
 * escape otherwise than its text. A plain list holds no comment, and it and each entry start
 * with a letter, as a tool name does, so the part of it a plugin copy keeps is plain too. A
 * quoted list holds no quote or backslash.
 * @param {string} value the text after `allowed-tools:`
 * @returns {string[] | null}
 */
export function allowedTools(value) {
  const text = value.trim()
  const quoted = /^"([^"\\]*)"$|^'([^']*)'$/.exec(text)
  const entries = toolEntries(quoted === null ? text : (quoted[1] ?? quoted[2] ?? ''))
  const plain = quoted !== null || (/^(?:[A-Za-z]|$)/.test(text) && !/\s#/.test(text))
  return plain && entries.every((entry) => /^[A-Za-z]/.test(entry)) ? entries : null
}

// The tools that run a shell command or code, or write a file, read in Claude Code 2.1.292.
// Bash's permission check also judges Monitor's commands, and PowerShell has its own.
// AppifactRepl runs JavaScript in a process it starts, under Bash's deny and ask rules. Edit,
// Write and NotebookEdit are judged by the file-write check, which reads only Edit's path
// rules; MultiEdit is an older Claude Code's. A bare entry pre-approves every call of one.
export const SHELL_AND_WRITE_TOOLS = ['Bash', 'Monitor', 'PowerShell', 'AppifactRepl', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit']

/**
 * The tool an allowed-tools entry pre-approves every call of, or null. Claude Code 2.1.292's
 * rule parser reads `Tool()` and `Tool(*)` as the bare `Tool`.
 * @param {string} entry
 * @returns {string | null}
 */
export function wholeToolGrant(entry) {
  const tool = entry.replace(/^([^()]+)\(\*?\)$/, '$1')
  return SHELL_AND_WRITE_TOOLS.includes(tool) ? tool : null
}

/**
 * Whether a rule of one of SHELL_AND_WRITE_TOOLS pre-approves more than one command or path.
 * Claude Code reads `*` as any text in a shell rule and as a glob in a path rule, so `**`,
 * `//**` and ` * ` cover them all; a closing `:*` is a prefix rule, which on one word
 * (`pnpm:*`) covers every command that word starts.
 * @param {string} entry
 * @returns {boolean}
 */
export function wideRule(entry) {
  const rule = /^([^()]+)\((.*)\)$/.exec(entry)
  if (rule === null || !SHELL_AND_WRITE_TOOLS.includes(String(rule[1]))) return false
  const content = String(rule[2])
  const prefix = content.endsWith(':*') ? content.slice(0, -2) : content
  return prefix.includes('*') || (prefix !== content && !prefix.includes(' '))
}

/**
 * The commands a command or skill runs as it loads, matched as Claude Code 2.1.292 matches
 * them: the body of a fenced block opened with three backticks and `!`, and an inline `!`
 * code span at a line start or after whitespace.
 * @param {string} text
 * @returns {string[]}
 */
export function inlineCommands(text) {
  const fenced = text.matchAll(/```!\s*\n?([\s\S]*?)\n?```/g)
  const inline = text.matchAll(/(?<=^|\s)!`([^`]+)`/gm)
  return [...fenced, ...inline].map((m) => String(m[1]).trim()).filter((command) => command !== '')
}

/**
 * The bytes plugin/<rel> holds, for the source bytes it is generated from.
 * @param {string} rel path inside plugin/
 * @param {Buffer} source
 * @returns {Buffer}
 */
export function pluginCopy(rel, source) {
  if (!PROMPT_FILE.test(rel)) return source
  const text = source.toString('utf8').replaceAll(PROJECT_SCRIPT, PLUGIN_SCRIPT)
  const end = text.startsWith('---\n') ? text.indexOf('\n---\n', 3) : -1
  if (end === -1) return Buffer.from(text, 'utf8')
  const ownCommands = new Set(inlineCommands(text))
  /** @param {string} entry */
  const keep = (entry) => {
    const bash = /^Bash(?:\((.*)\))?$/.exec(entry)
    if (bash === null) return true
    const command = bash[1] ?? ''
    return ownCommands.has(command) || command.startsWith(PLUGIN_SCRIPT)
  }
  // A value in another form is left as it is: check-plugin-manifest reds its source.
  const head = text.slice(0, end).replace(/^allowed-tools:(.*)$/m, (line, /** @type {string} */ value) => {
    const entries = allowedTools(value)
    if (entries === null) return line
    const quote = /^\s*(["']?)/.exec(value)?.[1] ?? ''
    return `allowed-tools: ${quote}${entries.filter(keep).join(', ')}${quote}`
  })
  return Buffer.from(head + text.slice(end), 'utf8')
}

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
 * Whether a generated copy is missing, differs from the bytes it must hold, or is a link.
 * @param {string} dest
 * @param {Buffer} want
 */
function copyIsStale(dest, want) {
  let copy
  try {
    copy = readFileSync(dest)
  } catch {
    return true
  }
  return !copy.equals(want) || lstatSync(dest).isSymbolicLink()
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
  // Read first, then lstat: no existence check runs before a read of the same path.
  for (const [rel, src] of want) {
    const source = readFileSync(join(root, src))
    if (lstatSync(join(root, src)).isSymbolicLink()) {
      problems.push(`${src} is a symbolic link: the plugin directory rejects links, so the source must be a regular file`)
      continue
    }
    if (copyIsStale(join(pluginAbs, rel), pluginCopy(rel, source))) stale.push(rel)
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
