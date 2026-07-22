#!/usr/bin/env node
// Gate: styleguide — the design system is DATA, and this gate keeps it honest.
// Ported from the desktop original and re-seamed for this host: there the token
// vocabulary lived in a CSS-first token sheet and the scans chased utility
// classes; here tools/styleguide.manifest.json is the OKLCH source of truth and
// tools/gen-theme.mjs COMPILES it into the COMMITTED
// apps/mobile/src/theme/tokens.gen.ts, which plain style objects consume
// (PORT-SPEC: a styling compile layer between the manifest and the pixels was
// rejected precisely so this gate can scan tokens-as-data). Checks, in lockstep
// with tools/styleguide.manifest.json (write-guard-protected — evolving the
// design system is a reviewed human diff of the manifest and the regenerated
// module together):
//   1. manifest schema — tokens/themes/contrast/allow lists are shape-checked
//      LOUDLY; every theme declares exactly the canonical token set as
//      {l,c,h} OKLCH numbers. An out-of-gamut value is red ('unverifiable'):
//      the platform would gamut-map it, so its painted contrast is not the one
//      computed here — and the generator refuses it for the same reason.
//   2. regen-diff — `node tools/gen-theme.mjs --check`: the committed
//      tokens.gen.ts must be byte-identical to a fresh generation from the
//      manifest (the module is committed so the app builds with no codegen
//      step; this sub-check is what keeps the committed bytes honest — a hand
//      edit here is a red gate, not a design change).
//   3. token closure — every manifest token exists in every theme of the
//      generated module and vice versa, and every module value is a
//      gamma-encoded #rrggbb hex; a key on only one side is a stale manifest
//      or a hand-grown palette. (The desktop original's family closure is
//      subsumed here: families render INTO the generated module, so the
//      regen-diff covers them byte-for-byte.)
//   4. computed contrast — every manifest.contrast {fg,bg,min} pair is
//      CONVERTED oklch -> linear sRGB -> WCAG luminance and asserted >= min in
//      EVERY theme. The minima are manifest DATA, not gate constants: the
//      shipped pairs hold body ink at AAA 7:1 and secondary ink + the
//      accent/status hues at AA 4.5. Contrast is never prose — it is recomputed
//      here from the same math the generator ran, so the numbers cannot drift.
//   5. source scan over apps/mobile/{src,app}, OUTSIDE src/theme (the tokens
//      module is the ONE home of raw values; app/ holds the router screens and
//      obeys the same vocabulary):
//      (a) raw color VALUES — hex string literals anywhere; rgb()/rgba()/
//          hsl()/hsla(); CSS named colors assigned to color-valued props/style
//          keys (`color` or any `*Color` key — react-native's color props all
//          follow that shape, from backgroundColor and shadowColor to
//          placeholderTextColor and navigator tint options). 'transparent' is
//          exempt: it is the absence of paint, the counterpart of the
//          non-palette specials the desktop original never erased.
//      (b) numeric literals in the dimension style keys (fontSize/lineHeight/
//          gap/borderRadius/padding*/margin*): the scales live in tokens.gen.ts
//          (typeScale/spacing/radius) — write spacing multiples, never offsets.
//          A literal 0 passes; token-derived arithmetic (spacing * 4) passes.
//      (c) inline style={{...}} object literals outside the components home:
//          any raw numeric value (beyond 0) reds — screens style through
//          useThemedStyles factories over the palette, never ad-hoc objects.
//          Values that reference tokens pass, and bare layout keywords
//          ('row', 'center') pass: they are neither colors nor dimensions, and
//          the (a) scans already police color strings inside these objects.
//   5b. primitive boundary — (conditional on `controlPrimitives`; a keyless
//       manifest self-disables with an adoption NOTE) a JSX open-tag for a
//       declared control component (<Pressable|TouchableOpacity|TextInput|…)
//       carrying a style prop in a .tsx outside the declared primitives home
//       is red: a hand-styled control forks the design system — the styling
//       belongs IN the src/components primitive. manifest.controlAllow lists
//       reviewed file exemptions; malformed or STALE entries fail, never fail
//       open.
//   5c. status surfaces — (conditional on `statusSurfaces`) a surface that
//       announces status (role="alert" / role="status" / aria-invalid — the
//       manifest's signal list) must reference a status token (palette.danger,
//       or an AppText variant: the variant names deliberately EQUAL the token
//       names) — failure and success must never be the same pixel. Colour is A
//       channel, never the ONLY one (the surfaces keep their text + role).
//   5d. motion discipline — (conditional on `motionSeam`) literal `duration:`/
//       `delay:` numerics red anywhere in the walk (the motion vocabulary lives
//       in the motion tokens; 0 passes), and `Animated./LayoutAnimation./
//       Easing.` references red outside the seam file + the components home —
//       the seam's hooks carry the token vocabulary AND the reduce-motion
//       collapse, so a raw call site would ship neither. The seam ban has NO
//       allow escape by design.
//   5e. elevation keys — (conditional on `families.elevation`) the shadow*/
//       elevation style keys are spelled ONLY inside the generated tokens
//       module; consumers spread an elevation level ({ ...elevation.raised }).
//   5f. hit-target floor — (conditional on `families.sizing`) a home file that
//       STYLES a raw control must reference sizes.minTarget in its own code:
//       every touchable meets the 44dp floor at the primitive, never per call
//       site. With `controlPrimitives.base` declared, the pressable-class tags
//       may be styled in exactly ONE home file (the touchable base) — pressed
//       feedback, the hit target, and the haptic live there, so a second raw
//       pressable primitive is a design-system fork.
//   6. accent budget — the near-monochrome + single-accent design survives on
//      a usage BUDGET: accent-token references stay <= the documented budget.
// Dropped from the desktop original, deliberately: erasure markers (no default
// utility palette exists on this host to erase — the vocabulary is generated,
// closed by construction) and the utility-class/arbitrary-value scans (no
// class compiler here; the equivalent escapes are the raw values and inline
// objects scanned above).
// Precision/recall, the desktop doctrine verbatim: this is a REGEX scanner,
// not a TS parser — zero dependencies, no parse step, and over-detection reds
// (with reviewed allow escapes) rather than failing open. Comments are BLANKED
// first (tools/lib/source-text.mjs), so a commented-out raw value no longer
// reds a scan AND a token named only in prose cannot satisfy the
// status-channel requirement — with one deliberate asymmetry: status SIGNALS
// are detected on the RAW text, because over-detecting a signal only ever
// DEMANDS colour (the safe direction). Known blind spots, accepted exactly as
// on the desktop: a style smuggled through spread props ({...props}) is not
// detected; a hex built mid-string or by concatenation is not detected (the
// whole-string match is what keeps issue-number prose like "#123456" green);
// and a `<` inside an attribute expression ends a control-tag window early
// (under-detects that one tag, never a whole file).
// SOURCE: docs/harness/gates-catalog.md (styleguide gate) [corpus: harness/doctrine]
// SOURCE: OKLCH->sRGB reference path for computed contrast [corpus: csswg/oklch-srgb]
// SOURCE: WCAG relative luminance + contrast ratio [corpus: wcag/relative-luminance]
// SOURCE: react-native color props/style keys and the CSS named-color set
// https://reactnative.dev/docs/colors
import { existsSync, readFileSync } from 'node:fs'
import { walkFiles } from './lib/fs-walk.mjs'
import { fail, failures, ok, runCmd, skipOrFail } from './lib/gate.mjs'
import { contrastRatio, inSrgbGamut, oklchToLinearSrgb, relativeLuminance } from './lib/oklch.mjs'
import { blankComments, skipBalanced } from './lib/source-text.mjs'

const GATE = 'styleguide'
const MANIFEST = 'tools/styleguide.manifest.json'
const TOKENS_MODULE = 'apps/mobile/src/theme/tokens.gen.ts'
const SRC_DIR = 'apps/mobile/src'
const APP_DIR = 'apps/mobile/app'

if (!existsSync(SRC_DIR)) skipOrFail(GATE, `${SRC_DIR} not found (no mobile styling surface yet)`)
if (!existsSync(MANIFEST)) fail(GATE, `${MANIFEST} missing — the harness ships it; restore it`)

let manifest
try {
  manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
} catch (e) {
  fail(
    GATE,
    `${MANIFEST} is not valid JSON (${e.message}) — the design contract must be reviewable data`,
  )
}
const errs = []

// ---- 1: manifest schema + OKLCH values ----------------------------------------
if (
  !Array.isArray(manifest.tokens) ||
  manifest.tokens.length === 0 ||
  !manifest.tokens.every((t) => typeof t === 'string' && /^[a-z][a-z0-9-]*$/.test(t))
) {
  fail(
    GATE,
    `${MANIFEST} tokens must be a non-empty array of token names — got ${JSON.stringify(manifest.tokens)}`,
  )
}
const documented = new Set(manifest.tokens)

if (
  manifest.themes === null ||
  typeof manifest.themes !== 'object' ||
  Object.keys(manifest.themes).length === 0
) {
  fail(
    GATE,
    `${MANIFEST} themes must declare at least one theme — the committed palettes are generated from it`,
  )
}
for (const [name, spec] of Object.entries(manifest.themes)) {
  if (
    spec === null ||
    typeof spec !== 'object' ||
    spec.tokens === null ||
    typeof spec.tokens !== 'object'
  ) {
    fail(
      GATE,
      `${MANIFEST} themes.${name} must be { "tokens": { <name>: { "l", "c", "h" } } } — got ${JSON.stringify(spec)}`,
    )
  }
  // Manifest-side token-set closure: a theme missing a token would paint the
  // other theme's value on its canvas; an extra token is undocumented paint.
  const names = new Set(Object.keys(spec.tokens))
  for (const t of documented) {
    if (!names.has(t)) {
      errs.push(
        `theme "${name}" does not declare token "${t}" — every theme carries the full canonical token set`,
      )
    }
  }
  for (const t of names) {
    if (!documented.has(t)) {
      errs.push(
        `theme "${name}" declares token "${t}", which is not in ${MANIFEST} tokens[] — add it (with intent) to the canonical set or drop it`,
      )
    }
  }
  for (const [t, v] of Object.entries(spec.tokens)) {
    if (
      v === null ||
      typeof v !== 'object' ||
      ![v.l, v.c, v.h].every((n) => typeof n === 'number' && Number.isFinite(n))
    ) {
      fail(
        GATE,
        `${MANIFEST} themes.${name}.tokens.${t} must be { "l": number, "c": number, "h": number } — got ${JSON.stringify(v)}`,
      )
    }
    if (!inSrgbGamut(oklchToLinearSrgb(v.l, v.c, v.h))) {
      errs.push(
        `theme "${name}" token "${t}" = oklch(${v.l} ${v.c} ${v.h}) is outside the sRGB gamut — its contrast is unverifiable (the platform gamut-maps it; reduce its chroma in ${MANIFEST} until it displays as authored)`,
      )
    }
  }
}

// ---- 4: computed contrast (conditional on manifest.contrast) -------------------
// The manifest's OKLCH values are converted directly (no CSS to parse on this
// host) and every declared pair is asserted in EVERY theme. Out-of-gamut
// endpoints were already redded above, so those pairs are skipped rather than
// reported twice with numbers nobody would see painted.
function assertContrastPairShape(pair) {
  if (
    pair === null ||
    typeof pair !== 'object' ||
    typeof pair.fg !== 'string' ||
    typeof pair.bg !== 'string' ||
    typeof pair.min !== 'number' ||
    pair.min <= 0
  ) {
    fail(
      GATE,
      `${MANIFEST} contrast entries must be { "fg": string, "bg": string, "min": positive number } — got ${JSON.stringify(pair)}`,
    )
  }
}

if (Array.isArray(manifest.contrast)) {
  for (const pair of manifest.contrast) assertContrastPairShape(pair)
  for (const [name, spec] of Object.entries(manifest.themes)) {
    for (const { fg, bg, min } of manifest.contrast) {
      const fgTok = spec.tokens[fg]
      const bgTok = spec.tokens[bg]
      if (fgTok === undefined || bgTok === undefined) {
        errs.push(
          `theme "${name}" contrast ${fg}/${bg}: token "${fgTok === undefined ? fg : bg}" not declared in this theme`,
        )
        continue
      }
      const fgRgb = oklchToLinearSrgb(fgTok.l, fgTok.c, fgTok.h)
      const bgRgb = oklchToLinearSrgb(bgTok.l, bgTok.c, bgTok.h)
      if (!inSrgbGamut(fgRgb) || !inSrgbGamut(bgRgb)) continue // gamut error already recorded above
      const ratio = contrastRatio(relativeLuminance(fgRgb), relativeLuminance(bgRgb))
      if (ratio < min) {
        errs.push(
          `theme "${name}" contrast ${fg} on ${bg} = ${ratio.toFixed(2)}:1 (min ${min}:1) — FIX: retune themes.${name}.tokens.${fg} or .${bg} in ${MANIFEST} until the computed ratio clears ${min}:1, then \`node tools/gen-theme.mjs\``,
        )
      }
    }
  }
}

// ---- 2 + 3: regen-diff and token closure over the committed module -------------
let moduleText = null
if (existsSync(TOKENS_MODULE)) {
  moduleText = readFileSync(TOKENS_MODULE, 'utf8')
} else {
  errs.push(
    `${TOKENS_MODULE} missing — the committed token module is generated data; run \`node tools/gen-theme.mjs\` and commit the result`,
  )
}

if (moduleText !== null) {
  // The regen-diff is the drift detector: byte-identity with a fresh render,
  // via the exact command a human runs. Its own output is surfaced on red.
  try {
    runCmd('node tools/gen-theme.mjs --check')
  } catch (e) {
    const detail = [e.stdout, e.stderr].filter(Boolean).join('\n').trim() || e.message
    errs.push(
      `${TOKENS_MODULE} drifted from ${MANIFEST} (regen-diff):\n    ${detail.split('\n').join('\n    ')}\n    run \`node tools/gen-theme.mjs\`, then review \`git diff ${TOKENS_MODULE}\` — the manifest is the source of truth; a hand edit to the generated module is a red gate, not a design change`,
    )
  }

  // Closure is still asserted independently (a byte-diff names no token): the
  // committed palettes and manifest.tokens must match bidirectionally per theme.
  const palettesStart = moduleText.indexOf('export const palettes = {')
  if (palettesStart === -1) {
    fail(
      GATE,
      `${TOKENS_MODULE} has no \`export const palettes\` block — the token source of truth is gone; regenerate with \`node tools/gen-theme.mjs\``,
    )
  }
  const open = moduleText.indexOf('{', palettesStart)
  const body = moduleText.slice(open + 1, skipBalanced(moduleText, open) - 1)
  const moduleThemes = new Map() // theme -> Map(token -> value)
  for (const tm of body.matchAll(/(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*:\s*\{([\s\S]*?)\}/g)) {
    const tokens = new Map()
    for (const km of tm[3].matchAll(/(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*:\s*'([^']*)'/g)) {
      tokens.set(km[1] ?? km[2], km[3])
    }
    moduleThemes.set(tm[1] ?? tm[2], tokens)
  }
  if (moduleThemes.size === 0)
    fail(GATE, `${TOKENS_MODULE} palettes declare no themes — vacuous module`)
  for (const name of Object.keys(manifest.themes)) {
    if (!moduleThemes.has(name)) {
      errs.push(
        `${MANIFEST} declares theme "${name}" but ${TOKENS_MODULE} has no palettes.${name} — regenerate (\`node tools/gen-theme.mjs\`)`,
      )
    }
  }
  for (const [name, tokens] of moduleThemes) {
    if (manifest.themes[name] === undefined) {
      errs.push(
        `${TOKENS_MODULE} palettes.${name} exists but ${MANIFEST} declares no theme "${name}" — stale module; regenerate`,
      )
      continue
    }
    for (const token of tokens.keys()) {
      if (!documented.has(token)) {
        errs.push(
          `palettes.${name}.${token} exists in ${TOKENS_MODULE} but is not documented in ${MANIFEST} — add it (with intent) or regenerate`,
        )
      }
    }
    for (const token of documented) {
      if (!tokens.has(token)) {
        errs.push(
          `${MANIFEST} documents token "${token}" but ${TOKENS_MODULE} palettes.${name} no longer declares it — stale module; regenerate`,
        )
      }
    }
    for (const [token, value] of tokens) {
      if (!/^#[0-9a-f]{6}$/.test(value)) {
        errs.push(
          `palettes.${name}.${token} is "${value}" — module values are gamma-encoded #rrggbb hex emitted by tools/gen-theme.mjs (one encoding keeps the scans and the computed contrast honest)`,
        )
      }
    }
  }
}

// ---- exemption lists: file-level, each with a reviewed reason; malformed = loud
function parseAllowEntries(value, label) {
  if (value === undefined) return new Set()
  if (!Array.isArray(value)) {
    fail(
      GATE,
      `${MANIFEST} "${label}" must be an ARRAY of {"file": string, "reason": non-empty string} entries — got ${JSON.stringify(value)}`,
    )
  }
  const files = new Set()
  for (const entry of value) {
    const okShape =
      entry !== null &&
      typeof entry === 'object' &&
      typeof entry.file === 'string' &&
      typeof entry.reason === 'string' &&
      entry.reason.trim().length > 0
    if (!okShape) {
      fail(
        GATE,
        `${MANIFEST}: every ${label} entry must be {"file": string, "reason": non-empty string} — got ${JSON.stringify(entry)}`,
      )
    }
    files.add(entry.file)
  }
  return files
}
const allowFiles = parseAllowEntries(manifest.allow, 'allow')

// ---- 5b setup: primitive boundary — controls render through the primitives -----
// Content-conditional on `controlPrimitives`, NOT version-ramped: this manifest
// is SEEDED, so `update` never rewrites it and the key arrives only by a
// deliberate human pull. A keyless manifest self-disables with the adoption
// NOTE; a malformed key fails closed.
let control = null
if (manifest.controlPrimitives !== undefined) {
  const cp = manifest.controlPrimitives
  const okShape =
    cp !== null &&
    typeof cp === 'object' &&
    Array.isArray(cp.tags) &&
    cp.tags.length > 0 &&
    cp.tags.every((t) => typeof t === 'string' && /^[A-Z][A-Za-z0-9]*$/.test(t)) &&
    typeof cp.home === 'string' &&
    cp.home.trim() !== ''
  if (!okShape) {
    fail(
      GATE,
      `${MANIFEST} controlPrimitives must be { "tags": non-empty array of component names, "home": non-empty string } — got ${JSON.stringify(cp)}; the primitive-boundary scan cannot silently disarm`,
    )
  }
  control = { tags: cp.tags, home: cp.home.replace(/\/+$/, '') }
} else {
  console.log(
    `${GATE}: NOTE — ${MANIFEST} has no "controlPrimitives" key, so the primitive-boundary scan is OFF (a raw <Pressable|TextInput … style=…> outside the primitives home would not red). Current manifests declare controlPrimitives: { "tags": ["Pressable","TouchableOpacity","TouchableHighlight","TouchableWithoutFeedback","TextInput","Button","Switch"], "home": "apps/mobile/src/components" }. ${MANIFEST} is seeded — update never rewrites it; adopt deliberately with \`update --refresh-seeded ${MANIFEST}\` (see docs/runbooks/harness-upgrade.md, content-conditional checks)`,
  )
}
// controlAllow — the primitive-boundary escape hatch (same shape as `allow`,
// but a SEPARATE list: a hex/dimension allow entry never also waives raw
// controls). Entries must stay LIVE — a stale exemption is red below, so the
// list can only shrink to reality.
const controlAllowFiles = parseAllowEntries(manifest.controlAllow, 'controlAllow')
const controlAllowLive = new Set()

// The open-tag scan window runs from `<Tag` to the next `<` — the attributes
// plus any leading text child — so multi-line tags are covered without an AST,
// and `style` must be whitespace-preceded inside that window (it always is in
// a real open tag; this keeps prop names that merely END in "style" out).
// Because the scan runs over comment-BLANKED text, a commented-out tag no
// longer matches (an over-match class the desktop scan carried; blanking
// removed it). A `<` inside an attribute expression (a comparison) ends the
// window early and under-detects that one tag, never a whole file.
const CONTROL_RE =
  control === null
    ? null
    : new RegExp(`<(${control.tags.join('|')})(?=[\\s/>])[^<]*?\\sstyle\\s*=`, 'g')
const CONTROL_PRIMITIVE = new Map([
  ['Pressable', 'the Button primitive'],
  ['TouchableOpacity', 'the Button primitive'],
  ['TextInput', 'the Input primitive'],
])

// ---- 5c setup: status surfaces must carry the status COLOUR channel ------------
// A near-monochrome system with one accent is a deliberate aesthetic — but on
// the desktop original it once made the failure toast pixel-identical to the
// confirmation toast, so the only thing separating "your write was lost" from
// "your write landed" was the prose inside it. Colour is not allowed to be the
// ONLY channel (these surfaces keep their text + role), but it must be A
// channel. Content-conditional like controlPrimitives: a keyless manifest
// self-disables with an adoption NOTE, a malformed key fails CLOSED, and stale
// allow entries are red so the escape list can only shrink to reality.
let status = null
if (manifest.statusSurfaces !== undefined) {
  const ss = manifest.statusSurfaces
  const okShape =
    ss !== null &&
    typeof ss === 'object' &&
    Array.isArray(ss.tokens) &&
    ss.tokens.length > 0 &&
    ss.tokens.every((t) => typeof t === 'string' && /^[a-z][a-z0-9-]*$/.test(t)) &&
    Array.isArray(ss.signals) &&
    ss.signals.length > 0 &&
    ss.signals.every((s) => typeof s === 'string' && s.trim() !== '') &&
    (ss.allow === undefined || Array.isArray(ss.allow))
  if (!okShape) {
    fail(
      GATE,
      `${MANIFEST} statusSurfaces must be { "tokens": non-empty array of token names, "signals": non-empty array of source markers, "allow": array } — got ${JSON.stringify(ss)}; the status-channel scan cannot silently disarm`,
    )
  }
  // Every declared status token must actually EXIST in the vocabulary, or the
  // scan could be satisfied by a name no palette carries (undefined paints
  // nothing — worse than no colour at all).
  for (const t of ss.tokens) {
    if (!manifest.tokens.includes(t)) {
      fail(
        GATE,
        `${MANIFEST} statusSurfaces.tokens names "${t}", which is not in tokens[] — a status reference to an undeclared token paints NOTHING`,
      )
    }
  }
  status = {
    tokens: ss.tokens,
    // A source marker is matched literally — role="alert" / aria-invalid — so
    // the signal list stays reviewable data, not a regex an agent can weaken.
    signals: ss.signals,
    allowFiles: parseAllowEntries(ss.allow, 'statusSurfaces.allow'),
    live: new Set(),
    // A status token counts as carried when referenced as a palette member
    // (palette.danger / palette['danger']) or as a quoted name — the AppText
    // variant names equal the token names by design, so variant="danger" is a
    // real use of the danger ink.
    use: new RegExp(`['"\`.](${ss.tokens.join('|')})\\b`),
  }
} else {
  console.log(
    `${GATE}: NOTE — ${MANIFEST} has no "statusSurfaces" key, so the status-channel scan is OFF (an error surface that looks exactly like a neutral one would not red). Current manifests declare statusSurfaces: { "tokens": ["danger","success"], "signals": ["role=\\"alert\\"","role=\\"status\\"","aria-invalid"], "dir": "${SRC_DIR}", "allow": [] } and the matching danger/success tokens in every theme. ${MANIFEST} is seeded — update never rewrites it; adopt deliberately with \`update --refresh-seeded ${MANIFEST}\` (see docs/runbooks/harness-upgrade.md, content-conditional checks)`,
  )
}

// ---- 5d/5e/5f setup: motion discipline, elevation keys, the hit-target floor ---
// All content-conditional like controlPrimitives (the manifest is SEEDED): each
// absent key/family self-disables — the combined design-depth NOTE below names
// what is off — and a present-but-malformed key fails CLOSED.
let motionSeam = null
if (manifest.motionSeam !== undefined) {
  if (typeof manifest.motionSeam !== 'string' || manifest.motionSeam.trim() === '') {
    fail(
      GATE,
      `${MANIFEST} motionSeam must be a non-empty file path — got ${JSON.stringify(manifest.motionSeam)}; the motion-discipline scan cannot silently disarm`,
    )
  }
  motionSeam = manifest.motionSeam
  if (!existsSync(motionSeam)) {
    errs.push(
      `${MANIFEST} motionSeam names "${motionSeam}" but the file does not exist — the one animation door is gone; restore it or update the manifest in review`,
    )
  }
}
const elevationArmed = manifest.families?.elevation !== undefined
const sizingArmed = manifest.families?.sizing !== undefined

// The touchable BASE: when declared, the pressable-class tags may be styled in
// exactly ONE home file (pressed feedback, the hit target, and haptics live
// there) — a second raw pressable primitive inside the home is a fork.
let controlBase = null
if (control !== null && manifest.controlPrimitives.base !== undefined) {
  const b = manifest.controlPrimitives.base
  const okShape =
    b !== null &&
    typeof b === 'object' &&
    typeof b.file === 'string' &&
    b.file.trim() !== '' &&
    Array.isArray(b.tags) &&
    b.tags.length > 0 &&
    b.tags.every((t) => typeof t === 'string' && control.tags.includes(t))
  if (!okShape) {
    fail(
      GATE,
      `${MANIFEST} controlPrimitives.base must be { "file": non-empty string, "tags": non-empty subset of controlPrimitives.tags } — got ${JSON.stringify(b)}; the touchable-base scan cannot silently disarm`,
    )
  }
  if (!existsSync(b.file)) {
    errs.push(
      `${MANIFEST} controlPrimitives.base names "${b.file}" but the file does not exist — the touchable base is gone; restore it or update the manifest in review`,
    )
  }
  controlBase = {
    file: b.file,
    re: new RegExp(`<(${b.tags.join('|')})(?=[\\s/>])[^<]*?\\sstyle\\s*=`, 'g'),
  }
}

const depthOff = [
  motionSeam === null &&
    'motionSeam (raw Animated/LayoutAnimation/Easing and literal duration:/delay: values would not red)',
  !elevationArmed && 'families.elevation (raw shadow*/elevation style keys would not red)',
  !sizingArmed &&
    'families.sizing (a styled raw control below the 44dp hit-target floor would not red)',
  control !== null &&
    controlBase === null &&
    'controlPrimitives.base (a second raw pressable primitive in the home would not red)',
].filter(Boolean)
if (depthOff.length > 0) {
  console.log(
    `${GATE}: NOTE — design-depth checks OFF: ${depthOff.join('; ')}. Current manifests declare motionSeam: "apps/mobile/src/lib/motion.ts", the motion/elevation/sizing families, and controlPrimitives.base: { "file": "apps/mobile/src/components/PressableScale.tsx", "tags": [pressable-class tags] }. ${MANIFEST} is seeded — update never rewrites it; adopt deliberately with \`update --refresh-seeded ${MANIFEST}\` (see docs/runbooks/harness-upgrade.md, content-conditional checks)`,
  )
}

// (5d) Literal motion values: the duration/delay vocabulary lives in the motion
// tokens — a numeric literal is an off-vocabulary animation (0 passes, like the
// dimension scan: it is the absence of motion). (5e) The shadow/elevation style
// keys are spelled ONLY inside the generated tokens module (src/theme, outside
// the walk) — consumers spread elevation levels. (motion-API references are the
// seam ban below: seam file + components home only, NO allow escape — a legit
// new animation site belongs in one of them by doctrine.)
const MOTION_LITERAL = /\b(duration|delay)\s*:\s*(\d+(?:\.\d+)?)\s*(?=[,};)\n])/g
const MOTION_API = /\b(Animated|LayoutAnimation|Easing)\s*\./g
const ELEVATION_KEY = /\b(shadowColor|shadowOffset|shadowOpacity|shadowRadius|elevation)\s*:/g

// ---- 5: source-scan patterns ---------------------------------------------------
// (a1) A string literal that IS a hex color — no other meaning in app code, so
// it reds anywhere in a scanned file. (a2) Functional color syntax (a digit or
// % after the paren keeps prose like "rgb (" out). (a3) CSS named colors, but
// ONLY as the value of a color-valued key/prop: bare color words are everyday
// prose everywhere else. RN accepts the CSS named-color set.
const HEX_STRING = /(['"`])#[0-9a-fA-F]{3,8}\1/g
const COLOR_FN = /\b(rgba?|hsla?)\(\s*[\d.%]/g
const COLOR_KEY = /\b([A-Za-z_$][\w$]*Color|color)\s*[:=]\s*\{?\s*(['"])([A-Za-z]+)\2/g
const CSS_NAMED_COLORS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue ' +
    'blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk ' +
    'crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki ' +
    'darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen ' +
    'darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue ' +
    'dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite ' +
    'gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
    'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
    'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen ' +
    'lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen ' +
    'magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen ' +
    'mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream ' +
    'mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid ' +
    'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum ' +
    'powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown ' +
    'seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen ' +
    'steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'
  ).split(' '),
)
// (b) Dimension keys whose value may never be a bare numeric literal. The
// lookahead requires the number to BE the whole value (next comes , } ; or a
// newline), so token arithmetic written number-first (2 * spacing) passes too.
const DIMENSION_KEYS =
  'fontSize|lineHeight|gap|rowGap|columnGap|border(?:Top|Bottom)?(?:Left|Right|Start|End)?Radius|' +
  'padding(?:Top|Bottom|Left|Right|Start|End|Horizontal|Vertical)?|' +
  'margin(?:Top|Bottom|Left|Right|Start|End|Horizontal|Vertical)?'
const DIMENSION_LITERAL = new RegExp(
  `\\b(${DIMENSION_KEYS})\\s*:\\s*(\\d+(?:\\.\\d+)?)\\s*(?=[,};)\\n])`,
  'g',
)
const DIMENSION_KEY_ONLY = new RegExp(`^(?:${DIMENSION_KEYS})$`)
// (c) An inline style object: any `*style/*Style={{ … }}` prop. Numeric values
// inside it red for EVERY key (width: 13 is as off-scale as padding: 13);
// dimension keys are skipped here because (b) already reported them.
const INLINE_STYLE_PROP = /([A-Za-z_$][\w$]*)\s*=\s*\{\s*\{/g
const INLINE_NUMERIC = /([A-Za-z_$][\w$]*)\s*:\s*(-?\d+(?:\.\d+)?)\s*(?=[,}\n])/g

// (6) Accent-token references: palette member access (.accent / ['accent']).
// Declarations in the tokens module do not count — src/theme is outside the walk.
const accentNames = (manifest.accentTokens ?? []).join('|')
const accentPattern =
  accentNames === ''
    ? null
    : new RegExp(`(?:\\.(?:${accentNames})\\b|\\[['"](?:${accentNames})['"]\\])`, 'g')

// ---- the walk: apps/mobile/{src,app}, minus src/theme, minus test files --------
const scanFilter = (p) => /\.(tsx|ts)$/.test(p) && !/\.(test|spec)\.tsx?$/.test(p)
const excludeDirs = new Set(['node_modules'])
const files = [
  ...walkFiles(SRC_DIR, { excludeDirs, filter: scanFilter })
    .filter((rel) => !rel.startsWith('theme/'))
    .map((rel) => `${SRC_DIR}/${rel}`),
  ...walkFiles(APP_DIR, { excludeDirs, filter: scanFilter }).map((rel) => `${APP_DIR}/${rel}`),
]

const componentsHome = control === null ? `${SRC_DIR}/components` : control.home
let accentUses = 0
const usesByFile = []

for (const rel of files) {
  const text = readFileSync(rel, 'utf8')
  const code = blankComments(text)
  const allowed = allowFiles.has(rel)
  const isTsx = /\.tsx$/.test(rel)

  if (!allowed) {
    for (const m of code.matchAll(HEX_STRING)) {
      errs.push(
        `${rel}: raw hex color ${m[0]} — colors exist only as ${MANIFEST} tokens compiled into ${TOKENS_MODULE}; take them from the palette (useThemedStyles/usePalette)`,
      )
    }
    for (const m of code.matchAll(COLOR_FN)) {
      errs.push(
        `${rel}: raw ${m[1]}() color — colors exist only as ${MANIFEST} tokens compiled into ${TOKENS_MODULE}; take them from the palette (useThemedStyles/usePalette)`,
      )
    }
    for (const m of code.matchAll(COLOR_KEY)) {
      const value = m[3].toLowerCase()
      if (value !== 'transparent' && CSS_NAMED_COLORS.has(value)) {
        errs.push(
          `${rel}: named color "${m[3]}" on ${m[1]} — colors exist only as ${MANIFEST} tokens; take them from the palette ('transparent' is the one allowed keyword: it is the absence of paint)`,
        )
      }
    }
    for (const m of code.matchAll(DIMENSION_LITERAL)) {
      if (Number(m[2]) !== 0) {
        errs.push(
          `${rel}: raw dimension "${m[1]}: ${m[2]}" — the scales live in ${TOKENS_MODULE} (typeScale/spacing/radius); write token multiples (spacing * 2), or add a reviewed allow entry in ${MANIFEST}`,
        )
      }
    }
    // (5d) literal motion values — durations/delays come from the motion tokens.
    if (motionSeam !== null) {
      for (const m of code.matchAll(MOTION_LITERAL)) {
        if (Number(m[2]) !== 0) {
          errs.push(
            `${rel}: literal motion value "${m[1]}: ${m[2]}" — the motion vocabulary lives in ${TOKENS_MODULE} (motion.duration.*); use a token (duration: motion.duration.base), or add a reviewed allow entry in ${MANIFEST}`,
          )
        }
      }
    }
    // (5e) shadow/elevation style keys — spelled only inside the generated
    // tokens module; consumers spread an elevation level.
    if (elevationArmed) {
      for (const m of code.matchAll(ELEVATION_KEY)) {
        errs.push(
          `${rel}: raw elevation key "${m[1]}:" — depth is a token: spread a level from ${TOKENS_MODULE} ({ ...elevation.raised }), or add a reviewed allow entry in ${MANIFEST}`,
        )
      }
    }
    // (c) inline style objects, outside the components home only: primitives may
    // merge a caller-supplied style, but a screen styles through factories.
    if (isTsx && !rel.startsWith(`${componentsHome}/`)) {
      for (const m of code.matchAll(INLINE_STYLE_PROP)) {
        if (!/[sS]tyle$/.test(m[1])) continue
        const open = m.index + m[0].length - 1
        const objText = code.slice(open, skipBalanced(code, open))
        for (const v of objText.matchAll(INLINE_NUMERIC)) {
          if (Number(v[2]) === 0 || DIMENSION_KEY_ONLY.test(v[1])) continue
          errs.push(
            `${rel}: inline ${m[1]}={{ ${v[1]}: ${v[2]} }} — raw values in an inline style object; build the style in a useThemedStyles factory from the tokens, or add a reviewed allow entry in ${MANIFEST}`,
          )
        }
      }
    }
  }

  // ---- 5d seam ban: motion APIs live in the seam + the components home only.
  // No allow escape: a legitimate new animation site belongs in one of them by
  // doctrine — the reduce-motion collapse and the token vocabulary both live in
  // the seam's hooks, and a raw Animated call site would carry neither.
  if (
    motionSeam !== null &&
    rel !== motionSeam &&
    !rel.startsWith(`${componentsHome}/`) &&
    !rel.startsWith('theme/')
  ) {
    for (const m of code.matchAll(MOTION_API)) {
      errs.push(
        `${rel}: raw ${m[1]}. reference outside the motion seam — animation goes through ${motionSeam} (useEntrance/usePulse/usePressScale: motion tokens + the reduce-motion collapse) or a primitive in ${componentsHome}`,
      )
    }
  }

  // ---- 5b-home: inside the primitives home, the touchable base owns the
  // pressable tags, and any file styling a raw control must meet the
  // hit-target floor in its own style.
  if (CONTROL_RE !== null && isTsx && rel.startsWith(`${control.home}/`)) {
    const styledControls = [...code.matchAll(CONTROL_RE)]
    if (styledControls.length > 0) {
      if (controlBase !== null && rel !== controlBase.file) {
        for (const m of code.matchAll(controlBase.re)) {
          errs.push(
            `${rel}: raw <${m[1]} …> styled outside the touchable base — pressed feedback, the hit target, and the haptic all live in ${controlBase.file}; render through it, or move this control's styling INTO the base`,
          )
        }
      }
      if (sizingArmed && !/\bminTarget\b/.test(code)) {
        errs.push(
          `${rel}: styles a raw control but never references sizes.minTarget — every touchable meets the 44dp floor in its own style: add minHeight: sizes.minTarget, or render through the touchable base`,
        )
      }
    }
  }

  // ---- 5b: primitive boundary — .tsx only (JSX open tags), home dir exempt ----
  if (CONTROL_RE !== null && isTsx && !rel.startsWith(`${control.home}/`)) {
    const hits = [...code.matchAll(CONTROL_RE)]
    if (hits.length > 0) {
      if (controlAllowFiles.has(rel)) {
        controlAllowLive.add(rel)
      } else {
        for (const m of hits) {
          const tag = m[1]
          const via =
            CONTROL_PRIMITIVE.get(tag) ?? `a dedicated ${tag} primitive (the Button/Input pattern)`
          errs.push(
            `${rel}: raw <${tag} …> carries a style prop outside ${control.home} — a hand-styled control forks the design system. FIX: render it through ${via} in ${control.home} (new control styling goes INTO the primitive), or add a reviewed controlAllow entry {"file": "${rel}", "reason": …} to ${MANIFEST}`,
          )
        }
      }
    }
  }

  // ---- 5c: status surfaces carry the colour channel — .tsx only ---------------
  // File-scoped by design: the component that RENDERS the status announcement
  // is the one that must colour it, and a per-element AST walk would be a
  // parser this gate deliberately does not carry. Signals are detected on the
  // RAW text (over-detection only ever demands colour — safe); the required
  // token reference is tested on comment-BLANKED code, so a token named only
  // in prose cannot satisfy it — the one direction a gate must never fail.
  if (status !== null && isTsx) {
    const announced = status.signals.filter((signal) => text.includes(signal))
    if (announced.length > 0 && !status.use.test(code)) {
      if (status.allowFiles.has(rel)) {
        status.live.add(rel)
      } else {
        errs.push(
          `${rel}: announces status (${announced.join(', ')}) but references no status token — an error surface that looks identical to a neutral one makes the user READ prose to find out whether they lost data. FIX: colour it with ${status.tokens.map((t) => `palette.${t}`).join('/')} (or an AppText variant carrying it) — the status hues are contrast-checked in every theme and do not count against the accent budget — or add a reviewed statusSurfaces.allow entry {"file": "${rel}", "reason": …} to ${MANIFEST}`,
        )
      }
    }
  }

  // ---- 6: accent usage budget -------------------------------------------------
  if (accentPattern !== null) {
    const count = (code.match(accentPattern) ?? []).length
    if (count > 0) {
      accentUses += count
      usesByFile.push(`${rel}: ${count}`)
    }
  }
}

// controlAllow entries must map to LIVE violations: an entry whose file is gone
// or no longer trips the scan is stale — red, so the exemption list can only
// shrink to reality.
if (control !== null) {
  for (const file of [...controlAllowFiles].sort()) {
    if (!existsSync(file)) {
      errs.push(
        `${MANIFEST} controlAllow exempts "${file}" but the file does not exist — stale entry; remove it`,
      )
    } else if (!controlAllowLive.has(file)) {
      errs.push(
        `${MANIFEST} controlAllow exempts "${file}" but no raw <${control.tags.join('|')} … style=…> matches there anymore (or it is not a scanned .tsx under apps/mobile/{src,app} outside ${control.home}) — stale entry; remove it`,
      )
    }
  }
}

// statusSurfaces.allow entries must map to LIVE violations too — same doctrine:
// the escape list can only shrink toward reality, never outlive what it excused.
if (status !== null) {
  for (const file of [...status.allowFiles].sort()) {
    if (!existsSync(file)) {
      errs.push(
        `${MANIFEST} statusSurfaces.allow exempts "${file}" but the file does not exist — stale entry; remove it`,
      )
    } else if (!status.live.has(file)) {
      errs.push(
        `${MANIFEST} statusSurfaces.allow exempts "${file}" but it no longer announces status without a status token (it now carries one, or the signal is gone) — stale entry; remove it`,
      )
    }
  }
}

if (accentPattern !== null && accentUses > manifest.accentUsageBudget) {
  errs.push(
    `accent tokens referenced ${accentUses}× (budget ${manifest.accentUsageBudget}) — the single-accent design dies by a thousand highlights. Remove uses, or raise the budget in ${MANIFEST} as a reviewed decision.\n    ${usesByFile.join('\n    ')}`,
  )
}

failures(GATE, errs)
const themeCount = Object.keys(manifest.themes).length
const contrastNote = Array.isArray(manifest.contrast)
  ? `; ${manifest.contrast.length} contrast pair(s) computed-green across ${themeCount} theme(s)`
  : ''
const controlNote =
  control === null
    ? ''
    : `; primitive boundary held (<${control.tags.join('|')}> styled only under ${control.home})`
const statusNote =
  status === null
    ? ''
    : `; every status surface (${status.signals.join(', ')}) carries a ${status.tokens.join('/')} token`
const depthNote = [
  motionSeam === null ? '' : `; motion through the seam (${motionSeam}) + motion tokens only`,
  elevationArmed ? '; elevation spread from tokens' : '',
  sizingArmed && control !== null ? '; styled raw controls meet minTarget' : '',
  controlBase === null ? '' : `; pressable tags based in ${controlBase.file}`,
].join('')
ok(
  GATE,
  `${documented.size} tokens × ${themeCount} theme(s) in lockstep with ${TOKENS_MODULE} (regen-diff clean); no raw color/dimension/inline-style escapes; accent ${accentUses}/${manifest.accentUsageBudget}${contrastNote}${controlNote}${statusNote}${depthNote}`,
)
