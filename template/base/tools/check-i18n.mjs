#!/usr/bin/env node
// Gate: i18n — the locale seam is real, and nothing bypasses it.
//
// A Stop-chain step, NOT a member of the 21-gate floor (the floor stays frozen), and
// turn-fatal from the first release: the catalog ships with init, so every install that has
// the seam got it together with code that already satisfies this gate. An UPGRADED consumer
// has no catalog until they adopt it — the absent-catalog skip below is that honesty, and
// adopting the seam is the deliberate act that arms the gate.
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
// LIMITS, HONESTLY. This is a text scan, not a compiler: it sees the shapes copy takes, not
// every expression that could produce a string. A message assembled at runtime from fragments,
// or returned by a helper, is invisible to it. That is precisely why the pseudo-locale lane
// exists (the RNTL fast lane + the Maestro device lane): under `en-XA` every catalog string is
// visibly mangled, so any plain-English text still on screen is BY CONSTRUCTION a string that
// never went through the catalog. The static check is fast and runs every turn; the
// behavioural one is complete. Neither alone would be enough.
//
// Over-detection reds with `tools/i18n-allow.json` as the reviewed escape (malformed or stale
// entries FAIL, never open); it can never fail open.
// SOURCE: docs/harness/gates-catalog.md (i18n gate) [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'
import { walkFiles } from './lib/fs-walk.mjs'
import { fail, failures, ok, skipOrFail } from './lib/gate.mjs'
import { blankComments, lineOf } from './lib/source-text.mjs'

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
const allow = new Set()
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
      `${ALLOW_PATH} must be { "comment": …, "allow": [ { "site": "file:line", "reason": non-empty string } ] } — got ${JSON.stringify(parsed)}`,
    )
  }
  for (const entry of entries) {
    const okShape =
      entry !== null &&
      typeof entry === 'object' &&
      typeof entry.site === 'string' &&
      /^[^:]+:\d+$/.test(entry.site) &&
      typeof entry.reason === 'string' &&
      entry.reason.trim() !== ''
    if (!okShape) {
      fail(
        GATE,
        `${ALLOW_PATH}: every entry must be { "site": "file:line", "reason": non-empty string } — got ${JSON.stringify(entry)}`,
      )
    }
    allow.add(entry.site)
  }
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

const errs = []
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

  // ---- 1. hardcoded user-facing strings ---------------------------------------------
  // Attributes whose value a HUMAN READS (react-native names first — the a11y tree
  // SPEAKS accessibilityLabel/Hint, so they are copy in the fullest sense).
  // Everything else (testID, accessibilityRole — a token vocabulary, not prose —
  // nativeID, id, key, name, href) is machine-facing and deliberately absent.
  const TEXT_ATTRS = [
    'accessibilityLabel',
    'accessibilityHint',
    'aria-label',
    'aria-description',
    'title',
    'placeholder',
    'label',
    'alt',
  ]
  const ATTR_LITERAL = new RegExp(
    `\\b(${TEXT_ATTRS.join('|')})\\s*=\\s*"([^"]*[A-Za-z]{2}[^"]*)"`,
    'g',
  )

  // Object-literal copy: `label: 'Home'` in a navigator's options, `description:` in a
  // registry, `title:`/`subtitle:` in action items, column headers in the matrix data module.
  const OBJECT_LITERAL = /\b(label|title|subtitle|description)\s*:\s*'([^']*[A-Za-z]{2}[^']*)'/g

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
  // The residual false NEGATIVE is stated rather than hidden: prose that opens with a bare
  // `(` or `)` immediately after a tag close is not scanned. That is the correct direction to
  // lose in for a STATIC check whose own header says the behavioural half is the complete one —
  // under `en-XA` the pseudo-locale lane mangles every catalog string, so plain English still on
  // screen is by construction a string that bypassed the catalog.
  const JSX_TEXT = /(?<!=)>(?![(),.[>])\s*([^<>{}=;`$]*[A-Za-z]{2}[^<>{}=;`$]*?)\s*</g

  // A literal that is plainly not copy: a css/token/id-ish word with no spaces and no capital,
  // a lone url/path, a testID-shaped kebab string.
  function looksMachineFacing(text) {
    const trimmed = text.trim()
    if (trimmed === '') return true
    if (/^[/#.][\w/#.-]*$/.test(trimmed)) return true // '/healthz', '/matrix', '.foo'
    if (/^[a-z][\w-]*$/.test(trimmed) && !trimmed.includes(' ')) return true // 'gridcell', 'mod+k'
    return false
  }

  function record(file, text, index, source, what) {
    if (looksMachineFacing(text)) return
    const line = lineOf(source, index)
    if (allow.has(`${file}:${line}`)) return
    errs.push(
      `${file}:${line}: hardcoded user-facing string ${JSON.stringify(text.trim())} (${what}) — a literal in a component is copy no translator can reach and no reviewer can grep. FIX: add a key to ${CATALOG} and render it through \`t('<key>')\` (\`const { t } = useI18n()\` in a component; the plain \`t\` export outside one). If this string is genuinely never shown to a human, add a reviewed {"site": "${file}:${line}", "reason": …} entry to ${ALLOW_PATH}`,
    )
  }

  for (const file of sources) {
    const source = blankComments(readFileSync(file, 'utf8'))
    for (const m of source.matchAll(ATTR_LITERAL))
      record(file, m[2], m.index, source, `${m[1]} attribute`)
    for (const m of source.matchAll(OBJECT_LITERAL))
      record(file, m[2], m.index, source, `${m[1]}: property`)
    // JSX text ONLY in .tsx. A plain .ts file has no JSX, but it does have generics — and
    // `useListQuery<T>(fetcher: ListFetcher<T>)` looks exactly like a tag with text between it.
    // The attribute and object-literal rules still run there (routes.ts and the data modules
    // hold copy), so nothing is lost by not looking for JSX where there is none.
    if (!file.endsWith('.tsx')) continue
    for (const m of source.matchAll(JSX_TEXT)) record(file, m[1], m.index, source, 'JSX text')
  }

  // ---- 2. the Intl boundary ----------------------------------------------------------
  const INTL_USE = /\bIntl\s*\.|\.toLocale[A-Z]\w*\s*\(|\.toFixed\s*\(/g
  const boundary = []
  for (const file of sources) {
    const source = blankComments(readFileSync(file, 'utf8'))
    for (const m of source.matchAll(INTL_USE)) {
      const line = lineOf(source, m.index)
      if (allow.has(`${file}:${line}`)) continue
      boundary.push(
        `${file}:${line}: \`${m[0].trim()}\` outside ${I18N_DIR}/ — locale-sensitive formatting lives in ONE module or it disagrees with itself. \`.toFixed(2)\` in particular hardcodes \`.\` as the decimal mark, so a German reader gets "0.75" where they write "0,75". FIX: use formatCellValue / formatDate / formatRelativeTime from ${I18N_DIR}/`,
      )
    }
  }
  errs.push(...boundary)

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
  `${scope} — ${totals.keys} message key(s), ${totals.sources} source file(s) scanned, ${totals.locales} locale(s), ${totals.polyfills} polyfill(s) closed over, no hardcoded copy`,
)
