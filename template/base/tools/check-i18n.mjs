#!/usr/bin/env node
// Gate: i18n — the locale seam is real, and nothing bypasses it.
//
// A Stop-chain step, NOT a member of the 21-gate floor (the floor stays frozen). Its first
// four checks were turn-fatal from the first release: the catalog ships with init, so every
// install that has the seam got it together with code that already satisfies this gate. An
// UPGRADED consumer has no catalog until they adopt it — the absent-catalog skip below is
// that honesty, and adopting the seam is the deliberate act that arms the gate. 1.1.0 gave it
// its first ramp: what the syntax-tree walk adds (see "TWO SCANS" below) is a NOTE on an
// install seeded before 1.1.0, until 1.2.0.
//
// WHY IT IS A GATE AND NOT A GUIDELINE. In the harness this template was ported from, the
// app once contained zero `Intl.`, a hardcoded English locale, and ~70 English literals
// sprinkled across 20 components. Not because anyone decided against localization — because
// nothing ever asked. Prose in AGENTS.md is advisory; an agent adding a screen next week
// adds English literals to it, and every gate stays green. Single-locale English is a floor
// you can only hold by checking it.
//
// FOUR CHECKS.
//
//  1. NO HARDCODED USER-FACING STRING. A literal in a component is a string no translator can
//     reach, no reviewer can grep, and no gate can see. Detected in the places copy actually
//     lives: JSX text children, user-facing JSX attributes (accessibilityLabel,
//     accessibilityHint, placeholder, label, title, alt), and the object literals that feed
//     them — `label:`/`title:`/`subtitle:`/`description:` in the data modules that hold copy.
//
//  2. Intl AND toLocale* LIVE ONLY IN src/i18n/. Locale is threaded through exactly one
//     module, so it cannot disagree with itself. `.toFixed()` is banned in components for the
//     same reason and it is not pedantry: `.toFixed(2)` hardcodes `.` as the decimal mark, so
//     a matrix cell renders "0.75" to a German user who writes "0,75" — inside a function
//     called formatCell, which is exactly where you would look and not see it.
//
//  3. NO DEAD CATALOG STRING. A key nothing renders is copy that rots — translated, reviewed,
//     paid for, and never shown. Dynamically-built keys (`theme.switch.${next}`) are resolved
//     by their static prefix, so the check understands them without being fooled by them.
//
//  4. THE POLYFILL/LOCALE-DATA CLOSURE. Hermes ships no PluralRules/RelativeTimeFormat/Locale
//     (design record: EXPO-FACTS), so src/i18n/polyfills.ts force-installs the @formatjs
//     implementations plus PER-LANGUAGE CLDR data. A catalog locale whose base language has
//     no locale-data import for an installed polyfill would fall back to root-locale rules ON
//     DEVICE ONLY — the vitest suite (full ICU under Node) would never see it. The closure is
//     asserted BOTH ways: every catalog base language must have locale-data for every
//     imported polyfill that consumes it, and locale-data for a language no catalog locale
//     resolves to is dead weight in the bundle.
//
// TWO SCANS (1.1.0, #76). Through 1.0.x checks 1 and 2 were regular expressions over
// comment-blanked source text, each matching one quote form, and a JSX text run could not
// hold `=`, `;`, a backtick or `$`. So `accessibilityLabel={'Close dialog'}`,
// `` title: `Settings` ``, `label: "Don't have an account?"` in a .ts module and
// `<h2>Plans from $5</h2>` all passed. 1.1.0 also walks the TypeScript syntax tree
// (tools/lib/i18n-tree.mjs, one parse per file with the project's own `typescript`) and
// reports the UNION of the two scans, for one release:
//   - a finding both scans see, or only the expressions see, is hard, as it always was. One
//     only the expressions see is tagged: the expressions retire in 1.2.0, and the walk does
//     not read it as copy;
//   - a finding only the tree walk sees is hard on a fresh install, and a NOTE below
//     baseVersion 1.1.0, through rampNote until 1.2.0;
//   - when `typescript` cannot load, the expressions still judge and the output says the
//     walk did not run: a loud NOTE locally, a failure in CI (skip-local / fail-closed-CI).
//
// LIMITS, HONESTLY. Neither scan is a type checker: each sees the shapes copy takes, not
// every expression that could produce a string. A message assembled at runtime from
// fragments, or returned by a helper, is invisible to both. That is precisely why the
// pseudo-locale lane exists (the RNTL fast lane + the Maestro device lane): under `en-XA`
// every catalog string is visibly mangled, so any plain-English text still on screen is BY
// CONSTRUCTION a string that never went through the catalog. The static check is fast and
// runs every turn; the behavioural one is complete. Neither alone would be enough.
//
// THE ESCAPE IS KEYED ON CONTENT. `tools/i18n-allow.json` entries are
// {"key": <12 hex characters>, "reason": …}: a sha256 over the file's POSIX path, the
// finding kind, the attribute or property name and the text with its whitespace collapsed,
// which every FAIL line prints ready to paste. Both scans compute it from the same fields, so
// one entry mutes a finding whichever reports it, and inserting a line above the string
// moves nothing. A malformed entry, or a key that matches no finding, FAILS; the list never
// fails open. The 1.0.x `{"site": "file:line"}` entries ride the second ramp: below
// baseVersion 1.1.0 they still mute their line and print the key that replaces them, until
// 1.2.0; on a fresh install they are malformed.
// SOURCE: docs/harness/gates-catalog.md (i18n gate) [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'
import { walkFiles } from './lib/fs-walk.mjs'
import { fail, failures, inCI, ok, rampNote, skipOrFail } from './lib/gate.mjs'
import {
  COPY_PROPS,
  findingKey,
  loadParser,
  looksMachineFacing,
  scanSource,
  TEXT_ATTRS,
} from './lib/i18n-tree.mjs'
import { blankComments, lineOf, skipBalanced } from './lib/source-text.mjs'

const GATE = 'i18n'
const ALLOW_PATH = 'tools/i18n-allow.json'

// TWO SURFACES (0.6.0), and the shape of this table is the whole change.
//
// Through 0.5.0 this gate was `const SRC = 'apps/mobile/src'` and nothing else.
// docs/harness/enforcement-tiers.md declared that honestly — "the web app has no catalog seam
// and no `Intl` confinement, so a hardcoded user-facing string in a Server Component is caught
// by nothing" — and gave the row `Target 0.6.0`. This is that commitment met.
//
// It is NOT merely a second scan root, which is why the file needed restructuring rather than
// a two-line edit: `I18N_DIR`, `CATALOG` and `LOCALES_MODULE` were single-valued and
// mobile-derived, and checks 3 and 4 key off them. A surface owns its own catalog, its own
// locale list, and its own adoption state.
//
// `polyfills` is the one genuinely asymmetric field, and it is a property of the RUNTIME, not
// an omission: Hermes ships no Intl.PluralRules / RelativeTimeFormat / Locale, so the mobile
// seam force-installs @formatjs polyfills plus per-language CLDR data and check 4 holds that
// closure. Node and every browser ship full ICU. Running check 4 on the web surface would
// demand imports that must not exist; skipping it there is the measurement being different,
// and enforcement-tiers.md is where that is declared rather than hidden.
const SURFACES = [
  {
    key: 'mobile',
    // expo-router screens live under app/, not src/ — that is where most JSX copy is born, so
    // the scan covers both trees (the i18n module itself is the one place formatting and copy
    // are ALLOWED to live).
    roots: ['apps/mobile/src', 'apps/mobile/app'],
    i18nDir: 'apps/mobile/src/i18n',
    // Where inlined polyfill imports may legitimately appear besides the i18n dir.
    polyfillExtra: ['apps/mobile/app/_layout.tsx'],
    polyfills: true,
    adoptPath: 'apps/mobile/src/i18n/',
  },
  {
    key: 'web',
    // apps/web has no `src/`: the App Router tree is `app/` and shared modules are `lib/`.
    // Both hold copy — `lib/` because Server Actions and data modules build user-facing
    // strings, `app/` because that is where the JSX is.
    roots: ['apps/web/lib', 'apps/web/app'],
    i18nDir: 'apps/web/lib/i18n',
    polyfillExtra: [],
    polyfills: false,
    adoptPath: 'apps/web/lib/i18n/',
  },
].map((s) => ({
  ...s,
  catalog: `${s.i18nDir}/catalog.ts`,
  localesModule: `${s.i18nDir}/index.ts`,
}))

const present = SURFACES.filter((s) => s.roots.some((r) => existsSync(r)))
if (present.length === 0) {
  skipOrFail(GATE, 'neither apps/mobile nor apps/web found (no product surface yet)')
}

// Adoption is PER SURFACE. The seam is seedOnInitOnly, so an upgraded consumer has no catalog
// until they adopt it, and a gate that reds on its own absence would be exactly the ambush the
// ramp doctrine forbids. What changed in 0.6.0 is that one surface being un-adopted must not
// silence the other: before, a single `ok()` here exited the whole gate.
const adopted = present.filter((s) => existsSync(s.catalog))
const unadopted = present.filter((s) => !existsSync(s.catalog))
if (adopted.length === 0) {
  ok(
    GATE,
    `SKIPPED — no locale seam is adopted on any surface (${present.map((s) => s.catalog).join(', ')} absent), so this project ships single-locale. ` +
      `Adopt one with \`npx next-expo-supabase-agent-harness update --refresh-seeded ${present[0].adoptPath}\` ` +
      '(see docs/harness/gates-catalog.md, "i18n")',
  )
}

// ---- the reviewed escape (the rls-exempt pattern: malformed or stale FAILS, never opens) ----
// Two entry shapes. {"key", "reason"} is the one a FAIL line prints. {"site": "file:line",
// "reason"} is the 1.0.x shape: accepted here, and judged after the scan, where the ramp
// decides whether it still mutes (baseVersion below 1.1.0) or is malformed (a fresh install).
const KEY_SHAPE = /^[0-9a-f]{12}$/
const SITE_SHAPE = /^[^:]+:\d+$/
const ENTRY_SHAPE =
  '{ "key": "<the 12 hex characters a FAIL line prints>", "reason": non-empty string }'
/** @type {Map<string, { reason: string, used: boolean }>} */
const allowKeys = new Map()
/** @type {Map<string, { reason: string, used: boolean }>} */
const allowSites = new Map()

/** @param {unknown} entry */
function entryKind(entry) {
  if (entry === null || typeof entry !== 'object') return null
  const e = /** @type {Record<string, unknown>} */ (entry)
  if (typeof e.reason !== 'string' || e.reason.trim() === '') return null
  if (typeof e.key === 'string' && KEY_SHAPE.test(e.key) && e.site === undefined) return 'key'
  if (typeof e.site === 'string' && SITE_SHAPE.test(e.site) && e.key === undefined) return 'site'
  return null
}

if (existsSync(ALLOW_PATH)) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(ALLOW_PATH, 'utf8'))
  } catch (e) {
    fail(
      GATE,
      `${ALLOW_PATH} is not valid JSON (${e.message}) — the escape list must be reviewable data`,
    )
  }
  const entries = parsed?.allow
  if (!Array.isArray(entries)) {
    fail(
      GATE,
      `${ALLOW_PATH} must be { "comment": …, "allow": [ ${ENTRY_SHAPE} ] } — got ${JSON.stringify(parsed)}`,
    )
  }
  for (const entry of entries) {
    const kind = entryKind(entry)
    if (kind === null) {
      fail(GATE, `${ALLOW_PATH}: every entry must be ${ENTRY_SHAPE} — got ${JSON.stringify(entry)}`)
    }
    const into = kind === 'key' ? allowKeys : allowSites
    into.set(kind === 'key' ? entry.key : entry.site, { reason: entry.reason, used: false })
  }
}

// The second 1.1.0 ramp: a file:line entry keeps muting its line on an install seeded before
// 1.1.0, until 1.2.0, and names the key that replaces it (printed after the scan).
let honourSites = false
if (allowSites.size > 0) {
  if (
    rampNote(
      GATE,
      '1.1.0',
      'file:line site entries in tools/i18n-allow.json (content keys replace them)',
      {
        until: '1.2.0',
      },
    )
  ) {
    honourSites = true
  }
}

// ---- the parser -------------------------------------------------------------------
// The project's own `typescript`. Absent, the regular expressions judge alone and the output
// says so: a loud NOTE here, and a failure in CI, where a walk that did not run must never
// read as a pass.
const ts = await loadParser()
const WALK_MISSING =
  'the syntax-tree walk did not run: `typescript` could not be loaded from this project (it is a root devDependency; run `pnpm install`)'
if (ts === null && !inCI()) {
  console.log(
    `${GATE}: NOTE — ${WALK_MISSING}. The regular expressions judged alone, so copy only the walk finds went unseen; this gate FAILS CLOSED in CI`,
  )
}

// The catalog declares its locales in ONE reviewable array (LOCALES in the surface's i18n
// index); parse it FAIL-CLOSED — a seam whose locale list this gate cannot read is a seam it
// cannot hold, and inventing an empty list would vacate the checks that read it.
function readLocales(localesModule) {
  const src = existsSync(localesModule) ? blankComments(readFileSync(localesModule, 'utf8')) : ''
  const block = src.match(/\bLOCALES\s*:[^=]*=\s*\[([^\]]*)\]/)
  if (!block) {
    fail(
      GATE,
      `${localesModule} carries no parseable LOCALES array — the locale set cannot be read; restore the seeded module (it declares e.g. export const LOCALES: readonly Locale[] = ['en', …])`,
    )
  }
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

const isSourceFile = (rel) => /\.tsx?$/.test(rel) && !/[.-](test|spec)\.tsx?$/.test(rel)

// ---- 1. the regular expressions (through 1.1.0; they retire in 1.2.0) ---------------
// The shapes 1.0.x detected, unchanged, so nothing that reds in 1.0.3 stops redding while
// both scans run. TEXT_ATTRS and COPY_PROPS (and looksMachineFacing) live in
// tools/lib/i18n-tree.mjs, which both scans share.
const ATTR_LITERAL = new RegExp(
  `\\b(${TEXT_ATTRS.join('|')})\\s*=\\s*"([^"]*[A-Za-z]{2}[^"]*)"`,
  'g',
)
const OBJECT_LITERAL = new RegExp(
  `\\b(${COPY_PROPS.join('|')})\\s*:\\s*'([^']*[A-Za-z]{2}[^']*)'`,
  'g',
)

// JSX text: a run between a tag close and the next tag open, containing two consecutive
// letters. `{expr}` is not text (JSX splits on the brace) and a lone glyph (✕, ×) is not copy.
//
// TypeScript makes this harder than it looks, because `>` is also a generic close and half an
// arrow. Three guards, all load-bearing:
//   (?<!=)        — an arrow's `>` never opens JSX text. Without this, `ROUTES.map((r) => …)`
//                   reports the code that follows it as user-facing copy.
//   (?![(),.[>])  — a generic close ADJACENT to one of these is a type annotation or a call,
//                   never the start of prose. 0.6.0 added this when the web surface was
//                   brought into scope and produced four false positives that were all the
//                   same shape: `useState<AppError | null>(null)` and
//                   `submit(e: React.FormEvent<HTMLFormElement>): Promise<void>` — the run
//                   ran from a generic close, across the intervening code, to the NEXT
//                   generic open, and reported `"): Promise"` as copy. `apps/web` hits this
//                   constantly because Server Actions and form handlers are typed that way;
//                   `apps/mobile` happened not to, which is why five releases never saw it.
//                   ADJACENCY is what keeps this narrow: `<p> (optional) note</p>` still
//                   scans, because the paren there follows a space.
//   =;`$          — excluded from the run. A generic close is followed by CODE, and code has
//                   assignments, semicolons and template markers; prose does not. Prose's
//                   punctuation (: , . ( ) … —) stays legal, because copy really does use it.
//
// The residual false NEGATIVES were stated rather than hidden: prose that opens with a bare
// `(` or `)` immediately after a tag close, and a run that holds `$` (`Plans from $5`), is not
// scanned. The syntax-tree walk reads JsxText nodes, where none of these guards is needed,
// and it sees both.
const JSX_TEXT = /(?<!=)>(?![(),.[>])\s*([^<>{}=;`$]*[A-Za-z]{2}[^<>{}=;`$]*?)\s*</g

// Intl and toLocale*/toFixed. The optional member after `Intl.` and the balanced argument
// list after a method are not part of what matches: they are the finding's TEXT, taken as
// the tree walk takes it, so both scans key a finding the same way.
const INTL_USE = /\bIntl\s*\.(?:\s*[A-Za-z_$][\w$]*)?|\.toLocale[A-Z]\w*\s*\(|\.toFixed\s*\(/g

/** @param {string} source @param {RegExpMatchArray} m */
function intlText(source, m) {
  if (!m[0].endsWith('(')) return m[0]
  const open = /** @type {number} */ (m.index) + m[0].length - 1
  return source.slice(m.index, skipBalanced(source, open))
}

/**
 * @typedef {{ kind: string, name: string, text: string, line: number, key: string }} Finding
 * @typedef {Finding & { keys: string[], seen: 'regex' | 'regex-only' | 'both' | 'tree-only' }} Judged
 */

/** @param {string} file @param {string} kind @param {string} name @param {string} text @param {string} source @param {number} index @returns {Finding} */
function finding(file, kind, name, text, source, index) {
  const clean = text.replace(/\s+/g, ' ').trim()
  return {
    kind,
    name,
    text: clean,
    line: lineOf(source, index),
    key: findingKey(file, kind, name, clean),
  }
}

/**
 * What the regular expressions report in one comment-blanked file.
 * @param {string} file @param {string} source @returns {Finding[]}
 */
function regexScan(file, source) {
  const out = []
  const copy = (kind, name, text, index) => {
    if (!looksMachineFacing(text)) out.push(finding(file, kind, name, text, source, index))
  }
  for (const m of source.matchAll(ATTR_LITERAL)) copy('attribute', m[1], m[2], m.index)
  for (const m of source.matchAll(OBJECT_LITERAL)) copy('property', m[1], m[2], m.index)
  // JSX text ONLY in .tsx. A plain .ts file has no JSX, but it does have generics — and
  // `useListQuery<T>(fetcher: ListFetcher<T>)` looks exactly like a tag with text between it.
  // The attribute and object-literal rules still run there (routes.ts and the data modules
  // hold copy), so nothing is lost by not looking for JSX where there is none.
  if (file.endsWith('.tsx')) {
    for (const m of source.matchAll(JSX_TEXT)) copy('jsx-text', '', m[1], m.index)
  }
  for (const m of source.matchAll(INTL_USE)) {
    out.push(finding(file, 'intl', '', intlText(source, m), source, m.index))
  }
  return out
}

/**
 * The union of the two scans. A finding both report is ONE finding: matched on key and line
 * first, then on kind, name and line, where an escape in the literal makes the two texts
 * differ. It carries every key either scan computed, so an entry for either mutes it.
 * @param {Finding[]} regex @param {Finding[] | null} tree null when the walk did not run
 * @returns {Judged[]}
 */
function unite(regex, tree) {
  if (tree === null) return regex.map((f) => ({ ...f, keys: [f.key], seen: 'regex' }))
  const left = [...tree]
  /** @type {(Finding | null)[]} */
  const partner = regex.map((r) => {
    const i = left.findIndex((t) => t.key === r.key && t.line === r.line)
    return i === -1 ? null : left.splice(i, 1)[0]
  })
  /** @type {Judged[]} */
  const out = regex.map((r, n) => {
    let t = partner[n]
    if (t === null) {
      const i = left.findIndex((c) => c.kind === r.kind && c.name === r.name && c.line === r.line)
      t = i === -1 ? null : left.splice(i, 1)[0]
    }
    if (t === null) return { ...r, keys: [r.key], seen: 'regex-only' }
    return { ...t, keys: [...new Set([t.key, r.key])], seen: 'both' }
  })
  for (const t of left) out.push({ ...t, keys: [t.key], seen: 'tree-only' })
  return out.sort((x, y) => x.line - y.line)
}

// What a FAIL line says about which scan saw the finding, now that there are two.
const SEEN_TAG = {
  regex: '',
  both: '',
  'regex-only':
    ' [regular expressions only: the syntax-tree walk does not read this as copy, and this finding retires with the expressions in 1.2.0]',
  'tree-only': ' [syntax-tree walk only: a shape the 1.0.x regular expressions never matched]',
}

/** @param {Judged} f */
const pasteEntry = (f, why) => `{"key": "${f.keys[0]}", "reason": "<${why}>"}`

/** @param {string} file @param {Judged} f @param {string} catalog */
function copyMessage(file, f, catalog) {
  const what =
    f.kind === 'jsx-text'
      ? 'JSX text'
      : f.kind === 'attribute'
        ? `${f.name} attribute`
        : `${f.name}: property`
  return `${file}:${f.line}: hardcoded user-facing string ${JSON.stringify(f.text)} (${what}) — a literal in a component is copy no translator can reach and no reviewer can grep. FIX: add a key to ${catalog} and render it through \`t('<key>')\` (\`const { t } = useI18n()\` in a component; the plain \`t\` export outside one). If this string is genuinely never shown to a human, add this reviewed entry to ${ALLOW_PATH}: ${pasteEntry(f, 'why no human reads it')}${SEEN_TAG[f.seen]}`
}

/** @param {string} file @param {Judged} f @param {string} i18nDir */
function intlMessage(file, f, i18nDir) {
  return `${file}:${f.line}: \`${f.text}\` outside ${i18nDir}/ — locale-sensitive formatting lives in ONE module or it disagrees with itself. \`.toFixed(2)\` in particular hardcodes \`.\` as the decimal mark, so a German reader gets "0.75" where they write "0,75". FIX: use formatCellValue / formatDate / formatRelativeTime from ${i18nDir}/; if this call genuinely must bypass the locale, add this reviewed entry to ${ALLOW_PATH}: ${pasteEntry(f, 'why it bypasses the locale')}${SEEN_TAG[f.seen]}`
}

/** file:line -> the keys of the findings on that line, for the site entries that name it. */
const siteKeys = new Map()

/**
 * Whether the allowlist mutes a finding, marking every entry that does as used.
 * @param {string} file @param {Judged} f
 */
function muted(file, f) {
  let hit = false
  for (const k of f.keys) {
    const entry = allowKeys.get(k)
    if (entry !== undefined) {
      entry.used = true
      hit = true
    }
  }
  const site = allowSites.get(`${file}:${f.line}`)
  if (site !== undefined) {
    site.used = true
    siteKeys.set(`${file}:${f.line}`, [...(siteKeys.get(`${file}:${f.line}`) ?? []), f.keys[0]])
  }
  return hit || (honourSites && site !== undefined)
}

const errs = []
// Findings only the tree walk sees, held for the ramp after every surface is scanned.
const treeOnly = []
// Totals for the ok() line, accumulated across surfaces so the summary describes what RAN.
const totals = { keys: 0, sources: 0, locales: 0, polyfills: 0 }

for (const surface of adopted) {
  const { i18nDir: I18N_DIR, catalog: CATALOG, localesModule: LOCALES_MODULE } = surface

  // The i18n dir is excluded from every root that contains it — it is the ONE place
  // formatting and copy are allowed to live, on either surface.
  const sources = surface.roots
    .filter((r) => existsSync(r))
    .flatMap((root) =>
      walkFiles(root, {
        excludeDirs: new Set(['node_modules', 'i18n']),
        filter: isSourceFile,
      })
        .map((rel) => `${root}/${rel}`)
        .filter((f) => !f.startsWith(`${I18N_DIR}/`)),
    )
  totals.sources += sources.length

  // ---- 1. hardcoded user-facing strings, and 2. the Intl boundary ------------------
  // One read and one parse per file; both scans; their union judged once.
  const copyErrs = []
  const boundary = []
  for (const file of sources) {
    const text = readFileSync(file, 'utf8')
    const judged = unite(
      regexScan(file, blankComments(text)),
      ts === null ? null : scanSource(ts, file, text),
    )
    for (const f of judged) {
      if (muted(file, f)) continue
      const message =
        f.kind === 'intl' ? intlMessage(file, f, I18N_DIR) : copyMessage(file, f, CATALOG)
      if (f.seen === 'tree-only') treeOnly.push(message)
      else (f.kind === 'intl' ? boundary : copyErrs).push(message)
    }
  }
  errs.push(...copyErrs, ...boundary)

  // ---- 3. no dead catalog string -----------------------------------------------------
  const catalogSource = blankComments(readFileSync(CATALOG, 'utf8'))
  const keys = [...catalogSource.matchAll(/^\s*'([^']+)'\s*:/gm)].map((m) => m[1])
  if (keys.length === 0) {
    fail(GATE, `${CATALOG} declares no message keys — the catalog cannot be empty`)
  }

  const i18nFiles = walkFiles(I18N_DIR, {
    filter: (r) => /\.tsx?$/.test(r) && !/\.test\./.test(r),
  }).map((r) => `${I18N_DIR}/${r}`)

  // Every string literal anywhere in the app (including src/i18n consumers) plus the static
  // PREFIX of every template literal, so `t(\`theme.switch.${next}\`)` marks the whole family used.
  const referenced = new Set()
  const prefixes = []
  for (const file of [...sources, ...i18nFiles]) {
    if (file === CATALOG) continue
    const source = blankComments(readFileSync(file, 'utf8'))
    for (const m of source.matchAll(/['"]([\w.-]+)['"]/g)) referenced.add(m[1])
    for (const m of source.matchAll(/`([\w.-]*)\$\{/g)) {
      if (m[1] !== '') prefixes.push(m[1])
    }
  }
  const dead = keys.filter(
    (key) => !referenced.has(key) && !prefixes.some((prefix) => key.startsWith(prefix)),
  )
  for (const key of dead) {
    errs.push(
      `${CATALOG}: message key '${key}' is never rendered — copy nothing shows is copy that rots (translated, reviewed, and dead). Remove it, or render it.`,
    )
  }

  totals.keys += keys.length

  // ---- 4. the polyfill / locale-data closure ---------------------------------------
  // MOBILE ONLY, and the guard is the honest form of the asymmetry rather than a skip: the
  // web surface has no polyfill layer to close over because Node and every browser ship full
  // ICU. Running this there would demand @formatjs imports that must NOT exist.
  if (!surface.polyfills) {
    totals.locales += readLocales(LOCALES_MODULE).length
    continue
  }
  const locales = readLocales(LOCALES_MODULE)
  totals.locales += locales.length
  // Formatting resolves through the BASE LANGUAGE (pseudo-locales carry a private-use
  // region CLDR does not key on — see baseLocale in src/i18n/index.ts), so locale-data
  // closure is computed over language subtags.
  const baseLangs = new Set(locales.map((l) => l.split('-')[0].toLowerCase()))

  // @formatjs polyfills that consume per-language CLDR locale-data. intl-getcanonicallocales
  // and intl-locale ship data-free (pure algorithms + likely-subtags) — deliberately absent.
  const LOCALE_DATA_PKGS = new Set([
    'intl-pluralrules',
    'intl-relativetimeformat',
    'intl-numberformat',
    'intl-datetimeformat',
    'intl-displaynames',
    'intl-listformat',
  ])
  const POLYFILL_IMPORT = /['"]@formatjs\/(intl-[a-z-]+)\/polyfill[\w-]*(?:\.js)?['"]/g
  const LOCALE_DATA_IMPORT =
    /['"]@formatjs\/(intl-[a-z-]+)\/locale-data\/([A-Za-z0-9-]+?)(?:\.js)?['"]/g

  // The polyfill imports live in the i18n module (polyfills.ts) or the root layout —
  // scan both, so a consumer who inlines them into app/_layout.tsx is still seen.
  const polyfillScan = [...i18nFiles, ...surface.polyfillExtra].filter((f) => existsSync(f))
  const polyfills = new Set()
  const dataImports = new Map() // `${pkg}/${lang}` -> `file:line`
  for (const file of polyfillScan) {
    const source = blankComments(readFileSync(file, 'utf8'))
    for (const m of source.matchAll(POLYFILL_IMPORT)) polyfills.add(m[1])
    for (const m of source.matchAll(LOCALE_DATA_IMPORT)) {
      dataImports.set(`${m[1]}/${m[2].toLowerCase()}`, `${file}:${lineOf(source, m.index)}`)
    }
  }

  for (const pkg of [...polyfills].filter((p) => LOCALE_DATA_PKGS.has(p)).sort()) {
    for (const lang of [...baseLangs].sort()) {
      if (!dataImports.has(`${pkg}/${lang}`)) {
        errs.push(
          `catalog locale base '${lang}' (from LOCALES in ${LOCALES_MODULE}) has no \`@formatjs/${pkg}/locale-data/${lang}\` import — on device the polyfill would silently fall back to root-locale CLDR rules, and only there (Node under vitest has full ICU, so no test would catch it). FIX: add the import to ${I18N_DIR}/polyfills.ts in the same diff as the locale.`,
        )
      }
    }
  }
  for (const [key, site] of [...dataImports.entries()].sort()) {
    const lang = key.split('/')[1]
    if (!baseLangs.has(lang)) {
      errs.push(
        `${site}: locale-data import for '${lang}' but no catalog locale resolves to it (LOCALES in ${LOCALES_MODULE} covers base language(s): ${[...baseLangs].sort().join(', ')}) — CLDR data nothing can select is dead bundle weight. Remove the import, or add the locale's catalog.`,
      )
    }
  }
  totals.polyfills += polyfills.size
}

// ---- the escape, judged -------------------------------------------------------------
// A key that matches no finding is stale: a standing permission nobody reviewed, waiting for
// a future string that hashes the same. With the walk absent it cannot be judged, since the
// finding it names may be one only the walk sees.
for (const [key, entry] of allowKeys) {
  if (entry.used) continue
  if (ts === null) {
    console.log(
      `${GATE}: NOTE — ${ALLOW_PATH}: key "${key}" matches no finding the regular expressions report; the syntax-tree walk did not run, so it is not judged stale here`,
    )
  } else {
    errs.push(
      `${ALLOW_PATH}: key "${key}" matches no finding — a stale entry is a standing permission nobody reviewed, waiting for a future string with the same path, kind, name and text. Delete it (reason was: ${JSON.stringify(entry.reason)}).`,
    )
  }
}

// file:line entries: inside the ramp they muted their line during the scan, and each names
// the key that replaces it; outside it (a fresh install, or harness 1.2.0) they are malformed.
for (const [site, entry] of allowSites) {
  const keys = [...new Set(siteKeys.get(site) ?? [])]
  const replacement = keys
    .map((k) => `{"key": "${k}", "reason": ${JSON.stringify(entry.reason)}}`)
    .join(', ')
  if (honourSites) {
    console.log(
      keys.length > 0
        ? `${GATE}: NOTE — ${ALLOW_PATH}: {"site": "${site}"} mutes this line until 1.2.0; replace it with ${replacement}, which stays on the string when the line moves`
        : `${GATE}: NOTE — ${ALLOW_PATH}: {"site": "${site}"} matches no finding — a stale file:line entry; delete it`,
    )
  } else {
    errs.push(
      `${ALLOW_PATH}: {"site": "${site}"} — every entry must be ${ENTRY_SHAPE}. A file:line entry follows its line, not its string, and 1.1.0 replaced it with a content key: ${
        keys.length > 0 ? `replace it with ${replacement}` : 'it matches no finding, so delete it'
      }`,
    )
  }
}

// The first 1.1.0 ramp: copy only the syntax-tree walk finds is a NOTE on an install seeded
// before 1.1.0, until 1.2.0, and hard everywhere else.
if (treeOnly.length > 0) {
  if (
    rampNote(
      GATE,
      '1.1.0',
      'copy only the syntax-tree walk finds (shapes the 1.0.x regular expressions miss)',
      {
        until: '1.2.0',
      },
    )
  ) {
    for (const message of treeOnly) console.log(`${GATE}: NOTE — ${message}`)
  } else {
    errs.push(...treeOnly)
  }
}

// CI never judges with the regular expressions alone.
if (ts === null && inCI()) {
  errs.push(
    `${WALK_MISSING} — in CI this gate fails closed rather than judge with the regular expressions alone`,
  )
}

// ---- verdict -----------------------------------------------------------------------
failures(
  GATE,
  errs,
  '  The locale seam, on every adopted surface: every user-facing string is a catalog key, locale-sensitive formatting lives only in that surface\'s i18n/ directory, and the mobile catalog carries its @formatjs locale-data (see docs/harness/gates-catalog.md, "i18n"). The pseudo-locale lane proves it behaviourally.',
)
// The un-adopted surfaces are NAMED, never silently dropped. A surface this gate did not
// judge is the exact thing enforcement-tiers.md exists to stop being invisible, and "the gate
// was green" must not be readable as "both surfaces were checked".
const scope = `${adopted.map((s) => s.key).join(' + ')} adopted${
  unadopted.length > 0
    ? `; NOT judged: ${unadopted.map((s) => `${s.key} (no ${s.catalog})`).join(', ')}`
    : ''
}`
ok(
  GATE,
  `${scope} — ${totals.keys} message key(s), ${totals.sources} source file(s) scanned, ${totals.locales} locale(s), ${totals.polyfills} polyfill(s) closed over, no hardcoded copy (${
    ts === null
      ? 'regular expressions only: the syntax-tree walk did not run'
      : 'regular expressions and the syntax-tree walk ran'
  })`,
)
