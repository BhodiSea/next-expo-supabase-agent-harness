#!/usr/bin/env node
// Gate: duplication (G17) — copy-paste rot cannot ship green. No machine check caught a
// block pasted across files, so the maintainability pillar's "deterministically
// world-class" claim was violable by the oldest smell there is. This is a zero-dep,
// deterministic token clone detector over apps/*/src + packages/*/src: it tokenizes each
// source (comments and whitespace stripped, string/number literals normalized so a paste
// that only swapped a constant still matches), slides a MIN_TOKENS window, and flags any
// run of ≥ MIN_TOKENS tokens that appears in two places. Exact-ish (type-1) matching, so
// a red is a genuine paste, not two functions that merely rhyme.
//
// NOT a floor step (the 21-gate floor is frozen): this runs as a Stop-chain step and a
// blocking CI lane. Ramped — on an install whose baseVersion predates the check it emits a
// NOTE instead of failing, so a consumer's pre-existing copy-paste never ambushes an
// `update`; in this lineage it ships in 0.1.0, so it is live from the first install.
// Reviewed accepted clones live in tools/duplication-allow.json (by content fingerprint,
// so an accepted clone stays accepted when it moves).
// SOURCE: docs/harness/README.md (skip-local / fail-closed-CI asymmetry) [corpus: harness/doctrine]
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { walkFiles } from './lib/fs-walk.mjs'
import { fail, failures, ok, rampNote, skipOrFail } from './lib/gate.mjs'

const GATE = 'duplication'
const ALLOW = 'tools/duplication-allow.json'

// A clone must be at least this many tokens AND span this many lines — high enough that
// two structurally-similar-but-independent blocks don't trip, low enough that a real
// pasted function (~15+ lines) is caught. Tuned against the DRY reference scaffold.
const MIN_TOKENS = 70
const MIN_LINES = 6

// Scan only hand-written product source. Generated bindings, tests (they legitimately
// repeat setup), and type decls are excluded.
const SCAN_ROOTS = []
for (const scope of ['apps', 'packages']) {
  if (!existsSync(scope)) continue
  for (const d of readdirSync(scope).sort()) {
    const src = join(scope, d, 'src')
    if (existsSync(src)) SCAN_ROOTS.push(src)
  }
}
if (SCAN_ROOTS.length === 0) {
  skipOrFail(GATE, 'no apps/*/src or packages/*/src to scan (no product source yet)')
}

// ---- reviewed exemptions ------------------------------------------------------------
const allow = new Set()
if (existsSync(ALLOW)) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(ALLOW, 'utf8'))
  } catch (e) {
    fail(
      GATE,
      `${ALLOW} is not valid JSON (${e.message}) — the exemption list must be reviewable data`,
    )
  }
  if (!Array.isArray(parsed.allow)) {
    fail(
      GATE,
      `${ALLOW} must carry an "allow" ARRAY of {"fingerprint": string, "reason": string} entries`,
    )
  }
  for (const entry of parsed.allow) {
    const okShape =
      entry !== null &&
      typeof entry === 'object' &&
      typeof entry.fingerprint === 'string' &&
      typeof entry.reason === 'string' &&
      entry.reason.trim() !== ''
    if (!okShape) {
      fail(
        GATE,
        `${ALLOW}: every entry must be {"fingerprint": string, "reason": non-empty string} — got ${JSON.stringify(entry)}`,
      )
    }
    allow.add(entry.fingerprint)
  }
}

// ---- tokenizer ----------------------------------------------------------------------
// One regex, one pass. Whitespace and comments are matched (and skipped); strings /
// template literals become a single normalized `"S"` token and numbers `"N"`, so a paste
// that changed only a literal still matches; every other identifier/keyword/operator/
// punctuation char is a literal token. Regex literals are not special-cased (rare in
// product source; at worst a `/` splits a would-be clone, never a false match).
const TOKEN_RE =
  /(\s+)|(\/\/[^\n]*)|(\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\d[\w.]*)|([A-Za-z_$][\w$]*|[^\s])/g

/** @returns {{ value: string, line: number }[]} */
function tokenize(text) {
  const tokens = []
  let line = 1
  for (const m of text.matchAll(TOKEN_RE)) {
    const [whole, ws, lineComment, blockComment, str, num, other] = m
    if (ws !== undefined || lineComment !== undefined) {
      line += (whole.match(/\n/g) ?? []).length
      continue
    }
    if (blockComment !== undefined || str !== undefined) {
      const startLine = line
      line += (whole.match(/\n/g) ?? []).length
      if (blockComment !== undefined) continue
      tokens.push({ value: 'S', line: startLine })
      continue
    }
    if (num !== undefined) {
      tokens.push({ value: 'N', line })
      continue
    }
    if (other !== undefined) tokens.push({ value: other, line })
  }
  return tokens
}

// ---- fingerprint + extend clone detection -------------------------------------------
const files = []
for (const root of SCAN_ROOTS) {
  for (const rel of walkFiles(root, {
    filter: (p) => /\.(ts|tsx)$/.test(p) && !/\.(test|spec)\.tsx?$/.test(p) && !/\.d\.ts$/.test(p),
  })) {
    const path = `${root}/${rel}`
    // Generated modules are machine-written; never a maintainability concern —
    // by construction they RESTATE their source, so scanning them reports the
    // generator's own output as a clone of its input. Two shapes are excluded:
    // a `*.gen.ts` suffix, and anything under a `generated/` directory, which is
    // where the design-tokens compiler writes (`src/generated/{native.ts,web.css}`).
    // The suffix rule alone matched NOTHING in the shipped scaffold, so this gate
    // reported native.ts duplicating typography.ts on a clean tree.
    if (/\.gen\.tsx?$/.test(path) || /(^|\/)generated\//.test(path)) continue
    files.push({ path, tokens: tokenize(readFileSync(path, 'utf8')) })
  }
}

const hashWindow = (tokens, start) => {
  let s = ''
  for (let k = 0; k < MIN_TOKENS; k += 1) s += `${tokens[start + k].value} `
  return createHash('sha1').update(s).digest('hex')
}

// A clone must be duplicated CODE, not a repeating DATA LITERAL — and the difference is not
// cosmetic, it is the difference between a true finding and a gate nobody can keep green.
//
// The tokenizer normalizes every string to `S` and every number to `N` (deliberately: a paste
// that swapped only a constant must still match). But that means a pure data table —
// `'nav.primary': 'Primary',` ninety-one times in a message catalog, a colour map, a lookup
// object — tokenizes to `S : S ,` repeating forever. EVERY window matches every other window,
// and the detector reports the table as duplicating itself. It did exactly that to the i18n
// catalog the moment it existed.
//
// Structure, not size, is what separates the two: real code names things. It has identifiers,
// keywords, operators. A data table has literals and punctuation and almost nothing else. So a
// run only counts as a clone if it contains enough DISTINCT non-literal tokens to be code.
// Eight is comfortably below any function worth extracting (`const`, a name, `=`, `(`, `)`,
// `{`, `return`, `}` is already eight) and far above any key/value table, which has two or
// three (`S`, `N`, `:`, `,`, and the braces).
// A NAME IS NOT STRUCTURE. Counting every non-literal token undercounts nothing but
// OVERCOUNTS the one case this heuristic exists to catch: a table whose values are
// member expressions rather than bare literals. `canvas: ramps.neutral[950],` repeated
// eight times is as much a data table as `'nav.primary': 'Primary',` repeated ninety —
// but it contributes `canvas`, `surface`, `edge`, `ink`, `ramps`, `.`, `neutral`, … and
// sails past the threshold. That is exactly how the shipped design-tokens palette
// (`color.ts` themes.dark / themes.light) reported itself as a clone on a clean tree.
//
// So two token positions are DATA, not code, and are discounted:
//   - an object-literal key   (`canvas` in `canvas: …`)     — the name of a slot
//   - a member property name  (`neutral` in `ramps.neutral`) — the name of a slot
// What survives is genuine structure: keywords, operators, calls, and the identifiers
// being operated ON (`ramps` still counts once). Real code keeps its score; a lookup
// table collapses to two or three.
const CODE_TOKEN_MIN = 8
const LITERAL = new Set(['S', 'N', ':', ',', '{', '}', '[', ']', '(', ')', ';', '.'])

function looksLikeData(tokens, start, len) {
  const distinct = new Set()
  for (let k = 0; k < len; k += 1) {
    const value = tokens[start + k].value
    if (LITERAL.has(value)) continue
    // Slot names carry no structure: skip `X` in `X:` and in `.X`.
    if (tokens[start + k + 1]?.value === ':') continue
    if (tokens[start + k - 1]?.value === '.') continue
    distinct.add(value)
  }
  return distinct.size < CODE_TOKEN_MIN
}

// windowHash -> first place it was seen. A later window matching it is a clone tail; we
// extend token-by-token to the maximal matching run and record the region once.
const firstSeen = new Map()
const clones = []
for (const file of files) {
  const { tokens } = file
  let i = 0
  while (i + MIN_TOKENS <= tokens.length) {
    const h = hashWindow(tokens, i)
    const prev = firstSeen.get(h)
    // Same-file self-overlap (a window matching itself shifted < MIN_TOKENS) is not a clone.
    const selfOverlap = prev !== undefined && prev.file === file && i - prev.index < MIN_TOKENS
    if (prev !== undefined && !selfOverlap) {
      const sameFile = prev.file === file
      let len = MIN_TOKENS
      while (
        i + len < tokens.length &&
        // Only within ONE file must the two regions not overlap; across files there is
        // no overlap to guard, so a cross-file clone extends to its full matching run.
        (!sameFile || prev.index + len < i) &&
        prev.file.tokens[prev.index + len] !== undefined &&
        prev.file.tokens[prev.index + len].value === tokens[i + len].value
      ) {
        len += 1
      }
      const aStart = prev.file.tokens[prev.index].line
      const aEnd = prev.file.tokens[prev.index + len - 1].line
      const bStart = tokens[i].line
      const bEnd = tokens[i + len - 1].line
      // A stable content fingerprint (normalized token run), so a reviewed-accepted clone
      // stays accepted after it moves lines.
      const fp = createHash('sha1')
        .update(
          tokens
            .slice(i, i + len)
            .map((t) => t.value)
            .join(' '),
        )
        .digest('hex')
        .slice(0, 12)
      const bigEnough = Math.max(aEnd - aStart, bEnd - bStart) + 1 >= MIN_LINES
      if (bigEnough && !looksLikeData(tokens, i, len) && !allow.has(fp)) {
        clones.push({
          fp,
          tokens: len,
          a: `${prev.file.path}:${aStart}-${aEnd}`,
          b: `${file.path}:${bStart}-${bEnd}`,
        })
      }
      i += len // skip past the clone
    } else {
      if (prev === undefined) firstSeen.set(h, { file, index: i })
      i += 1
    }
  }
}

const errs = clones.map(
  (c) =>
    `clone (${c.tokens} tokens, fingerprint ${c.fp}) — ${c.a} duplicates ${c.b}. Extract the shared logic into one function/module; if the repetition is genuinely irreducible, add {"fingerprint": "${c.fp}", "reason": …} to ${ALLOW} (reviewed).`,
)

// Ramp: an install predating this check carries copy-paste it never held them to — NOTE,
// don't ambush the update. In this lineage the check ships in 0.1.0: every fresh scaffold
// is turn-fatal.
if (errs.length > 0 && rampNote(GATE, '0.1.0', `${errs.length} code clone(s)`)) {
  ok(GATE, `${errs.length} clone(s) held as a ramp NOTE (pre-0.1.0 baseVersion)`)
}

failures(GATE, errs)
ok(
  GATE,
  `${files.length} source file(s) scanned, no clones ≥ ${MIN_TOKENS} tokens / ${MIN_LINES} lines`,
)
