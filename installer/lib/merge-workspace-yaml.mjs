// Retrofit merge for pnpm-workspace.yaml — the one root config that is merged
// rather than suffixed, because the gates require our workspace globs and
// catalog pins to be ACTIVE (a .harness.yaml sibling would be inert).
// Semantics: the project's file is the base and is preserved byte-for-byte
// where possible; our `packages` globs are unioned in; our `catalog` entries
// are added only when missing (never downgrade/override a project pin).
// The parser handles the constrained shape pnpm documents (top-level keys,
// list items, one-level maps). Anything exotic (anchors, nested maps deeper
// than catalog entries, flow style) → returns null and the caller falls back
// to the conflict-sibling path with a manual-merge note. Honest over clever.
export function mergeWorkspaceYaml(existingText, incomingText) {
  const existing = parseSimpleYaml(existingText)
  const incoming = parseSimpleYaml(incomingText)
  if (!existing || !incoming) return null

  /** @type {{ kind: string, name: string, existing?: string, tested?: string }[]} */
  const report = []
  let out = existingText.replace(/\s+$/, '')

  const havePackages = new Set(existing.lists.packages ?? [])
  const wantPackages = incoming.lists.packages ?? []
  const missingGlobs = wantPackages.filter((g) => !havePackages.has(g))
  if (missingGlobs.length > 0) {
    if (existing.lists.packages) {
      out = appendListItems(out, 'packages', missingGlobs)
    } else {
      out += `\npackages:\n${missingGlobs.map((g) => `  - '${g}'`).join('\n')}`
    }
    for (const g of missingGlobs) report.push({ kind: 'glob-added', name: g })
  }

  out = mergeCatalogSection(out, existing, incoming, report)

  return { merged: `${out}\n`, report }
}

// Catalog entries are added only when missing; a differing existing pin is
// reported (kept-yours), never overwritten.
function mergeCatalogSection(out, existing, incoming, report) {
  const haveCatalog = existing.maps.catalog ?? {}
  const wantCatalog = incoming.maps.catalog ?? {}
  const missingEntries = Object.entries(wantCatalog).filter(([k]) => !(k in haveCatalog))
  for (const [k, v] of Object.entries(wantCatalog)) {
    if (k in haveCatalog && haveCatalog[k] !== v) {
      report.push({ kind: 'catalog-mismatch', name: k, existing: haveCatalog[k], tested: v })
    }
  }
  if (missingEntries.length > 0) {
    const lines = missingEntries.map(([k, v]) => `  ${quoteKey(k)}: ${v}`)
    if (existing.maps.catalog) {
      out = appendMapItems(out, 'catalog', lines)
    } else {
      out += `\ncatalog:\n${lines.join('\n')}`
    }
    for (const [k] of missingEntries) report.push({ kind: 'catalog-added', name: k })
  }
  return out
}

function quoteKey(k) {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : `'${k}'`
}

// Insert new items at the end of an existing top-level section.
function insertAtSectionEnd(text, section, newLines) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l === `${section}:` || l.startsWith(`${section}:`))
  if (start === -1) return null
  let end = start + 1
  while (end < lines.length && (lines[end].startsWith('  ') || lines[end].trim() === '')) end++
  // trim trailing blanks inside the section
  let insertAt = end
  while (insertAt > start + 1 && lines[insertAt - 1].trim() === '') insertAt--
  lines.splice(insertAt, 0, ...newLines)
  return lines.join('\n')
}

function appendListItems(text, section, items) {
  return insertAtSectionEnd(text, section, items.map((g) => `  - '${g}'`)) ?? text
}

function appendMapItems(text, section, lines) {
  return insertAtSectionEnd(text, section, lines) ?? text
}

// Minimal parser for the documented pnpm-workspace.yaml shape. Returns
// { lists: {key: [...]}, maps: {key: {k: v}} } or null when it sees syntax
// it does not fully understand (the caller then refuses to merge).
// eslint-disable-next-line sonarjs/cognitive-complexity -- ceiling is machine-enforced by scripts/complexity-ratchet.json (G16); this directive only silences the rule, the ratchet is what stops the score growing
function parseSimpleYaml(text) {
  const lists = {}
  const maps = {}
  let section = null
  let kind = null
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trimEnd()
    if (line.trim() === '') continue
    // Anchors/aliases/flow style appear at VALUE positions (after `:` or `- `);
    // a bare `*` inside a quoted glob like 'apps/*' is fine.
    if (/(?::|^\s*-)\s+[&*{[]/.test(line)) return null // exotic YAML — refuse to merge
    const top = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (top) {
      section = top[1]
      kind = null
      if (top[2] !== '') {
        // scalar top-level key (e.g. shamefully-hoist: true) — ignore content
        section = null
      }
      continue
    }
    const item = line.match(/^ {2}- +['"]?([^'"]+)['"]?$/)
    if (item && section) {
      if (kind === 'map') return null
      kind = 'list'
      ;(lists[section] ??= []).push(item[1])
      continue
    }
    const entry = line.match(/^ {2}['"]?([@A-Za-z0-9/_.-]+)['"]?:\s*(.+)$/)
    if (entry && section) {
      if (kind === 'list') return null
      kind = 'map'
      ;(maps[section] ??= {})[entry[1]] = entry[2].trim()
      continue
    }
    if (/^ {4,}/.test(line)) return null // deeper nesting than we model
    return null // unrecognized construct
  }
  return { lists, maps }
}
