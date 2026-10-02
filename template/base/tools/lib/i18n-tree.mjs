// tools/lib/i18n-tree.mjs — the i18n gate's syntax-tree scanner (1.1.0), and since 2.0.0
// its only scan. The gate (tools/check-i18n.mjs) decides what its findings mean; this module
// only finds them.
//
// WHY A TREE. Through 1.0.x the gate found copy with regular expressions over comment-blanked
// source text, one quote form per expression, and a JSX text run that may not hold `=`, `;`,
// a backtick or `$`. So `accessibilityLabel={'Close dialog'}`, `` title: `Settings` ``,
// `label: "Don't have an account?"` in a .ts module and `<h2>Plans from $5</h2>` all passed.
// Here the TypeScript compiler parses each file once and the walk reads what the file IS:
//   - JsxText (in .tsx files only: a .ts file is parsed without JSX, so `<T>` stays a generic);
//   - an attribute in TEXT_ATTRS whose value is a string literal or a template literal with
//     no substitutions, bare or inside `{…}`;
//   - a `label`/`title`/`subtitle`/`description` property whose value is either of those;
//   - `Intl`, `toLocale*` and `toFixed` (kind `intl`), whose text is the matched
//     expression's source: `Intl.<member>`, or `.<method>(<arguments>)` from the dot through
//     the call's closing parenthesis.
// A value read through parentheses, `as` or `satisfies` is the same value. Every copy
// finding passes the two filters the 1.0.x regular expressions applied: two consecutive
// letters, and not looksMachineFacing.
//
// ONE KEY PER FINDING. findingKey hashes the POSIX path, the finding kind, the attribute or
// property name ('' for JSX text and `intl`) and the text with its whitespace collapsed, so a
// CRLF checkout gets the same key. Through 1.1.x the gate's regular expressions computed the
// key from the same four fields, so one allowlist entry muted a finding either scanner
// reported; 2.0.0 retired the expressions and every 1.1.x key still matches. Texts are taken
// from the comment-blanked source, and a finding's line is the line the expressions reported:
// the tag close before a JSX text run, the attribute or property name, the `.` of a method,
// the `I` of `Intl`.
//
// THE PARSER IS THE PROJECT'S OWN `typescript` devDependency, loaded with a dynamic import.
// When it cannot load, loadParser returns null instead of skipping or failing: the gate
// decides what a missing parser means (a loud NOTE locally, where the copy and boundary
// checks go unjudged; a failure in CI).
// SOURCE: docs/harness/gates-catalog.md (i18n gate) [corpus: harness/doctrine]
import { createHash } from 'node:crypto'
import { toPosix } from './fs-walk.mjs'
import { blankComments, lineOf } from './source-text.mjs'

// Attributes whose value a HUMAN READS (react-native names first — the a11y tree SPEAKS
// accessibilityLabel/Hint, so they are copy in the fullest sense). Everything else (testID,
// accessibilityRole — a token vocabulary, not prose — nativeID, id, key, name, href) is
// machine-facing and deliberately absent.
/** @public exported for the harness repo's gate suite (tests/gates/i18n-tree.test.mjs) */
export const TEXT_ATTRS = [
  'accessibilityLabel',
  'accessibilityHint',
  'aria-label',
  'aria-description',
  'title',
  'placeholder',
  'label',
  'alt',
]

// Object-literal copy: `label: 'Home'` in a navigator's options, `description:` in a
// registry, `title:`/`subtitle:` in action items, column headers in a data module.
const COPY_PROPS = ['label', 'title', 'subtitle', 'description']

/**
 * A literal that is plainly not copy: empty, a lone url/path/anchor, or a lowercase
 * token/id with no spaces (a css class, a testID-shaped kebab string).
 * @public exported for the harness repo's gate suite (tests/gates/i18n-tree.test.mjs)
 * @param {string} text
 */
export function looksMachineFacing(text) {
  const trimmed = text.trim()
  if (trimmed === '') return true
  if (/^[/#.][\w/#.-]*$/.test(trimmed)) return true // '/healthz', '/matrix', '.foo'
  if (/^[a-z][\w-]*$/.test(trimmed) && !trimmed.includes(' ')) return true // 'gridcell', 'home-empty'
  return false
}

/** Copy, by the two filters the regular expressions apply. @param {string} text */
const isCopy = (text) => /[A-Za-z]{2}/.test(text) && !looksMachineFacing(text)

/** Whitespace runs to one space, trimmed. @param {string} text */
const collapse = (text) => text.replace(/\s+/g, ' ').trim()

/**
 * The allowlist key: the first 12 hex characters of a sha256 over the JSON array
 * [POSIX path, kind, name, text with whitespace collapsed].
 * @public exported for the harness repo's gate suite (tests/gates/i18n-tree.test.mjs)
 * @param {string} file @param {string} kind @param {string} name @param {string} text
 */
export function findingKey(file, kind, name, text) {
  return createHash('sha256')
    .update(JSON.stringify([toPosix(file), kind, name, collapse(text)]))
    .digest('hex')
    .slice(0, 12)
}

/**
 * The TypeScript compiler, or null when it cannot be loaded. The loader is injectable so the
 * absent-parser path is testable without uninstalling anything.
 * @param {() => Promise<unknown> | unknown} [load]
 * @returns {Promise<typeof import('typescript') | null>}
 */
export async function loadParser(load = () => import('typescript')) {
  try {
    const mod = /** @type {any} */ (await load())
    const ts = mod?.default ?? mod
    return typeof ts?.createSourceFile === 'function' ? ts : null
  } catch {
    return null
  }
}

/**
 * @typedef {{ kind: 'attribute' | 'property' | 'jsx-text' | 'intl', name: string, text: string,
 *   line: number, key: string }} TreeFinding
 * @typedef {{ ts: typeof import('typescript'), file: string, src: string, out: TreeFinding[] }} Scan
 */

/** @param {Scan} s @param {TreeFinding['kind']} kind @param {string} name @param {string} text @param {number} at */
function push(s, kind, name, text, at) {
  const clean = collapse(text)
  s.out.push({
    kind,
    name,
    text: clean,
    line: lineOf(s.src, at),
    key: findingKey(s.file, kind, name, clean),
  })
}

/**
 * The literal a value holds, through parentheses, `as` and `satisfies`, or null.
 * @param {Scan} s @param {any} node @returns {any}
 */
function literalOf(s, node) {
  const K = s.ts.SyntaxKind
  let n = node
  while (
    n !== undefined &&
    (n.kind === K.ParenthesizedExpression ||
      n.kind === K.AsExpression ||
      n.kind === K.SatisfiesExpression)
  ) {
    n = n.expression
  }
  if (n === undefined) return null
  return n.kind === K.StringLiteral || n.kind === K.NoSubstitutionTemplateLiteral ? n : null
}

/** The raw text between a literal's delimiters. @param {Scan} s @param {any} lit */
const rawText = (s, lit) => s.src.slice(lit.getStart() + 1, lit.end - 1)

/** @param {Scan} s @param {any} node */
function onJsxText(s, node) {
  const text = s.src.slice(node.pos, node.end)
  if (isCopy(text)) push(s, 'jsx-text', '', text, node.pos)
}

/** @param {Scan} s @param {any} node */
function onJsxAttribute(s, node) {
  const name = node.name.getText()
  if (!TEXT_ATTRS.includes(name) || node.initializer === undefined) return
  const init =
    node.initializer.kind === s.ts.SyntaxKind.JsxExpression
      ? node.initializer.expression
      : node.initializer
  const lit = literalOf(s, init)
  if (lit === null) return
  const text = rawText(s, lit)
  if (isCopy(text)) push(s, 'attribute', name, text, node.getStart())
}

/** @param {Scan} s @param {any} node */
function onPropertyAssignment(s, node) {
  const K = s.ts.SyntaxKind
  if (node.name.kind !== K.Identifier && node.name.kind !== K.StringLiteral) return
  const name = node.name.text
  if (!COPY_PROPS.includes(name)) return
  const lit = literalOf(s, node.initializer)
  if (lit === null) return
  const text = rawText(s, lit)
  if (isCopy(text)) push(s, 'property', name, text, node.getStart())
}

const LOCALE_METHOD = /^(?:toLocale[A-Z]\w*|toFixed)$/

/** @param {Scan} s @param {any} node */
function onPropertyAccess(s, node) {
  if (!LOCALE_METHOD.test(node.name.text)) return
  const dot = s.src.lastIndexOf('.', node.name.getStart())
  const call = node.parent
  const called = call?.kind === s.ts.SyntaxKind.CallExpression && call.expression === node
  push(s, 'intl', '', s.src.slice(dot, called ? call.end : node.end), dot)
}

/** @param {Scan} s @param {any} node */
function onIdentifier(s, node) {
  if (node.text !== 'Intl') return
  const K = s.ts.SyntaxKind
  const p = node.parent
  // The member access or qualified type name `Intl` opens is ONE finding, spanning it.
  if (
    ((p.kind === K.PropertyAccessExpression || p.kind === K.ElementAccessExpression) &&
      p.expression === node) ||
    (p.kind === K.QualifiedName && p.left === node)
  ) {
    push(s, 'intl', '', s.src.slice(node.getStart(), p.end), node.getStart())
    return
  }
  // A name, not a reference: a property or member name, a declaration, an import binding.
  if (p.name === node || p.right === node || p.propertyName === node) return
  push(s, 'intl', '', 'Intl', node.getStart())
}

/**
 * Walk one file's syntax tree and report every copy and Intl finding, in source order.
 * @param {typeof import('typescript')} ts the compiler (see loadParser)
 * @param {string} file the file's path, relative to the project root
 * @param {string} text the file's text
 * @returns {TreeFinding[]}
 */
export function scanSource(ts, file, text) {
  const K = ts.SyntaxKind
  const tsx = file.endsWith('.tsx')
  // Comments are blanked first, keeping every offset, so a text is what the expressions see.
  const src = blankComments(text)
  const root = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  /** @type {Scan} */
  const s = { ts, file: toPosix(file), src, out: [] }
  // Dispatch on SyntaxKind from a table: each shape has one small handler.
  /** @type {Map<number, (s: Scan, node: any) => void>} */
  const handlers = new Map([
    [K.JsxAttribute, onJsxAttribute],
    [K.PropertyAssignment, onPropertyAssignment],
    [K.PropertyAccessExpression, onPropertyAccess],
    [K.Identifier, onIdentifier],
  ])
  if (tsx) handlers.set(K.JsxText, onJsxText)
  /** @param {any} node */
  const visit = (node) => {
    handlers.get(node.kind)?.(s, node)
    ts.forEachChild(node, visit)
  }
  visit(root)
  return s.out
}
