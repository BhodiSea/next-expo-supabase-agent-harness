// Pure helpers for scripts/generate-skill-references.mjs (1.1.0, N09): the marker grammar,
// the pairing of begin/end markers into regions, the closures over region ids, and the
// rendering of a source span into the fenced block a reference carries. No file IO here:
// the script walks and reads the tree and hands this module text plus a resolver, so every
// rule below is a function of its arguments.
//
// THE GRAMMAR. In the example's source, a comment line in the file's own comment syntax:
//   // skill-region:begin <id>     and  // skill-region:end <id>     (TypeScript)
//   -- skill-region:begin <id>     and  -- skill-region:end <id>     (SQL)
// In a reference, an HTML comment on each side of the fenced block it owns:
//   <!-- skill-region:begin <id> source=<install-relative path> -->
//   ```<lang>
//   …the span, verbatim…
//   ```
//   <!-- skill-region:end <id> -->
// Either marker may be indented (a region inside a markdown list item keeps the fence's
// indent), and the rendered block takes the begin marker's indent. Regions do not nest.
//
// A line that LOOKS like a marker (it opens with a comment token and mentions
// `skill-region:`) and does not parse is an error, never prose: a typo in a marker must not
// quietly turn a region into ordinary text the check stops reading.
import { tokensIn } from '../../installer/lib/placeholders.mjs'

const ID = '[a-z][a-z0-9-]*'
const REFERENCE_MARKER = new RegExp(`^( *)<!-- skill-region:(begin|end) (${ID})(?: source=(\\S+))? -->$`)
const SOURCE_MARKER = new RegExp(`^( *)(//|--) skill-region:(begin|end) (${ID})$`)
const MENTION = 'skill-region:'

// The source languages a region may be cut from: the comment token its markers must use, and
// the info string of the fence the span renders into.
const SOURCE_LANGS = new Map([
  ['.ts', { comment: '//', fence: 'ts' }],
  ['.tsx', { comment: '//', fence: 'tsx' }],
  ['.sql', { comment: '--', fence: 'sql' }],
])

/**
 * The language of a source file, or undefined for a file the generator does not cut from.
 * @param {string} file
 * @returns {{ comment: string, fence: string } | undefined}
 */
export function sourceLang(file) {
  const dot = file.lastIndexOf('.')
  return dot === -1 ? undefined : SOURCE_LANGS.get(file.slice(dot))
}

/**
 * @typedef {{ kind: 'begin' | 'end', id: string, source?: string, indent: string, at: number }} Marker
 * @typedef {{ id: string, file: string, source?: string, indent: string, begin: number, end: number }} Region
 * @typedef {{ file: string, text: string }} Input
 */

// CRLF to LF, then split: a Windows checkout compares equal. A trailing newline yields a
// final '' that joins back losslessly.
const toLines = (text) => text.replace(/\r\n/g, '\n').split('\n')

const where = (file, at) => `${file}:${String(at + 1)}`

// source= is an INSTALL-relative POSIX path: no absolute path, no drive, no backslash, no
// empty, '.' or '..' segment. The banner is what an install's reader sees, and the resolver
// must never leave the template trees.
const installPathOk = (p) =>
  !p.includes('\\') && !/^[A-Za-z]:/.test(p) && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')

/**
 * One reference line: a marker, a problem string (a malformed marker), or null.
 * @param {string} line @param {number} at @param {string} file
 * @returns {Marker | string | null}
 */
function referenceMarker(line, at, file) {
  if (!line.trimStart().startsWith('<!--') || !line.includes(MENTION)) return null
  const m = REFERENCE_MARKER.exec(line)
  if (m === null) {
    return `${where(file, at)}: malformed marker ${JSON.stringify(line.trim())} — the shape is <!-- skill-region:begin <id> source=<install-relative path> --> or <!-- skill-region:end <id> -->`
  }
  const [, indent, kind, id, source] = m
  if (kind === 'begin' && (source === undefined || !installPathOk(source))) {
    return `${where(file, at)}: malformed marker — begin '${id}' must name source=<install-relative POSIX path>`
  }
  if (kind === 'end' && source !== undefined) {
    return `${where(file, at)}: malformed marker — end '${id}' carries a source=, which belongs on its begin`
  }
  return { kind: kind === 'begin' ? 'begin' : 'end', id, source, indent, at }
}

/**
 * One source line, in the file's own comment syntax: a marker, a problem string, or null.
 * @param {string} line @param {number} at @param {string} file @param {string} comment
 * @returns {Marker | string | null}
 */
function sourceMarker(line, at, file, comment) {
  const head = line.trimStart()
  if (!(head.startsWith('//') || head.startsWith('--')) || !line.includes(MENTION)) return null
  const m = SOURCE_MARKER.exec(line)
  if (m === null) {
    return `${where(file, at)}: malformed marker ${JSON.stringify(line.trim())} — the shape is \`${comment} skill-region:begin <id>\` or \`${comment} skill-region:end <id>\``
  }
  const [, indent, token, kind, id] = m
  if (token !== comment) {
    return `${where(file, at)}: malformed marker — '${id}' uses \`${token}\` in a file whose comments are \`${comment}\``
  }
  return { kind: kind === 'begin' ? 'begin' : 'end', id, indent, at }
}

/**
 * Pair begin/end markers into regions. Regions do not nest, an end must close the region
 * that is open, and every begin is closed before the file ends.
 * @param {Marker[]} markers @param {string} file
 * @returns {{ regions: Region[], problems: string[] }}
 */
function pairMarkers(markers, file) {
  const regions = []
  const problems = []
  let open = null
  for (const mk of markers) {
    if (mk.kind === 'begin' && open !== null) {
      problems.push(
        `${where(file, mk.at)}: unbalanced markers — begin '${mk.id}' opens while '${open.id}' (line ${String(open.at + 1)}) is still open; regions do not nest`,
      )
    } else if (mk.kind === 'begin') {
      open = mk
    } else if (open?.id === mk.id) {
      regions.push({ id: open.id, file, source: open.source, indent: open.indent, begin: open.at, end: mk.at })
      open = null
    } else {
      const state = open === null ? 'no region is open' : `the open region is '${open.id}' (line ${String(open.at + 1)})`
      problems.push(`${where(file, mk.at)}: unbalanced markers — end '${mk.id}' closes nothing: ${state}`)
    }
  }
  if (open !== null) problems.push(`${where(file, open.at)}: unbalanced markers — begin '${open.id}' is never closed`)
  return { regions, problems }
}

/**
 * Parse every file of one side into its regions, keeping each file's lines for later.
 * @param {Input[]} inputs @param {'reference' | 'source'} kind @param {string[]} problems
 * @returns {{ regions: Region[], lines: Map<string, string[]> }}
 */
function collect(inputs, kind, problems) {
  const regions = []
  const lines = new Map()
  for (const { file, text } of inputs) {
    const ls = toLines(text)
    const comment = sourceLang(file)?.comment ?? '//'
    const markers = []
    ls.forEach((line, at) => {
      const mk = kind === 'reference' ? referenceMarker(line, at, file) : sourceMarker(line, at, file, comment)
      if (typeof mk === 'string') problems.push(mk)
      else if (mk !== null) markers.push(mk)
    })
    if (markers.length === 0) continue
    const paired = pairMarkers(markers, file)
    problems.push(...paired.problems)
    regions.push(...paired.regions)
    lines.set(file, ls)
  }
  return { regions, lines }
}

const body = (lines, r) => lines.get(r.file).slice(r.begin + 1, r.end)

/**
 * One side's id closure: every id registered, none defined twice.
 * @param {string} side @param {Region[]} regions @param {Set<string>} known
 * @returns {string[]}
 */
function judgeSide(side, regions, known) {
  const problems = []
  const seen = new Map()
  for (const r of regions) {
    if (!known.has(r.id)) {
      problems.push(
        `${where(r.file, r.begin)}: unknown region id '${r.id}' — the registered ids are ${[...known].map((k) => `'${k}'`).join(', ')}. A new region is added to REGION_IDS in scripts/generate-skill-references.mjs in the change that adds its markers.`,
      )
    }
    if (seen.has(r.id)) problems.push(`${where(r.file, r.begin)}: duplicate ${side} region '${r.id}' — already defined at ${seen.get(r.id)}`)
    else seen.set(r.id, where(r.file, r.begin))
  }
  return problems
}

/**
 * The id closures: every id is registered, no id is defined twice on one side, every
 * registered id has a region somewhere, and the check never passes on zero regions.
 * @param {Region[]} sources @param {Region[]} references @param {readonly string[]} knownIds
 * @returns {string[]}
 */
function judgeIds(sources, references, knownIds) {
  const known = new Set(knownIds)
  const problems = []
  if (sources.length === 0 || references.length === 0) {
    problems.push(
      `zero regions — ${String(sources.length)} in the example's source, ${String(references.length)} in the references. A regen-diff over nothing passes vacuously, so this check refuses to.`,
    )
  }
  problems.push(...judgeSide('source', sources, known), ...judgeSide('reference', references, known))
  const marked = new Set([...sources, ...references].map((r) => r.id))
  for (const id of known) {
    if (!marked.has(id)) {
      problems.push(
        `registered region '${id}' appears in neither the example's source nor any reference — mark it on both sides, or drop it from REGION_IDS in the change that removes its markers`,
      )
    }
  }
  return problems
}

/**
 * What a source span must not be: empty, or carrying an installer placeholder. The installer
 * renders `{{TOKEN}}` at init, so a span with one would teach text no install compiles.
 * @param {string[]} span @param {Region} r
 * @returns {string[]}
 */
function judgeSpan(span, r) {
  const problems = []
  if (span.every((l) => l.trim() === '')) problems.push(`${where(r.file, r.begin)}: region '${r.id}' spans no code`)
  const tokens = [...tokensIn(span.join('\n'))].sort()
  if (tokens.length > 0) {
    problems.push(
      `${where(r.file, r.begin)}: region '${r.id}' carries installer placeholder ${tokens.map((t) => `{{${t}}}`).join(', ')} inside its span — the reference would show a token the installer rewrites, not the code that compiles`,
    )
  }
  return problems
}

/**
 * Pair each reference region with the source region it renders, both directions. A reference
 * region whose source= resolves to nothing, or whose source carries no region of that id, is
 * an orphan on the reference side; a source region no reference renders is one on the source
 * side.
 * @param {Region[]} sources @param {Region[]} references
 * @param {(installRel: string) => string | null} resolveSource
 * @param {string[]} problems
 * @returns {{ ref: Region, src: Region }[]}
 */
function pairRegions(sources, references, resolveSource, problems) {
  const pairs = []
  for (const ref of references) {
    const key = resolveSource(ref.source)
    const src = key === null ? undefined : sources.find((s) => s.id === ref.id && s.file === key)
    if (key === null) {
      problems.push(
        `${where(ref.file, ref.begin)}: region '${ref.id}' names source=${ref.source}, which resolves to no file under template/demo, template/stack or template/base`,
      )
    } else if (src === undefined) {
      problems.push(
        `${where(ref.file, ref.begin)}: orphan region '${ref.id}' — ${key} carries no '${ref.id}' region, so this block renders from nothing`,
      )
    } else {
      pairs.push({ ref, src })
    }
  }
  for (const src of sources) {
    if (!pairs.some((p) => p.src === src)) {
      problems.push(
        `${where(src.file, src.begin)}: orphan region '${src.id}' — no reference renders it. Add <!-- skill-region:begin ${src.id} source=<install-relative path> --> and its end around a fenced block in the reference that teaches it, or drop these markers.`,
      )
    }
  }
  return pairs
}

/**
 * The fenced block a span renders into: the span dedented by its common leading spaces, then
 * re-indented to the reference marker's indent. Blank lines stay empty. Nothing is
 * substituted, so what renders is the code that compiles upstream.
 * @param {string[]} span @param {string} indent @param {string} fence
 */
function renderBlock(span, indent, fence) {
  const widths = span.filter((l) => l.trim() !== '').map((l) => /^ */.exec(l)[0].length)
  const cut = widths.length === 0 ? 0 : Math.min(...widths)
  const lines = span.map((l) => (l.trim() === '' ? '' : `${indent}${l.slice(cut)}`))
  return [`${indent}\`\`\`${fence}`, ...lines, `${indent}\`\`\``]
}

/** @param {string[]} a @param {string[]} b */
function firstDifference(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) if (a[i] !== b[i]) return i
  return -1
}

/**
 * A reference's lines with every drifted region's body replaced by its rendering.
 * @param {string[]} lines @param {{ ref: Region, block: string[] }[]} renders
 */
function rewrite(lines, renders) {
  const out = []
  let next = 0
  for (const { ref, block } of [...renders].sort((a, b) => a.ref.begin - b.ref.begin)) {
    out.push(...lines.slice(next, ref.begin + 1), ...block)
    next = ref.end
  }
  out.push(...lines.slice(next))
  return out.join('\n')
}

/**
 * The whole plan: every problem that makes the tree unjudgeable, every region whose block
 * differs from its span, and the LF text each drifted reference would be rewritten to.
 * Deterministic for a given input: problems follow the input order, which the script takes
 * from a sorted walk.
 * @param {{ sources: Input[], references: Input[], resolveSource: (installRel: string) => string | null, knownIds: readonly string[] }} input
 */
export function planRegions({ sources, references, resolveSource, knownIds }) {
  const problems = []
  const src = collect(sources, 'source', problems)
  const ref = collect(references, 'reference', problems)
  problems.push(...judgeIds(src.regions, ref.regions, knownIds))
  for (const r of src.regions) problems.push(...judgeSpan(body(src.lines, r), r))
  const pairs = pairRegions(src.regions, ref.regions, resolveSource, problems)
  const drift = []
  const renders = new Map()
  for (const { ref: r, src: s } of pairs) {
    const block = renderBlock(body(src.lines, s), r.indent, sourceLang(s.file)?.fence ?? '')
    const at = firstDifference(body(ref.lines, r), block)
    if (at === -1) continue
    drift.push({ file: r.file, id: r.id, source: r.source, line: r.begin + 2 + at })
    renders.set(r.file, [...(renders.get(r.file) ?? []), { ref: r, block }])
  }
  const rewrites = [...renders].map(([file, list]) => ({ file, text: rewrite(ref.lines.get(file), list) }))
  return { problems, drift, rewrites, regions: pairs.length, referenceFiles: new Set(pairs.map((p) => p.ref.file)).size }
}
