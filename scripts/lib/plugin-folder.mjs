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
// rejects a symbolic link for anything a plugin loads. Its rules also accept only the file
// types typeProblem allows, commands and skills that pre-approve only reading and searching,
// and frontmatter keys it knows. So a source of another type, the slice scaffolder, is not
// copied, and a component's copy (pluginCopy) keeps only the keys COPY_KEYS lists, only
// READ_ONLY_TOOLS in a command's or skill's allowed-tools, and no MCP entry in an agent's
// tools; every other file is a byte copy. What a copy drops belongs to an installed project:
// the commands, scripts and MCP servers it vouches for, as a plugin cannot, and its
// reviewer-verdict tooling's harnessFallbackModels. Kept by hand: the manifest
// (.claude-plugin/plugin.json, whose version the release bump sets), its icon and README.md.
// Anything else under plugin/ is drift.
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

// The files the plugin directory accepts: PNG, JPEG, GIF, WebP and ICO images, which the
// size limit exempts; Markdown, text, JSON and YAML; and a license, a readme or .gitignore by
// name. No package manager configuration, whatever its type.
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|ico)$/i
const TEXT_TYPE = /\.(?:md|txt|json|ya?ml)$|^(?:LICENSE|README|\.gitignore)$/i
const PACKAGE_MANAGER_FILE =
  /^(?:package\.json|npm-shrinkwrap\.json|\.npmrc|\.yarnrc(?:\.yml)?|pnpm-workspace\.yaml|bunfig\.toml|deno\.jsonc?|uv\.toml|pyproject\.toml|requirements\.txt)$|(?:^|[.-])lockb?(?:\.json|\.ya?ml)?$/i

/**
 * Why the plugin directory refuses a file for its name or its first bytes, or null.
 * @param {string} rel
 * @param {Buffer} bytes
 * @returns {string | null}
 */
function typeProblem(rel, bytes) {
  const name = rel.slice(rel.lastIndexOf('/') + 1)
  if (PACKAGE_MANAGER_FILE.test(name)) return 'is a package manager configuration file'
  if (!TEXT_TYPE.test(name) && !IMAGE_EXT.test(name)) return 'is not Markdown, text, JSON, YAML or a PNG, JPEG, GIF, WebP or ICO image'
  return bytes.subarray(0, 2).toString('latin1') === '#!' ? 'starts with `#!`' : null
}

/**
 * Why the plugin directory refuses a file of plugin/, or null: its type or first bytes, or,
 * in a text file, a NUL byte or bytes that are not UTF-8.
 * @param {string} rel
 * @param {Buffer} bytes
 * @returns {string | null}
 */
export function fileProblem(rel, bytes) {
  const problem = typeProblem(rel, bytes)
  if (problem !== null || IMAGE_EXT.test(rel)) return problem
  if (bytes.includes(0)) return 'holds a NUL byte'
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return null
  } catch {
    return 'is not valid UTF-8'
  }
}

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

// The frontmatter keys a component's copy keeps: keys Claude Code reads. The plugin directory
// publishes no list of the keys it accepts. harnessFallbackModels is the installed project's
// reviewer-verdict tooling's (template/base/tools/lib/agent-roster.mjs), not Claude Code's.
export const COPY_KEYS = {
  agents: ['name', 'description', 'tools', 'disallowedTools', 'model'],
  commands: ['description', 'argument-hint', 'allowed-tools', 'model'],
  skills: ['name', 'description', 'argument-hint', 'allowed-tools'],
}

/**
 * Which kind of component plugin/<rel> is, or null. `.md` counts in any case: Claude Code's
 * plugin loader takes a .MD command, and a case-insensitive disk opens SKILL.MD or skill.md
 * as SKILL.md.
 * @param {string} rel
 * @returns {'agents' | 'commands' | 'skills' | null}
 */
export function componentKind(rel) {
  if (/^skills\/[^/]+\/SKILL\.md$/i.test(rel)) return 'skills'
  if (/^agents\/.+\.md$/i.test(rel)) return 'agents'
  return /^commands\/.+\.md$/i.test(rel) ? 'commands' : null
}

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

// What the plugin directory lets a command or skill pre-approve: reading and searching files.
export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'LS']

/**
 * Whether an allowed-tools entry is one of READ_ONLY_TOOLS, bare or with a path that holds no
 * `${...}`, does not start with `//` or `\\`, and is not a URL, as the plugin directory asks.
 * @param {string} entry
 * @returns {boolean}
 */
export function readOnlyGrant(entry) {
  const rule = /^([^()]+)(?:\((.*)\))?$/.exec(entry)
  return rule !== null && READ_ONLY_TOOLS.includes(String(rule[1])) && !/\$\{|^(?:\/\/|\\\\)|:\/\//.test(rule[2] ?? '')
}

// The tools whose grant pre-approves running a shell command or code, or writing a file, read
// in Claude Code 2.1.292. Bash's permission check also judges Monitor's commands, and
// PowerShell has its own. AppifactRepl runs JavaScript in a process it starts, under Bash's
// deny and ask rules. Edit, Write and NotebookEdit are judged by the file-write check, which
// reads only Edit's path rules; MultiEdit is an older Claude Code's. A bare entry pre-approves
// every call of one.
export const SHELL_AND_WRITE_TOOLS = ['Bash', 'Monitor', 'PowerShell', 'AppifactRepl', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit']

/**
 * The tool of SHELL_AND_WRITE_TOOLS an allowed-tools entry pre-approves every call of, or
 * null. Claude Code 2.1.292's rule parser reads `Tool()` and `Tool(*)` as the bare `Tool`.
 * @param {string} entry
 * @returns {string | null}
 */
export function wholeToolGrant(entry) {
  const tool = entry.replace(/^([^()]+)\(\*?\)$/, '$1')
  return SHELL_AND_WRITE_TOOLS.includes(tool) ? tool : null
}

/**
 * Whether a rule of one of SHELL_AND_WRITE_TOOLS has a `*` other than a closing `:*`, or is
 * a prefix rule on one word. Claude Code reads `*` as any text in a shell rule and as a glob
 * in a path rule, so `**`, `//**` and ` * ` cover them all; a closing `:*` is a prefix rule,
 * which on one word (`pnpm:*`) covers every command that word starts. A prefix of two words
 * or more passes, whatever it runs (`node -e:*`), and so does a path rule without a `*`,
 * which covers everything under a folder it names.
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
 * The inline shell in a command or skill, as Claude Code 2.1.292 finds it: a fenced block
 * opened with three backticks and `!`, and an inline `!` code span at a line start or after
 * white space. Claude Code first blanks the other inline code spans, and this does not, so it
 * may also find a span Claude Code skips. Each is the line it starts on and its opening text,
 * on one line.
 * @param {string} text
 * @returns {Array<{ line: number, shell: string }>}
 */
export function inlineShell(text) {
  return [...text.matchAll(/```!.*|(?<=^|\s)!`[^`]+`/gm)].map((m) => ({
    line: text.slice(0, m.index).split('\n').length,
    shell: m[0].replace(/\s+/g, ' '),
  }))
}

/**
 * A frontmatter's top-level entries: each `key:` line at column 0 with the blank and indented
 * lines after it, which hold a block scalar's text. A comment line, or a blank line before the
 * first key, belongs to none. Null when a line is none of these.
 * @param {string} head the frontmatter's lines, each ending in a newline
 * @returns {Array<{ key: string, text: string }> | null}
 */
function frontmatterEntries(head) {
  /** @type {Array<{ key: string, text: string }>} */
  const entries = []
  for (const line of head.split(/(?<=\n)/).filter((l) => l !== '')) {
    const key = /^([A-Za-z][\w-]*):/.exec(line)?.[1]
    const last = entries.at(-1)
    if (key !== undefined) entries.push({ key, text: line })
    else if (/^(?:[ \t]|\n$)/.test(line) && last !== undefined) last.text += line
    else if (line !== '\n' && !line.startsWith('#')) return null
  }
  return entries
}

/**
 * One entry of a component's copy. An agent's tools loses its MCP entries, and a command's or
 * skill's allowed-tools keeps only READ_ONLY_TOOLS, or goes when none is left. The list is its
 * key's line, and the blank and indented comment lines after it, which YAML reads as nothing,
 * stay with it. A list the copy cannot read, or an agent's that the drop would empty, stays as
 * it is, and check-plugin-manifest reds it. Every other entry is copied as it is.
 * @param {'agents' | 'commands' | 'skills'} kind
 * @param {{ key: string, text: string }} entry
 * @returns {string}
 */
function copyEntry(kind, { key, text }) {
  const agent = kind === 'agents'
  const list = key === (agent ? 'tools' : 'allowed-tools') ? /^[^:]*:(.*)\n((?:[ \t]*(?:#.*)?\n)*)$/.exec(text) : null
  const value = list?.[1] ?? ''
  const entries = list === null ? null : allowedTools(value)
  if (entries === null) return text
  const kept = entries.filter((entry) => (agent ? !/^mcp__/i.test(entry) : readOnlyGrant(entry)))
  if (kept.length === entries.length || (agent && kept.length === 0)) return text
  if (kept.length === 0) return ''
  const quote = /^\s*(["']?)/.exec(value)?.[1] ?? ''
  return `${key}: ${quote}${kept.join(', ')}${quote}\n${list?.[2] ?? ''}`
}

/**
 * The bytes plugin/<rel> holds, for the source bytes it is generated from.
 * @param {string} rel path inside plugin/
 * @param {Buffer} source
 * @returns {Buffer}
 */
export function pluginCopy(rel, source) {
  const kind = componentKind(rel)
  const text = source.toString('utf8')
  const end = kind !== null && text.startsWith('---\n') ? text.indexOf('\n---\n', 3) : -1
  const entries = end === -1 ? null : frontmatterEntries(text.slice(4, end + 1))
  // A frontmatter in another form is copied as it is: check-plugin-manifest reds it.
  if (kind === null || entries === null) return source
  const head = entries.filter((entry) => COPY_KEYS[kind].includes(entry.key)).map((entry) => copyEntry(kind, entry))
  return Buffer.from(`---\n${head.join('')}${text.slice(end + 1)}`, 'utf8')
}

/**
 * Every generated file of plugin/, keyed by its POSIX path inside plugin/, with the
 * repository path it is copied from: each component file of a type the plugin directory
 * accepts (typeProblem), and LICENSE.
 * @param {string} root
 * @returns {Map<string, string>}
 */
export function generatedFiles(root) {
  const out = new Map()
  for (const sub of COMPONENTS) {
    for (const rel of walkFiles(join(root, COMPONENT_SOURCE, sub))) {
      const src = `${COMPONENT_SOURCE}/${sub}/${rel}`
      if (typeProblem(rel, readFileSync(join(root, src))) === null) out.set(`${sub}/${rel}`, src)
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
