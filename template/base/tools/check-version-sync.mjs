#!/usr/bin/env node
// Gate: version-sync — one version, everywhere, and SDK-lockstep tools pinned exactly.
//   1. root package.json / apps/server / apps/mobile versions match, AND the RESOLVED
//      expo config agrees: `expo config --json --type public` is what a build actually
//      ships, so the gate re-computes app.config.ts's derivation formulas
//      (ios.buildNumber = pkg.version; android.versionCode = maj*1e6 + min*1e3 + pat)
//      and asserts the resolved config equals them — a consumer replacing the
//      derivation with literals goes red on the next bump, not at store review.
//      The skew middleware compares x-client-version majors, so a drifted manifest
//      would make the mobile client lie about itself.
//   2. runtimeVersion.policy stays 'appVersion' — the OTA compatibility boundary is
//      PR-reviewable exactly because it is derived from the same version surface
//      (the fingerprint policy was considered and rejected; see the design record).
//   3. .nvmrc / .node-version / engines.node agree on the Node major, and eas.json
//      build.base pins the SAME Node major plus the EXACT pnpm from packageManager —
//      EAS ignores package.json packageManager entirely, so the eas.json fields are
//      the only pin a cloud build obeys (design record: EXPO-FACTS, eas.json).
//   4. expo / expo-router / react-native / babel-preset-expo / drizzle-kit are
//      EXACT-pinned in the catalog: since SDK 55 the expo-* majors ride the SDK in
//      lockstep and `expo install --check` (the native-deps gate) expects the bundled
//      pins verbatim — a caret or tilde on any of them flaps regenerate-and-diff
//      gates repo-wide (Renovate bumps them deliberately).
//   5. zod resolves to exactly one version across the workspace (two instances break
//      instanceof checks in @hono/zod-openapi with incomprehensible errors)
// SOURCE: docs/harness/README.md (version-sync gate) [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'
import { failures, inCI, ok, runCmd, skipOrFail, stampGate } from './lib/gate.mjs'
import { STAMP_INPUTS } from './lib/stamp-inputs.mjs'

const GATE = 'version-sync'
const APP_CONFIG = 'apps/mobile/app.config.ts'
const EAS_JSON = 'apps/mobile/eas.json'
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
const versions = { 'package.json': root.version }
for (const [label, path] of [
  ['apps/server', 'apps/server/package.json'],
  ['apps/mobile', 'apps/mobile/package.json'],
]) {
  if (existsSync(path)) versions[label] = readJson(path).version
}
const distinct = new Set(Object.values(versions).filter(Boolean))
if (distinct.size > 1) {
  errs.push(
    `version drift: ${Object.entries(versions)
      .map(([k, v]) => `${k}=${v ?? 'MISSING'}`)
      .join(', ')} — bump them together`,
  )
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
}

// Exact pins for SDK-lockstep tools in the workspace catalog
if (existsSync('pnpm-workspace.yaml')) {
  const ws = readFileSync('pnpm-workspace.yaml', 'utf8')
  for (const tool of ['expo', 'expo-router', 'react-native', 'babel-preset-expo', 'drizzle-kit']) {
    const m = ws.match(new RegExp(`^\\s*['"]?${tool}['"]?:\\s*(\\S+)`, 'm'))
    if (m && /^[\^~]/.test(m[1])) {
      errs.push(
        `catalog pin for ${tool} is ${m[1]} — SDK-lockstep/major-churn tools must be EXACT-pinned (Renovate bumps them deliberately)`,
      )
    }
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
  const detail = (e.stderr?.toString() ?? e.message).slice(0, 300)
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
// A second zod anywhere else (contracts/server/@hono interop) still reds.
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
      `pnpm list failed — cannot verify the single-zod-instance invariant: ${(e.stderr?.toString() ?? e.message).slice(0, 300)}`,
    )
  } else {
    console.log(
      `${GATE}: NOTE — zod single-instance check skipped (pnpm list failed on this partial install; CI verifies it)`,
    )
  }
}

failures(GATE, errs)
recordGreen()
ok(
  GATE,
  `version ${root.version} in lockstep (buildNumber ${mobileVersion}, versionCode ${expectedCode}, runtimeVersion appVersion); node majors + eas.json toolchains agree; SDK tools exact-pinned`,
)
