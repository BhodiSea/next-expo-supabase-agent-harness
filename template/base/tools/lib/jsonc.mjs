// tools/lib/jsonc.mjs — JSONC for TypeScript-flavored config files: tsconfig
// legally carries // and /* */ comments and trailing commas, which JSON.parse
// rejects. Strip them first. String-aware so a `//` inside a string value
// (e.g. a path) is preserved.
// eslint-disable-next-line sonarjs/cognitive-complexity -- ceiling is machine-enforced by scripts/complexity-ratchet.json (G16); this directive only silences the rule, the ratchet is what stops the score growing
export function parseJsonc(text) {
  let out = ''
  let inStr = false
  let strCh = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const next = text[i + 1]
    if (inStr) {
      out += c
      if (c === '\\') {
        out += next ?? ''
        i++
      } else if (c === strCh) inStr = false
      continue
    }
    if (c === '"' || c === "'") {
      inStr = true
      strCh = c
      out += c
      continue
    }
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
      continue
    }
    out += c
  }
  // drop trailing commas before } or ]
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}
