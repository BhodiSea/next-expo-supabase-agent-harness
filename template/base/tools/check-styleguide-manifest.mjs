#!/usr/bin/env node
// Gate: styleguide — the design system is DATA, and this gate keeps it honest.
//
// The token VALUES are owned by @app/design-tokens: the TypeScript modules in
// packages/design-tokens/src are the single source, and packages/design-tokens/
// scripts/gen.mjs compiles them (fail-closed on gamut + WCAG contrast, see
// render.ts::assertTokenContract) into the two committed platform adapters —
// src/generated/native.ts (the resolved RN theme apps/mobile consumes via
// @app/design-tokens/native) and src/generated/web.css (the Tailwind v4 @theme
// apps/web imports). This gate does NOT re-declare those values; it does two things:
//   1. REGEN-DIFF the package — `tsx packages/design-tokens/scripts/gen.mjs --check`.
//      One command re-asserts BOTH adapters byte-for-byte AND the gamut/contrast
//      contract (render() throws before emitting a byte), so a hand edit to a
//      generated file, or a retune that breaks readability, is a red gate. Needs an
//      install (tsx); skips loudly without one, fails closed in CI.
//   2. SOURCE-SCAN apps/mobile/{src,app} (outside src/theme) so no screen smuggles a
//      raw value past the vocabulary — the checks below. The token NAMES those checks
//      reference (accent budget, status colours) are read from the committed
//      native.ts palette, so the policy can never name a token no theme carries.
//
// tools/styleguide.manifest.json is now GATE POLICY, not token values: the accent
// budget, the status-surface signals, the primitive-boundary tags/home/base, the
// motion seam, and the reviewed allow lists. It is write-guard-protected and seeded —
// content-conditional keys self-disable with an adoption NOTE, a malformed key fails
// CLOSED.
//
// The scans, over apps/mobile/{src,app} minus src/theme (the app's own screens obey
// the same vocabulary as the primitives):
//   (a) raw color VALUES — hex literals anywhere; rgb()/rgba()/hsl()/hsla(); CSS
//       named colors on color-valued props/keys. 'transparent' is exempt.
//   (b) raw dimension literals in fontSize/lineHeight/gap/*Radius/padding*/margin*:
//       the scales live in @app/design-tokens (space/typeScale/radius) — write token
//       multiples, never offsets. A literal 0 passes; token arithmetic passes.
//   (c) inline style={{…}} object literals outside the components home: any raw
//       numeric (beyond 0) reds — screens style through useThemedStyles factories.
//   (5b) primitive boundary — a raw <Pressable|TextInput|… style=…> outside the
//        primitives home forks the design system (controlPrimitives; controlAllow is
//        the reviewed escape; the touchable base owns the pressable tags).
//   (5c) status surfaces — a role="alert"/role="status"/aria-invalid surface must
//        reference a status token (danger/success): failure and success must never be
//        the same pixel.
//   (5d) motion discipline — literal duration:/delay: numerics red; Animated./
//        LayoutAnimation./Easing. red outside the motion seam + the components home
//        (motion goes through the seam's hooks: tokens + the reduce-motion collapse).
//   (5e) elevation keys — shadow*/elevation are spelled ONLY inside the generated
//        native module; consumers spread a level ({ ...elevation.raised }).
//   (5f) hit-target floor — a home file that styles a raw control must reference
//        minTouchTarget (the 44dp floor @app/design-tokens exports): every touchable
//        meets it in its own style, or renders through the touchable base.
//   (6) accent budget — the near-monochrome single-accent design survives on a usage
//       BUDGET; accent-token references stay <= manifest.accentUsageBudget.
//
// Precision/recall: this is a REGEX scanner, not a TS parser — zero deps, over-
// detection reds (with reviewed allow escapes) rather than failing open. Comments are
// BLANKED first (tools/lib/source-text.mjs). Known blind spots, accepted: a style
// smuggled through spread props ({...props}) is not detected; a hex built by
// concatenation is not detected; a `<` inside an attribute expression ends a control-
// tag window early (under-detects that one tag, never a whole file).
// SOURCE: docs/harness/gates-catalog.md (styleguide gate) [corpus: harness/doctrine]
// SOURCE: react-native color props/style keys and the CSS named-color set
// https://reactnative.dev/docs/colors
import { existsSync, readFileSync } from 'node:fs'
import { walkFiles } from './lib/fs-walk.mjs'
import { fail, failures, inCI, ok, runCmd, skipOrFail } from './lib/gate.mjs'
import { blankComments, skipBalanced } from './lib/source-text.mjs'

const GATE = 'styleguide'
const MANIFEST = 'tools/styleguide.manifest.json'
// The committed RN adapter: its palette IS the token vocabulary, and the regen-diff
// below proves it fresh against the TypeScript source.
const NATIVE_MODULE = 'packages/design-tokens/src/generated/native.ts'
const GEN_SCRIPT = 'packages/design-tokens/scripts/gen.mjs'
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
    `${MANIFEST} is not valid JSON (${e.message}) — the design-policy contract must be reviewable data`,
  )
}
const errs = []

// ---- token vocabulary: the semantic token names, read from the committed adapter ----
// `palettes = { dark: { canvas: '#..', 'ink-muted': '#..', … }, light: {…} }`. The
// regen-diff proves these names match the TypeScript source, so policy that references
// a token here can never name one no theme carries. Absent adapter -> vocabulary null
// (the regen-diff leg reports its absence); vocabulary-dependent policy is then skipped.
function parseVocabulary(text) {
  const block = /export const palettes\s*=\s*\{[\s\S]*?\bdark\s*:\s*\{([\s\S]*?)\n\s*\}/.exec(text)
  if (block === null) return null
  const names = new Set()
  for (const m of block[1].matchAll(
    /(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*:\s*'#[0-9a-fA-F]{3,8}'/g,
  )) {
    names.add(m[1] ?? m[2])
  }
  return names.size > 0 ? names : null
}
const documented = existsSync(NATIVE_MODULE)
  ? parseVocabulary(readFileSync(NATIVE_MODULE, 'utf8'))
  : null

// ---- 1. regen-diff: the package's own gen:check (both adapters + the contract) ----
// render() asserts gamut + WCAG contrast before emitting a byte, so this single check
// covers native.ts, web.css, and the readability contract. Needs tsx (the source is
// TS): it runs when installed, notes LOUDLY (never silently) when it cannot, and FAILS
// CLOSED in CI — exactly like the contracts gate's inventory regen-diff. The source
// scan below runs regardless, so a local run without an install still catches raw
// values; only the regen-diff leg waits for the toolchain.
let regenRan = false
if (existsSync('node_modules')) {
  try {
    // --silent: pnpm's auto-install/verify banner would pollute the stream.
    runCmd(`pnpm --silent exec tsx ${GEN_SCRIPT} --check`)
  } catch (e) {
    const detail = [e.stdout, e.stderr].filter(Boolean).join('\n').trim() || e.message
    errs.push(
      `@app/design-tokens generated adapters drifted from the TypeScript source (regen-diff):\n    ${detail.split('\n').join('\n    ')}\n    run \`pnpm --filter @app/design-tokens run gen\`, then review the diff — the src/*.ts token modules are the source of truth; a hand edit to a generated file (or a retune that breaks the gamut/contrast contract) is a red gate, not a design change`,
    )
  }
  regenRan = true
} else if (inCI()) {
  // CI without an install is a broken lane, not a valid skip: fail closed.
  errs.push(
    `@app/design-tokens regen-diff could not run — node_modules is missing in CI. Install before validate (\`pnpm install\`); the regen-diff must run in CI.`,
  )
} else {
  // Loud local skip of ONE leg — never a silent pass. The scan below still runs.
  console.log(
    `${GATE}: NOTE — @app/design-tokens regen-diff SKIPPED locally (node_modules absent; run \`pnpm install\`, then \`pnpm --filter @app/design-tokens run gen\`). It FAILS CLOSED in CI. The source scan below still ran.`,
  )
}

// ---- policy: accent budget ----
if (manifest.accentTokens !== undefined) {
  if (
    !Array.isArray(manifest.accentTokens) ||
    !manifest.accentTokens.every((t) => typeof t === 'string' && /^[a-z][a-z0-9-]*$/.test(t))
  ) {
    fail(
      GATE,
      `${MANIFEST} accentTokens must be an array of token names — got ${JSON.stringify(manifest.accentTokens)}`,
    )
  }
  if (documented !== null) {
    for (const t of manifest.accentTokens) {
      if (!documented.has(t)) {
        errs.push(
          `${MANIFEST} accentTokens names "${t}", which is not a token in ${NATIVE_MODULE} — the accent budget would count a name no palette carries`,
        )
      }
    }
  }
}
if (
  manifest.accentUsageBudget !== undefined &&
  (typeof manifest.accentUsageBudget !== 'number' || manifest.accentUsageBudget < 0)
) {
  fail(
    GATE,
    `${MANIFEST} accentUsageBudget must be a non-negative number — got ${JSON.stringify(manifest.accentUsageBudget)}`,
  )
}

// ---- exemption lists: file-level, each with a reviewed reason; malformed = loud ----
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

// ---- 5b setup: primitive boundary — controls render through the primitives ---------
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
    `${GATE}: NOTE — ${MANIFEST} has no "controlPrimitives" key, so the primitive-boundary scan is OFF. Adopt deliberately with \`update --refresh-seeded ${MANIFEST}\` (see docs/runbooks/harness-upgrade.md, content-conditional checks)`,
  )
}
const controlAllowFiles = parseAllowEntries(manifest.controlAllow, 'controlAllow')
const controlAllowLive = new Set()

const CONTROL_RE =
  control === null
    ? null
    : new RegExp(`<(${control.tags.join('|')})(?=[\\s/>])[^<]*?\\sstyle\\s*=`, 'g')
const CONTROL_PRIMITIVE = new Map([
  ['Pressable', 'the Button primitive'],
  ['TouchableOpacity', 'the Button primitive'],
  ['TextInput', 'the Input primitive'],
])

// ---- 5c setup: status surfaces must carry the status COLOUR channel ----------------
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
  if (documented !== null) {
    for (const t of ss.tokens) {
      if (!documented.has(t)) {
        fail(
          GATE,
          `${MANIFEST} statusSurfaces.tokens names "${t}", which is not a token in ${NATIVE_MODULE} — a status reference to an undeclared token paints NOTHING`,
        )
      }
    }
  }
  status = {
    tokens: ss.tokens,
    signals: ss.signals,
    allowFiles: parseAllowEntries(ss.allow, 'statusSurfaces.allow'),
    live: new Set(),
    use: new RegExp(`['"\`.](${ss.tokens.join('|')})\\b`),
  }
} else {
  console.log(
    `${GATE}: NOTE — ${MANIFEST} has no "statusSurfaces" key, so the status-channel scan is OFF. Adopt deliberately with \`update --refresh-seeded ${MANIFEST}\` (see docs/runbooks/harness-upgrade.md, content-conditional checks)`,
  )
}

// ---- 5d setup: motion discipline (armed by motionSeam; elevation + sizing are now
// unconditional — @app/design-tokens always ships motion/elevation/minTouchTarget) ---
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

// The touchable BASE: when declared, the pressable-class tags may be styled in exactly
// ONE home file (pressed feedback, the hit target, and haptics live there).
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

if (motionSeam === null || (control !== null && controlBase === null)) {
  const off = [
    motionSeam === null &&
      'motionSeam (raw Animated/LayoutAnimation/Easing and literal duration:/delay: values would not red)',
    control !== null &&
      controlBase === null &&
      'controlPrimitives.base (a second raw pressable primitive in the home would not red)',
  ].filter(Boolean)
  console.log(
    `${GATE}: NOTE — design-depth checks OFF: ${off.join('; ')}. Adopt deliberately with \`update --refresh-seeded ${MANIFEST}\` (see docs/runbooks/harness-upgrade.md, content-conditional checks)`,
  )
}

const MOTION_LITERAL = /\b(duration|delay)\s*:\s*(\d+(?:\.\d+)?)\s*(?=[,};)\n])/g
const MOTION_API = /\b(Animated|LayoutAnimation|Easing)\s*\./g
const ELEVATION_KEY = /\b(shadowColor|shadowOffset|shadowOpacity|shadowRadius|elevation)\s*:/g

// ---- 5: source-scan patterns -------------------------------------------------------
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
const DIMENSION_KEYS =
  'fontSize|lineHeight|gap|rowGap|columnGap|border(?:Top|Bottom)?(?:Left|Right|Start|End)?Radius|' +
  'padding(?:Top|Bottom|Left|Right|Start|End|Horizontal|Vertical)?|' +
  'margin(?:Top|Bottom|Left|Right|Start|End|Horizontal|Vertical)?'
const DIMENSION_LITERAL = new RegExp(
  `\\b(${DIMENSION_KEYS})\\s*:\\s*(\\d+(?:\\.\\d+)?)\\s*(?=[,};)\\n])`,
  'g',
)
const DIMENSION_KEY_ONLY = new RegExp(`^(?:${DIMENSION_KEYS})$`)
const INLINE_STYLE_PROP = /([A-Za-z_$][\w$]*)\s*=\s*\{\s*\{/g
const INLINE_NUMERIC = /([A-Za-z_$][\w$]*)\s*:\s*(-?\d+(?:\.\d+)?)\s*(?=[,}\n])/g

// (6) Accent-token references: palette member access (.accent / ['accent']).
const accentNames = (manifest.accentTokens ?? []).join('|')
const accentPattern =
  accentNames === ''
    ? null
    : new RegExp(`(?:\\.(?:${accentNames})\\b|\\[['"](?:${accentNames})['"]\\])`, 'g')

// ---- the walk: apps/mobile/{src,app}, minus src/theme, minus test files ------------
const scanFilter = (p) => /\.(tsx|ts)$/.test(p) && !/\.(test|spec)\.tsx?$/.test(p)
const excludeDirs = new Set(['node_modules'])
const files = [
  ...walkFiles(SRC_DIR, { excludeDirs, filter: scanFilter })
    .filter((rel) => !rel.startsWith('theme/'))
    .map((rel) => `${SRC_DIR}/${rel}`),
  ...walkFiles(APP_DIR, { excludeDirs, filter: scanFilter }).map((rel) => `${APP_DIR}/${rel}`),
]

const componentsHome = control === null ? `${SRC_DIR}/components` : control.home
const VOCAB = '@app/design-tokens (space/typeScale/radius/palette via useThemedStyles/usePalette)'
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
        `${rel}: raw hex color ${m[0]} — colors exist only as ${VOCAB} tokens; take them from the palette`,
      )
    }
    for (const m of code.matchAll(COLOR_FN)) {
      errs.push(
        `${rel}: raw ${m[1]}() color — colors exist only as ${VOCAB} tokens; take them from the palette`,
      )
    }
    for (const m of code.matchAll(COLOR_KEY)) {
      const value = m[3].toLowerCase()
      if (value !== 'transparent' && CSS_NAMED_COLORS.has(value)) {
        errs.push(
          `${rel}: named color "${m[3]}" on ${m[1]} — colors exist only as ${VOCAB} tokens ('transparent' is the one allowed keyword: it is the absence of paint)`,
        )
      }
    }
    for (const m of code.matchAll(DIMENSION_LITERAL)) {
      if (Number(m[2]) !== 0) {
        errs.push(
          `${rel}: raw dimension "${m[1]}: ${m[2]}" — the scales live in ${VOCAB}; write token multiples (space[2]), or add a reviewed allow entry in ${MANIFEST}`,
        )
      }
    }
    if (motionSeam !== null) {
      for (const m of code.matchAll(MOTION_LITERAL)) {
        if (Number(m[2]) !== 0) {
          errs.push(
            `${rel}: literal motion value "${m[1]}: ${m[2]}" — the motion vocabulary lives in @app/design-tokens (motion.duration.*); use a token, or add a reviewed allow entry in ${MANIFEST}`,
          )
        }
      }
    }
    for (const m of code.matchAll(ELEVATION_KEY)) {
      errs.push(
        `${rel}: raw elevation key "${m[1]}:" — depth is a token: spread a level from @app/design-tokens ({ ...elevation.raised }), or add a reviewed allow entry in ${MANIFEST}`,
      )
    }
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

  // ---- 5d seam ban: motion APIs live in the seam + the components home only. --------
  if (
    motionSeam !== null &&
    rel !== motionSeam &&
    !rel.startsWith(`${componentsHome}/`) &&
    !rel.startsWith('theme/')
  ) {
    for (const m of code.matchAll(MOTION_API)) {
      errs.push(
        `${rel}: raw ${m[1]}. reference outside the motion seam — animation goes through ${motionSeam} (motion tokens + the reduce-motion collapse) or a primitive in ${componentsHome}`,
      )
    }
  }

  // ---- 5b-home: the touchable base owns the pressable tags; a home file styling a
  // raw control must meet the hit-target floor (minTouchTarget) in its own style. -----
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
      if (!/\bminTouchTarget\b/.test(code)) {
        errs.push(
          `${rel}: styles a raw control but never references minTouchTarget — every touchable meets the 44dp floor in its own style: add minHeight: minTouchTarget (from @app/design-tokens), or render through the touchable base`,
        )
      }
    }
  }

  // ---- 5b: primitive boundary — .tsx only (JSX open tags), home dir exempt ----------
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
            `${rel}: raw <${tag} …> carries a style prop outside ${control.home} — a hand-styled control forks the design system. FIX: render it through ${via} in ${control.home}, or add a reviewed controlAllow entry {"file": "${rel}", "reason": …} to ${MANIFEST}`,
          )
        }
      }
    }
  }

  // ---- 5c: status surfaces carry the colour channel — .tsx only ---------------------
  if (status !== null && isTsx) {
    const announced = status.signals.filter((signal) => text.includes(signal))
    if (announced.length > 0 && !status.use.test(code)) {
      if (status.allowFiles.has(rel)) {
        status.live.add(rel)
      } else {
        errs.push(
          `${rel}: announces status (${announced.join(', ')}) but references no status token — an error surface that looks identical to a neutral one makes the user READ prose to find out whether they lost data. FIX: colour it with ${status.tokens.map((t) => `palette.${t}`).join('/')} (or an AppText variant carrying it), or add a reviewed statusSurfaces.allow entry {"file": "${rel}", "reason": …} to ${MANIFEST}`,
        )
      }
    }
  }

  // ---- 6: accent usage budget -------------------------------------------------------
  if (accentPattern !== null) {
    const count = (code.match(accentPattern) ?? []).length
    if (count > 0) {
      accentUses += count
      usesByFile.push(`${rel}: ${count}`)
    }
  }
}

// controlAllow / statusSurfaces.allow entries must map to LIVE violations — a stale
// exemption is red, so the escape list can only shrink to reality.
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
if (status !== null) {
  for (const file of [...status.allowFiles].sort()) {
    if (!existsSync(file)) {
      errs.push(
        `${MANIFEST} statusSurfaces.allow exempts "${file}" but the file does not exist — stale entry; remove it`,
      )
    } else if (!status.live.has(file)) {
      errs.push(
        `${MANIFEST} statusSurfaces.allow exempts "${file}" but it no longer announces status without a status token — stale entry; remove it`,
      )
    }
  }
}

if (
  accentPattern !== null &&
  accentUses > (manifest.accentUsageBudget ?? Number.POSITIVE_INFINITY)
) {
  errs.push(
    `accent tokens referenced ${accentUses}× (budget ${manifest.accentUsageBudget}) — the single-accent design dies by a thousand highlights. Remove uses, or raise the budget in ${MANIFEST} as a reviewed decision.\n    ${usesByFile.join('\n    ')}`,
  )
}

failures(GATE, errs)
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
  '; elevation spread from tokens; styled raw controls meet minTouchTarget',
  controlBase === null ? '' : `; pressable tags based in ${controlBase.file}`,
].join('')
const vocabNote =
  documented === null
    ? 'vocabulary unread (adapter absent — regen leg will report)'
    : `${documented.size}-token vocabulary from ${NATIVE_MODULE}`
const regenNote = regenRan
  ? '@app/design-tokens regen-diff clean'
  : 'regen-diff skipped (local, no install — fails closed in CI)'
ok(
  GATE,
  `${vocabNote}; ${regenNote}; no raw color/dimension/inline-style escapes; accent ${accentUses}/${manifest.accentUsageBudget ?? '∞'}${controlNote}${statusNote}${depthNote}`,
)
