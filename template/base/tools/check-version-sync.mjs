#!/usr/bin/env node
// Gate: version-sync — root+mobile in lockstep, apps/web on an independent cadence,
// SDK-lockstep tools pinned exactly.
//   1. root package.json and apps/mobile versions move in LOCKSTEP, AND the RESOLVED
//      expo config agrees: `expo config --json --type public` is what a build actually
//      ships, so the gate re-computes app.config.ts's derivation formulas
//      (ios.buildNumber = pkg.version; android.versionCode = maj*1e6 + min*1e3 + pat)
//      and asserts the resolved config equals them — a consumer replacing the
//      derivation with literals goes red on the next bump, not at store review.
//      The skew middleware compares x-client-version majors, so a drifted manifest
//      would make the mobile client lie about itself.
//   1a. apps/web is DELIBERATELY excluded from the lockstep set: it ships on Vercel's
//      push-to-main cadence (~minutes), ~1000x the store cadence (~weeks), so coupling
//      the two would force a web hotfix to either cut a store submission or red this
//      gate. Web's independence is bounded instead by a MAJOR-agreement check: web's
//      major must equal @app/api's, because the tRPC skew middleware rejects an
//      x-client-version MAJOR mismatch — a web deploy that crosses a major the router
//      has not is a breaking client. Minor/patch cadence stays free.
//   2. runtimeVersion.policy stays 'appVersion' — the OTA compatibility boundary is
//      PR-reviewable exactly because it is derived from the same version surface
//      (the fingerprint policy was considered and rejected; see the design record).
//   3. .nvmrc / .node-version / engines.node agree on the Node major, and eas.json
//      build.base pins the SAME Node major plus the EXACT pnpm from packageManager —
//      EAS ignores package.json packageManager entirely, so the eas.json fields are
//      the only pin a cloud build obeys (design record: EXPO-FACTS, eas.json).
//      0.7.0 adds the iOS BUILD-TOOLCHAIN floor over the same file: the production
//      profile's ios.image, resolved through the `extends` chain, must be a CONCRETE
//      name whose -xcode-<major> meets the reviewed tools/store-policy.json floor
//      (Xcode 26, in force since 2026-04-28); auto/latest/sdk-NN/absent red as
//      unverifiable, ramped for pre-0.7.0 installs until 0.8.0.
//   4. expo / expo-router / react-native / babel-preset-expo are
//      EXACT-pinned in the catalog: since SDK 55 the expo-* majors ride the SDK in
//      lockstep and `expo install --check` (the native-deps gate) expects the bundled
//      pins verbatim — a caret or tilde on any of them flaps regenerate-and-diff
//      gates repo-wide (Renovate bumps them deliberately).
//   5. zod resolves to exactly one version across the workspace (two instances break
//      instanceof checks in the tRPC/zod input parsers with incomprehensible errors)
//   6. react resolves to exactly one version WITHIN each surface's graph. Unlike zod
//      (one version workspace-wide), React is split ON PURPOSE — apps/web tracks Next's
//      floor while apps/mobile stays on Expo's bundled pin, and the two never share a
//      process (separate Next/Metro bundles), so two versions ACROSS surfaces is correct.
//      Two React copies in ONE bundle break the hooks dispatcher, so the walk is scoped
//      per workspace project: each project's own subtree must resolve exactly one react.
//   7. FRAMEWORK SECURITY FLOOR (0.5.0). Every version tools/framework-floor.json floors
//      — read from the RESOLVED pnpm-lock.yaml, not the catalog string, so a transitive
//      resolution below the floor reds too — is at or above the patched release for its
//      major line. Nothing else in the validate chain reds on a pinned dependency with a
//      published advisory, and the osv-scan lanes structurally cannot: the PR lane is
//      diff-aware (an already-shipped vulnerable pin is never "newly introduced") and the
//      full-tree lane is schedule-and-network bound. This half is clockless and offline;
//      whether the REVIEW is still fresh is the scheduled `floor-review` job's question.
// SOURCE: docs/harness/README.md (version-sync gate) [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'
import { judgeCcFloor } from './lib/cc-floor.mjs'
import { judgeFloor, parseLockVersions, reviewWindowProblems } from './lib/framework-floor.mjs'
import {
  commandFailureOutput,
  failures,
  inCI,
  ok,
  rampNote,
  runCmd,
  skipOrFail,
  stampGate,
} from './lib/gate.mjs'
import { STAMP_INPUTS } from './lib/stamp-inputs.mjs'

const GATE = 'version-sync'
const APP_CONFIG = 'apps/mobile/app.config.ts'
const EAS_JSON = 'apps/mobile/eas.json'
const FLOOR_PATH = 'tools/framework-floor.json'
const CC_FLOOR_PATH = 'tools/cc-floor.json'
const errs = []

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
if (!existsSync('package.json')) skipOrFail(GATE, 'no root package.json')

// Content-addressed local skip (declared inputs: lib/stamp-inputs.mjs). The verdict is
// a pure function of the version manifests, app.config.ts, eas.json, the node-version
// files, the catalog, and the resolved lockfile that determines both the installed zod
// graph and the expo CLI that resolves the config — so a warm run short-circuits here
// WITHOUT spawning `expo config` or `pnpm list -r`. CI always re-runs; recordGreen()
// below fires only on a clean pass.
const recordGreen = stampGate(GATE, STAMP_INPUTS[GATE])

const root = readJson('package.json')
// Root and apps/mobile move in lockstep because app.config.ts derives every store-facing
// number (ios.buildNumber, android.versionCode) from apps/mobile/package.json — a drift
// there desyncs the binary's identity from the release. apps/web is NOT in this set: it
// ships on Vercel's independent cadence (see the header, 1a), bounded only by the
// major-agreement check below.
const versions = { 'package.json': root.version }
if (existsSync('apps/mobile/package.json')) {
  versions['apps/mobile'] = readJson('apps/mobile/package.json').version
}
const distinct = new Set(Object.values(versions).filter(Boolean))
if (distinct.size > 1) {
  errs.push(
    `version drift: ${Object.entries(versions)
      .map(([k, v]) => `${k}=${v ?? 'MISSING'}`)
      .join(', ')} — bump them together (apps/web is excluded: independent Vercel cadence)`,
  )
}

// apps/web rides its own cadence, but the skew contract still binds it: the tRPC skew
// middleware rejects an x-client-version MAJOR mismatch, and @app/api is the router both
// surfaces speak. So web's MAJOR must track the API's MAJOR — a web deploy that crosses a
// major boundary the API has not is a breaking client. Minor/patch stay free. Both paths
// are existsSync-guarded so a scaffold missing either surface skips cleanly.
if (existsSync('apps/web/package.json') && existsSync('packages/api/package.json')) {
  const webVersion = String(readJson('apps/web/package.json').version ?? '')
  const apiVersion = String(readJson('packages/api/package.json').version ?? '')
  const webMajor = webVersion.split('.')[0]
  const apiMajor = apiVersion.split('.')[0]
  if (webMajor !== apiMajor) {
    errs.push(
      `apps/web major (${webVersion || 'MISSING'}) != @app/api major (${apiVersion || 'MISSING'}) — web deploys on its own cadence, but the x-client-version skew contract requires apps/web and the tRPC router (@app/api) to share a MAJOR; bump @app/api's major in lockstep with a breaking web release`,
    )
  }
}

// Node version agreement (major)
const majors = new Map()
if (existsSync('.nvmrc')) majors.set('.nvmrc', readFileSync('.nvmrc', 'utf8').trim())
if (existsSync('.node-version'))
  majors.set('.node-version', readFileSync('.node-version', 'utf8').trim())
if (root.engines?.node) majors.set('engines.node', root.engines.node)
const nodeMajors = new Set(
  [...majors.values()].map((v) => (v.match(/(\d+)/) ?? [])[1]).filter(Boolean),
)
if (nodeMajors.size > 1) {
  errs.push(
    `node version disagreement: ${[...majors.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`,
  )
}

// eas.json toolchain pins: the ONLY toolchain surface an EAS cloud build reads.
// build.base is the profile every other profile extends, so pinning there pins all.
// The iOS toolchain-floor findings collect separately: they ship behind their own
// 0.7.0 ramp (below) because every pre-0.7.0 install's SEEDED eas.json predates the pin.
const toolchainErrs = []
let toolchainSummary = ''
if (existsSync(EAS_JSON)) {
  const eas = readJson(EAS_JSON)
  const base = eas.build?.base ?? {}
  const easNodeMajor = (String(base.node ?? '').match(/(\d+)/) ?? [])[1]
  const fileMajor = (majors.get('.node-version')?.match(/(\d+)/) ?? [])[1]
  if (fileMajor === undefined) {
    errs.push(
      `.node-version is missing — ${EAS_JSON} build.base.node (${base.node ?? 'MISSING'}) has no local source of truth to agree with`,
    )
  } else if (easNodeMajor !== fileMajor) {
    errs.push(
      `${EAS_JSON} build.base.node=${base.node ?? 'MISSING'} does not share .node-version's major (${fileMajor}) — the cloud build would run a different Node than every local lane`,
    )
  }
  const pmVersion = (String(root.packageManager ?? '').match(/^pnpm@([0-9.]+)/) ?? [])[1]
  if (pmVersion === undefined) {
    errs.push(
      `root package.json packageManager (${root.packageManager ?? 'MISSING'}) is not a pnpm pin — the eas.json pnpm field must mirror it`,
    )
  } else if (base.pnpm !== pmVersion) {
    errs.push(
      `${EAS_JSON} build.base.pnpm=${base.pnpm ?? 'MISSING'} != packageManager's ${pmVersion} — EAS ignores packageManager, so the eas.json field IS the pin; keep them identical`,
    )
  }

  // ── the iOS BUILD-TOOLCHAIN floor (0.7.0) — static, offline, clockless ─────────
  // Apple has required uploads to build against Xcode 26 / iOS 26 SDK or later since
  // 2026-04-28 — a FIXED floor, not a moving "current SDK" requirement, and macOS is
  // excluded (design/CONFORMANCE-FACTS.md §3). The floor itself is REVIEWED DATA in
  // tools/store-policy.json (the enforcement-tiers version-sync row's Target discharges
  // through that record's key), and only a CONCRETE pinned image name is statically
  // checkable: `auto`, `latest`, `sdk-NN` and absent are unverifiable and must NOT read
  // as green — a check that passes an unpinned profile passes every profile.
  // SOURCE: https://developer.apple.com/news/upcoming-requirements/ (Xcode 26 / iOS 26
  // SDK upload floor) [corpus: harness/doctrine]
  const STORE_POLICY = 'tools/store-policy.json'
  const iosToolchain = existsSync(STORE_POLICY) ? readJson(STORE_POLICY).iosToolchain : undefined
  if (iosToolchain === undefined) {
    toolchainErrs.push(
      `${STORE_POLICY} carries no iosToolchain record while ${EAS_JSON} exists — the Xcode floor is a reviewed decision and the file is harness-owned, so a missing record is a stale or tampered tree, not a choice; restore it via \`npx next-expo-supabase-agent-harness update\``,
    )
  }
  // Resolve the production profile's ios.image through the `extends` chain: the profile
  // level wins, then each ancestor in turn. Cycle-guarded so a self-extending profile
  // terminates as "absent" instead of hanging the gate.
  let image
  const walked = new Set()
  let profileName = 'production'
  while (typeof profileName === 'string' && !walked.has(profileName)) {
    walked.add(profileName)
    const profile = eas.build?.[profileName]
    if (typeof profile !== 'object' || profile === null) break
    image = profile.ios?.image
    if (image !== undefined) break
    profileName = profile.extends
  }
  const floorLabel =
    iosToolchain === undefined
      ? 'the reviewed Xcode floor (tools/store-policy.json iosToolchain)'
      : `Xcode ${iosToolchain.xcodeFloor} / iOS ${iosToolchain.xcodeFloor} SDK or later since ${iosToolchain.inForceSince}`
  const xcodeMajor = /-xcode-(\d+)/.exec(String(image ?? ''))?.[1]
  if (image === undefined) {
    toolchainErrs.push(
      `${EAS_JSON} pins no ios.image on the production profile (nor anywhere up its extends chain) — no pin means nothing can red: Apple has required uploads to build against ${floorLabel}, and a too-old toolchain burns a whole build-and-submit cycle with no gate output. Pin a concrete image name carrying -xcode-<major> from EAS's published list (docs.expo.dev/build-reference/infrastructure)`,
    )
  } else if (xcodeMajor === undefined) {
    toolchainErrs.push(
      `${EAS_JSON} production ios.image is ${JSON.stringify(image)} — \`auto\`, \`latest\`, \`sdk-NN\` and any name without a literal \`-xcode-<major>\` are UNVERIFIABLE offline and must not read as green: an alias moves under the build, while ${floorLabel} is what the pin has to prove. Pin the concrete image name the alias resolves to today`,
    )
  } else if (iosToolchain !== undefined && Number(xcodeMajor) < iosToolchain.xcodeFloor) {
    toolchainErrs.push(
      `${EAS_JSON} production ios.image ${JSON.stringify(image)} builds with Xcode ${xcodeMajor}, below the floor of ${iosToolchain.xcodeFloor} — Apple has required uploads to build against Xcode ${iosToolchain.xcodeFloor} / iOS ${iosToolchain.xcodeFloor} SDK or later since ${iosToolchain.inForceSince} (${iosToolchain.source}); pin an image whose -xcode- major is >= ${iosToolchain.xcodeFloor}`,
    )
  } else if (toolchainErrs.length === 0) {
    toolchainSummary = `; production iOS image ${image} holds the xcode>=${iosToolchain.xcodeFloor} toolchain floor`
  }
}

// The 0.7.0 ramp over the toolchain floor. A pre-0.7.0 install's SEEDED eas.json cannot
// be rewritten by `update` (seeded files are the consumer's), so the floor arrives as
// dated NOTEs — the 0.7.0 migrations record's seededSourceFixes instruction carries the
// pin itself — and the escape ends at 0.8.0. The comment lives HERE and not inside the
// condition: scripts/check-ramp-ledger.mjs reads the line preceding `rampNote(` to decide
// whether the result is consumed, and a comment between `if (` and the call reads to it
// as a discarded result — a ramp that gates nothing.
if (toolchainErrs.length > 0) {
  if (rampNote(GATE, '0.7.0', 'the iOS build-toolchain floor over eas.json', { until: '0.8.0' })) {
    for (const e of toolchainErrs) console.log(`${GATE}: NOTE — (ramp) ${e}`)
  } else {
    errs.push(...toolchainErrs)
  }
}

// Exact pins for SDK-lockstep tools in the workspace catalog
const catalogPins = new Map()
if (existsSync('pnpm-workspace.yaml')) {
  const ws = readFileSync('pnpm-workspace.yaml', 'utf8')
  for (const tool of ['expo', 'expo-router', 'react-native', 'babel-preset-expo']) {
    const m = ws.match(new RegExp(`^\\s*['"]?${tool}['"]?:\\s*(\\S+)`, 'm'))
    if (m && /^[\^~]/.test(m[1])) {
      errs.push(
        `catalog pin for ${tool} is ${m[1]} — SDK-lockstep/major-churn tools must be EXACT-pinned (Renovate bumps them deliberately)`,
      )
    }
  }
  for (const m of ws.matchAll(/^ {2}'?([@a-z0-9][@a-z0-9/.-]*)'?:\s*([^\s#]+)/gm)) {
    catalogPins.set(m[1], m[2].replace(/^['"]|['"]$/g, ''))
  }
}

// ── the framework security floor (0.5.0) ───────────────────────────────────────
// Judged HERE rather than in a step of its own because it asks the same question this
// gate already asks — "is the version surface what it is supposed to be" — and because
// 0.5.0 adds no chain steps. It is deliberately CLOCKLESS and OFFLINE: same lockfile,
// same floor, same verdict on any machine on any day. The freshness of the review is the
// one time-dependent half and it rides the scheduled `floor-review` CI job instead.
//
// This runs BEFORE the node_modules skip below on purpose: it reads pnpm-lock.yaml, not
// the installed tree, so it must still red on a machine that has never run `pnpm install`.
if (existsSync(FLOOR_PATH)) {
  const haveLock = existsSync('pnpm-lock.yaml')
  const floorJson = readJson(FLOOR_PATH)
  const { problems, judged } = judgeFloor({
    floor: floorJson,
    resolved: haveLock ? parseLockVersions(readFileSync('pnpm-lock.yaml', 'utf8')) : new Map(),
    catalogPins,
    haveLock,
  })
  errs.push(...problems)
  // The review WINDOW, judged here and not by the scheduled job (0.6.0). Whether a review
  // has lapsed is a calendar question and rides `floor-review`; whether the reviewer was
  // entitled to that much runway is arithmetic over two committed dates, so it belongs in
  // the chain — and it is the only half that can red at the moment the window is written.
  // Without it, one edit to `reviewedUntil` retires the freshness control, and the only
  // check that would have objected is the one that edit just disarmed.
  errs.push(...reviewWindowProblems({ floor: floorJson }))
  // The committed-lockfile floor (0.9.0). The absent-lockfile NOTE this replaces claimed
  // "CI always has one" — false both ways: the shipped workflows run `pnpm install
  // --frozen-lockfile`, which HARD-FAILS with no committed lockfile (and 12 of the 14
  // quality-gate jobs die even earlier, at setup-node's `cache: pnpm` step), and two
  // fresh resolutions a day apart were measured 230 lock-lines and 8 package versions
  // apart — so an uncommitted lockfile is unpinned resolution AND a broken CI entry
  // step, not a narrowing of scope. Ramped for pre-0.9.0 installs (nothing ever told
  // them to commit one); the escape ends at 0.10.0. The comment lives HERE, above the
  // condition, for the ramp-ledger's consumed-result rule.
  if (!haveLock) {
    const lockErr = `pnpm-lock.yaml is absent — dependency resolution is unpinned (a fresh install resolves against the live registry, not the tree you reviewed), the framework floor's RESOLVED half judged ${String(judged)} catalog pin(s) only (a transitive resolution below a cited CVE floor needs the lockfile), and the shipped workflows' \`pnpm install --frozen-lockfile\` entry step hard-fails without it. Run \`pnpm install\` and commit pnpm-lock.yaml.`
    if (
      rampNote(
        GATE,
        '0.9.0',
        "the committed-lockfile floor over the scaffold's dependency resolution",
        { until: '0.10.0' },
      )
    ) {
      console.log(`${GATE}: NOTE — (ramp) ${lockErr}`)
    } else {
      errs.push(lockErr)
    }
  }
}

// ── 8. THE CLAUDE CODE FLOOR (0.6.0), clockless half ────────────────────────────
// Every framework this scaffold ships is held to a cited security floor. The tool doing the
// holding was held to nothing — and it is the one dependency whose compromise compromises
// every other control, since the enforcement layer IS `.claude/settings.json` plus hooks.
//
// This half is arithmetic over the file's own evidence: the scalar floor equals the newest
// `patched` among the advisories cited beside it, `setBy` names exactly the advisories that
// set it, every row carries an openable citation and a reason it is in THIS file, and the
// recommended floor covers every feature it claims. Deliberately clockless and offline, for
// the same reason the framework floor's version half is: freshness rides the scheduled
// `floor-review` job, where a lapsed review blocks a maintainer rather than a contributor.
if (existsSync(CC_FLOOR_PATH)) {
  const { problems, judged, derived } = judgeCcFloor({
    floor: readJson(CC_FLOOR_PATH),
    path: CC_FLOOR_PATH,
  })
  errs.push(...problems)
  if (problems.length === 0) {
    console.log(
      `${GATE}: the Claude Code floor is ${derived ?? 'unset'}, derived from ${String(judged)} cited advisor${judged === 1 ? 'y' : 'ies'}.`,
    )
  }
}

// The RESOLVED config half needs the expo CLI (an install); the static half above
// already ran, so report its reds before skipping honestly.
if (!existsSync('node_modules')) {
  failures(GATE, errs)
  skipOrFail(
    GATE,
    `node_modules absent — cannot resolve ${APP_CONFIG} through \`expo config\` (run \`pnpm install\`)`,
  )
}

// Derivation base: app.config.ts computes every store-facing number from
// apps/mobile/package.json, so the recompute starts there too.
const mobileVersion = versions['apps/mobile'] ?? root.version
const [major = 0, minor = 0, patch = 0] = String(mobileVersion).split('.').map(Number)
const expectedCode = major * 1_000_000 + minor * 1_000 + patch

// The maj*1e6 + min*1e3 + pat encoding is monotonic ONLY while minor and patch stay
// <= 999 — past that, versionCode collides with the next field and Play rejects the
// non-ascending build. app.config.ts's derivation comment promises this gate errs
// loudly as the bound approaches: a hard red past it, a loud runway NOTE from 900.
if (minor > 999 || patch > 999) {
  errs.push(
    `version ${mobileVersion}: minor/patch exceed 999 — the versionCode encoding (maj*1e6 + min*1e3 + pat) is no longer monotonic; cut a major/minor release instead of shipping a colliding versionCode`,
  )
} else if (minor >= 900 || patch >= 900) {
  console.log(
    `${GATE}: NOTE — version ${mobileVersion} is within ${Math.min(999 - minor, 999 - patch) + 1} bump(s) of the versionCode encoding bound (minor/patch <= 999). Plan the next major/minor now; past 999 the derivation stops ascending and Play rejects the build.`,
  )
}

let resolved
try {
  // --type public is the introspection surface a build ships (secrets stripped);
  // run from apps/mobile so the CLI resolves THIS app's config module. Package-
  // manager banners ("Scope: all N workspace projects") can precede the JSON on
  // some setups — parse from the first brace, exactly like the expo-policy gate.
  const out = runCmd('pnpm exec expo config --json --type public', { cwd: 'apps/mobile' })
  const start = out.indexOf('{')
  if (start === -1) throw new Error(`no JSON object in output:\n${out.slice(0, 300)}`)
  resolved = JSON.parse(out.slice(start))
} catch (e) {
  const detail = commandFailureOutput(e).slice(0, 300)
  failures(GATE, [
    `\`expo config --json --type public\` failed in apps/mobile — the resolved-config half of this gate cannot run: ${detail}`,
  ])
}

if (resolved.version !== mobileVersion) {
  errs.push(
    `resolved expo config version=${resolved.version ?? 'MISSING'} != apps/mobile/package.json ${mobileVersion} — ${APP_CONFIG} must derive \`version\` from package.json, never carry a literal`,
  )
}
if (resolved.ios?.buildNumber !== mobileVersion) {
  errs.push(
    `resolved ios.buildNumber=${resolved.ios?.buildNumber ?? 'MISSING'} != ${mobileVersion} — ${APP_CONFIG} derives buildNumber = pkg.version; restore the derivation`,
  )
}
if (resolved.android?.versionCode !== expectedCode) {
  errs.push(
    `resolved android.versionCode=${resolved.android?.versionCode ?? 'MISSING'} != ${expectedCode} (maj*1e6 + min*1e3 + pat of ${mobileVersion}) — ${APP_CONFIG} must keep the derivation formula`,
  )
}
if (resolved.runtimeVersion?.policy !== 'appVersion') {
  errs.push(
    `resolved runtimeVersion=${JSON.stringify(resolved.runtimeVersion) ?? 'MISSING'} — the policy must stay 'appVersion' (the PR-reviewable OTA boundary; the fingerprint policy was rejected in the design record)`,
  )
}

// Single zod instance across the workspace (requires an install; skip honestly without one).
// Scope: the APP module graph. The Expo/babel/jest build toolchain runs in its own
// process with its own module graph — the Expo CLI embeds a zod of its own deep in
// @expo/cli, and that copy can never `instanceof`-interact with the schemas the app
// and server share — so the walk deliberately does not descend into those subtrees.
// A second zod anywhere else (the contracts + tRPC router share one zod) still reds.
const BUILD_TOOL_SUBTREE = /^(?:expo(?:-|$)|@expo\/|jest-expo$|babel-|@babel\/|metro(?:-|$))/
try {
  const out = runCmd('pnpm list -r --depth Infinity zod --json')
  const found = new Set()
  ;(function collect(node) {
    if (Array.isArray(node)) return node.forEach(collect)
    if (node === null || typeof node !== 'object') return
    for (const deps of [node.dependencies, node.devDependencies]) {
      if (deps?.zod?.version) found.add(deps.zod.version)
      for (const [name, v] of Object.entries(deps ?? {})) {
        if (!BUILD_TOOL_SUBTREE.test(name)) collect(v)
      }
    }
  })(JSON.parse(out))
  if (found.size > 1) {
    errs.push(
      `zod resolves to ${found.size} versions (${[...found].join(', ')}) — catalog-pin it so exactly one instance exists (instanceof breaks otherwise)`,
    )
  }
} catch (e) {
  // A silent pass here would vacate the single-instance assert exactly where
  // it matters. Partial local installs may legitimately break `pnpm list`;
  // CI (full install) must never swallow it.
  if (inCI()) {
    errs.push(
      `pnpm list failed — cannot verify the single-zod-instance invariant: ${commandFailureOutput(e).slice(0, 300)}`,
    )
  } else {
    console.log(
      `${GATE}: NOTE — zod single-instance check skipped (pnpm list failed on this partial install; CI verifies it)`,
    )
  }
}

// Single React instance PER SURFACE (see header, item 6). React is deliberately split —
// apps/web pins its own 19.2.x (Next's floor), apps/mobile stays on Expo's bundled pin —
// and the two never share a process, so two versions ACROSS surfaces is CORRECT and must
// NOT red. The hazard is two React copies WITHIN one surface's bundle: a component and the
// renderer holding different `react` instances silently break the hooks dispatcher. So the
// walk scopes to each workspace PROJECT and reds only when a single project's own subtree
// resolves more than one react. Test/build tooling that runs out-of-bundle (jest/metro/
// babel + the test renderer) is exempt — its react never ships and may legitimately differ.
const REACT_TOOL_SUBTREE =
  /^(?:expo(?:-|$)|@expo\/|jest(?:-|$)|babel-|@babel\/|metro(?:-|$)|react-test-renderer$|@testing-library\/|react-native-css-interop$)/
try {
  const out = runCmd('pnpm list -r --depth Infinity react --json')
  const reactsIn = (node) => {
    const found = new Set()
    ;(function collect(n) {
      if (Array.isArray(n)) return n.forEach(collect)
      if (n === null || typeof n !== 'object') return
      for (const deps of [n.dependencies, n.devDependencies]) {
        if (deps?.react?.version) found.add(deps.react.version)
        for (const [name, v] of Object.entries(deps ?? {})) {
          if (!REACT_TOOL_SUBTREE.test(name)) collect(v)
        }
      }
    })(node)
    return found
  }
  const parsed = JSON.parse(out)
  const projects = Array.isArray(parsed) ? parsed : [parsed]
  const offenders = []
  for (const proj of projects) {
    const found = reactsIn(proj)
    if (found.size > 1) {
      offenders.push(
        `${proj.name ?? proj.path ?? 'a workspace project'} → ${[...found].join(', ')}`,
      )
    }
  }
  if (offenders.length) {
    errs.push(
      `react resolves to multiple versions within a single surface (${offenders.join('; ')}) — two React instances in one bundle break the hooks dispatcher; keep each surface on one react (a package rendering on both surfaces must not carry its own)`,
    )
  }
} catch (e) {
  // Same asymmetry as the zod walk: a partial local install may break `pnpm list`, but
  // CI (full install) must never swallow the single-instance assertion.
  if (inCI()) {
    errs.push(
      `pnpm list failed — cannot verify the single-React-instance invariant: ${commandFailureOutput(e).slice(0, 300)}`,
    )
  } else {
    console.log(
      `${GATE}: NOTE — react single-instance check skipped (pnpm list failed on this partial install; CI verifies it)`,
    )
  }
}

failures(GATE, errs)
recordGreen()
ok(
  GATE,
  `version ${root.version} in lockstep (buildNumber ${mobileVersion}, versionCode ${expectedCode}, runtimeVersion appVersion); node majors + eas.json toolchains agree; SDK tools exact-pinned; every floored framework at or above its security floor${toolchainSummary}`,
)
