// tools/lib/toml.mjs — the smallest TOML reader that can judge supabase/config.toml.
//
// WHY NOT A DEPENDENCY. The installer's zero-runtime-dep ethic applies to gates: every gate in
// this tree runs on `node` and a checkout, with no install, so `pnpm validate` reds on a laptop
// with cold node_modules exactly as it does in CI. Node ships no TOML parser, and the alternative
// — a dependency the chain cannot run without — would make the first step of the chain an
// install. The harness already hand-parses SQL (check-tenancy), a TS array literal
// (check-route-manifest) and YAML job blocks (lib/live-controls) for the same reason.
//
// WHY A SUBSET IS HONEST HERE. It is not "TOML support"; it is a reader for the shape
// supabase/config.toml actually has — `[section]` / `[section.sub]` headers over scalar keys,
// with string arrays for the redirect allowlist. Anything outside that shape is REPORTED as
// unparseable rather than skipped, because a silently-ignored line is how a gate ends up judging
// a subset of its subject and reporting on all of it.
//
// It deliberately does NOT implement: inline tables, arrays of tables (`[[x]]`), multi-line
// basic strings, literal strings, dotted keys, datetimes, floats, or escapes beyond `\\` and
// `\"`. supabase/config.toml uses none of them, and the parse fails loudly if one appears.
// SOURCE: https://toml.io/en/v1.0.0 (the grammar this reads a strict subset of)

/** A `# comment` outside a string. Quotes are tracked so a `#` inside one survives. */
function stripComment(line) {
  let inStr = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"' && line[i - 1] !== '\\') inStr = !inStr
    else if (ch === '#' && !inStr) return line.slice(0, i)
  }
  return line
}

/**
 * One scalar TOML value.
 * @returns {{ value: unknown } | { error: string }}
 */
function parseScalar(raw) {
  const text = raw.trim()
  if (text === 'true') return { value: true }
  if (text === 'false') return { value: false }
  if (/^-?\d+$/.test(text)) return { value: Number.parseInt(text, 10) }
  if (/^"(?:[^"\\]|\\.)*"$/.test(text)) {
    return { value: text.slice(1, -1).replace(/\\(["\\])/g, '$1') }
  }
  return {
    error: `unsupported value ${JSON.stringify(text)} — this reader handles integers, booleans, basic strings and arrays of basic strings (see the header for what it deliberately does not)`,
  }
}

/**
 * Parse the supported TOML subset into a FLAT map: `"auth.email.enable_signup" -> false`.
 *
 * Flat because every consumer asks "what is the value at this dotted path", and a nested object
 * would make each of them walk. It also makes the reviewed policy file a flat key→value map,
 * which is the shape a reviewer can diff line by line.
 *
 * @param {string} text
 * @returns {{ values: Map<string, unknown>, sections: string[], errors: string[] }}
 */
/**
 * A complete `[ "a", "b" ]` body → its items.
 * @returns {{ value: unknown[] } | { error: string }}
 */
function parseArray(raw) {
  const items = raw
    .slice(1, -1)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map(parseScalar)
  const bad = items.find((p) => p.error !== undefined)
  return bad !== undefined ? { error: bad.error } : { value: items.map((p) => p.value) }
}

/**
 * ONE line that is not continuing an open array → what it means.
 *
 * Split out of parseToml because the combined function scored 33 against the bar of 15 this
 * harness enforces on every consumer; scripts/check-complexity-ratchet.mjs is what stops it
 * exempting itself. The seam is the real one: the loop owns STATE (the current section, an
 * open array), and this owns what a single line says.
 *
 * @returns {{ section?: string, key?: string, rhs?: string, error?: string, skip?: boolean }}
 */
function classifyLine(line) {
  if (line === '') return { skip: true }
  if (line.startsWith('[[')) {
    return {
      error: `array-of-tables (\`[[...]]\`) is not supported by this reader — supabase/config.toml does not use one, so its appearance means the file's shape changed and the gate must not guess`,
    }
  }
  const header = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line)
  if (header !== null) return { section: header[1] }
  const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line)
  if (kv === null) return { error: `cannot parse ${JSON.stringify(line.slice(0, 60))}` }
  return { key: kv[1], rhs: kv[2].trim() }
}

/** Record a parsed value, or its error, against `key`. */
function storeInto(values, errors, key, at, result) {
  if (result.error !== undefined) errors.push(`line ${String(at)}: ${key}: ${result.error}`)
  else values.set(key, result.value)
}

/**
 * ONE line, against a mutable parser STATE. Returns nothing; it mutates `st`.
 *
 * The loop body lives here rather than inline because parseToml scored 20 against the bar of
 * 15 with it inlined — twice, through two refactors that each looked flat. What actually
 * carries the branching is the interaction between "am I inside a multi-line array" and "what
 * kind of line is this", and separating those two questions is the decomposition that works.
 */
function consumeLine(st, line, at) {
  if (st.pendingKey !== null) {
    st.pendingRaw += line
    if (!line.endsWith(']')) return
    storeInto(st.values, st.errors, st.pendingKey, at, parseArray(st.pendingRaw))
    st.pendingKey = null
    st.pendingRaw = ''
    return
  }
  const kind = classifyLine(line)
  if (kind.skip === true) return
  if (kind.error !== undefined) {
    st.errors.push(`line ${String(at)}: ${kind.error}`)
    return
  }
  if (kind.section !== undefined) {
    st.section = kind.section
    st.sections.push(kind.section)
    return
  }
  const key = st.section === '' ? kind.key : `${st.section}.${kind.key}`
  if (kind.rhs.startsWith('[') && !kind.rhs.endsWith(']')) {
    st.pendingKey = key
    st.pendingRaw = kind.rhs
    return
  }
  const parsed = kind.rhs.startsWith('[') ? parseArray(kind.rhs) : parseScalar(kind.rhs)
  storeInto(st.values, st.errors, key, at, parsed)
}

export function parseToml(text) {
  // An array value may span lines (`additional_redirect_urls = [`). While one is open every
  // line is appended until the closing bracket, so `pendingKey`/`pendingRaw` are the parser's
  // only state beyond the current section.
  const st = {
    values: new Map(),
    sections: [],
    errors: [],
    section: '',
    pendingKey: null,
    pendingRaw: '',
  }
  for (const [i, rawLine] of text.split('\n').entries()) {
    consumeLine(st, stripComment(rawLine).trim(), i + 1)
  }
  if (st.pendingKey !== null) {
    st.errors.push(`unterminated array value for \`${st.pendingKey}\` — no closing \`]\``)
  }
  return { values: st.values, sections: st.sections, errors: st.errors }
}
