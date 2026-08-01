# PORT-SPEC — the ANCESTOR's port record (superseded)

> ⚠️ **Historical. This document does not describe this repository.** It is the
> design record for the port that produced the SIBLING harness
> [`expo-postgres-agent-harness`](https://github.com/BhodiSea/expo-postgres-agent-harness)
> — Tauri → Expo, over a Hono/Drizzle backend — and is kept because the
> surface-agnostic machinery it specifies was ported forward into this lineage
> unchanged. Everything it says about the BACKEND ("Backend unchanged: Hono +
> Drizzle", the 21-gate chain, the server app) is false here: this lineage runs
> Next.js 16 web + Expo mobile over one shared Supabase backend, with a 24-gate
> chain and no standalone server.
>
> **The design record for THIS repository's stack is
> [`W1-STACK-SPEC.md`](./W1-STACK-SPEC.md).** Read that one.

The design record for porting `tauri-postgres-agent-harness` (the "source
harness") to Expo (React Native) + EAS. This repo mirrors the source harness's
architecture: installer CLI + `template/base` machinery + `template/stack`
reference app + `template/modules` opt-ins, with the same three-layer
enforcement (Claude Code Stop hook → `pnpm validate` → CI) and the same
doctrine (frozen floor snapshot, canary red-proofs with gate↔canary lockstep,
skip-loudly-locally / fail-closed-in-CI, honest degrade when credentials are
absent).

## Locked decisions

- **Backend unchanged**: Hono + Drizzle + Postgres 16 FORCE RLS. The mobile
  client is a thin HTTPS client with a JWT — Postgres stays invisible to it.
- **Client**: Expo + CNG/prebuild (generated native dirs, never committed),
  Hermes, expo-router. New Architecture on.
- **E2E**: jest-expo + React Native Testing Library is the fast in-chain lane
  (seconds, laptop-complete); Maestro is the CI device lane (GH-hosted Android
  emulator; iOS nightly on macOS). The Stop chain contains no on-device proof —
  stated honestly in the gates catalog.
- **Versioning**: `app.config.ts` derives `version`, `ios.buildNumber`, and
  `android.versionCode` (maj·1e6 + min·1e3 + pat) from `package.json`;
  `eas.json` pins `appVersionSource: "local"`, `autoIncrement: false`.
  `runtimeVersion.policy = 'appVersion'`.
- **Styling**: plain `StyleSheet` on native + a generated tokens module. The
  `packages/design-tokens` TypeScript modules are the OKLCH source of truth;
  `packages/design-tokens/scripts/gen.mjs` emits the committed sRGB adapter
  (`src/generated/native.ts`) and the theme CSS; the styleguide/tokens gates
  regen-diff them.
- **Motion** (0.1.2): RN core `Animated` + manifest motion tokens
  (`families.motion` — durations/easings/pressScale as data), consumed through
  ONE seam (`src/lib/motion.ts`) whose hooks animate transform/opacity only
  (native-driver whitelist) and collapse to static under OS reduce-motion by
  construction. The styleguide gate bans raw `Animated`/`Easing`/
  `LayoutAnimation` references outside the seam + the components home, and
  literal `duration:`/`delay:` values everywhere — motion stays
  tokens-as-data, exactly like color.
- **Unit runners**: vitest (server, packages, pure mobile logic) + jest-expo
  (RN components/screens); diff-coverage merges both istanbul maps.
- **Orchestrator**: GitHub Actions, SHA-pinned + harden-runner. No selftest
  job touches EAS/Apple/Google credentials.

## Considered and rejected

- `runtimeVersion.policy = 'fingerprint'` — a computed hash is not
  PR-reviewable; revisit if OTA reach across store versions becomes a product
  requirement.
- EAS remote `autoIncrement` / `appVersionSource: "remote"` — moves a version
  surface into a database no gate can diff; breaks hermetic selftest.
- NativeWind / Unistyles — a compile layer (or a native styling runtime)
  between the styleguide manifest and the pixels defeats the tokens-as-data
  scannability the gate depends on.
- react-native-reanimated — the same class for motion: a Babel transform plus
  a native worklet runtime between the motion tokens and the pixels, when
  everything this tier of motion needs (press scale, entrance fade/slide,
  skeleton pulse) sits inside core `Animated`'s native-driver whitelist with
  zero added dependencies. Revisit only for gesture-driven surfaces
  (sheets/swipes), as an opt-in module.
- Maestro-on-EAS for the base e2e lane — requires credentials and puts a cloud
  build ahead of every e2e signal; consumers can opt in via a module.
- EAS Workflows as CI orchestrator — cannot be SHA-pinned, no harden-runner or
  zizmor/actionlint coverage; splits the audit surface.
- fastlane for store metadata — drags a Ruby toolchain into a two-toolchain
  repo; EAS Metadata (JSON in repo) covers the iOS half.
- react-native-sse — XHR-based extra dependency that bypasses the api-client
  one-door; the SSE client is a hand-rolled pure parser over `expo/fetch`
  streaming.

## Gate chain (target: 21 floor gates)

format, gate-integrity, types, lint, provenance, expo-policy, native-deps,
version-sync, prompts, licenses, schema-rls, migrations, contracts, dead-code,
architecture, build, styleguide, perf-budget, route-manifest, e2e, docs-sync.
Stop-chain adds: validate --report-all, rls-isolation, unit, mobile-unit,
diff-coverage, duplication, i18n, test-quality, mobile-perf --closure.

Replacements relative to the source harness: `tauri-policy` → `expo-policy`
(identity lock, ATS/cleartext, permissions/plugins allowlists, CNG purity,
secret-shaped `extra` ban, splash-color lockstep, eas.json sanity);
`rust-fmt`/`rust-check` → `native-deps` (`expo install --check`, CNG purity,
config-plugin allowlist + tests); `native-perf` → `mobile-perf --closure`
(route ↔ Maestro flow ↔ startup-budget triangle). Dropped: forced-colors e2e,
CDP memory spec (superseded by an agent-time jest-expo emitter-count spec).
