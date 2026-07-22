# EXPO-FACTS — verified platform facts the template and gates are written against

Verified 2026-07-18 against docs.expo.dev / npm / GitHub (not from model memory).
Re-verify on SDK upgrades. Each fact carries its source.

## SDK / versions

- **Expo SDK 57** is current stable; `expo@57.0.7`. Requires **React Native
  0.86** + **React 19.2**. Since SDK 55, every Expo package's MAJOR matches the
  SDK number — pin `expo-router@~57`, `jest-expo@~57`, `expo-sqlite@~57`, etc.
  (https://expo.dev/changelog/sdk-57)
- **New Architecture is forced on** (SDK 55+; `newArchEnabled: false` has no
  effect). The expo-policy gate asserts absent-or-true and flags `useHermesV1:
  false` (Hermes V1 is default since SDK 56).
  (https://docs.expo.dev/guides/new-architecture/)
- **React Compiler** is opt-in via `experiments.reactCompiler: true` (enabled
  in Expo's default template, not at SDK level). This template enables it.
  (https://docs.expo.dev/guides/react-compiler/)
- `expo prebuild` (SDK 57) **clears and regenerates** android/ios by default;
  `--no-clean` to keep. Simplifies the prebuild-determinism CI lane.

## eas.json / EAS CLI (v21.x)

- Per-profile **`node`** and **`pnpm`** string fields pin toolchains. A
  `corepack: true` field exists but has an open pnpm conflict bug
  (expo/eas-cli#3148), and EAS ignores package.json `packageManager`
  (expo/eas-cli#2401) — pin via the eas.json fields, which is what this
  template does.
- `cli.appVersionSource`: docs are silent on the omitted default — always set
  explicitly. This template sets **"local"** deliberately (repo is the source
  of truth; gates can diff it), rejecting Expo's "remote" recommendation for
  determinism reasons (see PORT-SPEC).
- **pnpm workspaces**: EAS auto-detects pnpm from pnpm-lock.yaml; run EAS from
  the app dir. **`node-linker=hoisted` is NOT needed** (SDK 54+ supports
  isolated installations; `expo/metro-config` has built-in monorepo support).
  (https://docs.expo.dev/guides/monorepos/)
- **`eas build --local` requires authentication** (login or EXPO_TOKEN), and
  secret-visibility env vars are unavailable to it — hence it is excluded from
  the harness selftest (credential-free doctrine).
  (https://docs.expo.dev/build-reference/local-builds/)
- Env/secrets surface is **`eas env:create|delete|exec|get|list|pull|push|update`**;
  `eas secret:*` is gone (visibility tiers: plaintext/sensitive/secret).
- EAS Update staged rollout: **`eas update --rollout-percentage=N`**, adjust
  via `eas update:edit`, revert via `eas update:revert-update-rollout`; branch
  rollouts via `eas channel:rollout`. No `eas update:roll-out` command.
- CI fingerprint: **`expo/expo-github-action/fingerprint@v8`** is
  credential-free (github-token only; set `packager: pnpm`). The
  `continuous-deploy-fingerprint` subaction DOES need EXPO_TOKEN.

## Hermes Intl (RN 0.86 / Hermes V1)

Native: `Intl.Collator`, `Intl.NumberFormat` (**`formatToParts` Android-only**),
`Intl.DateTimeFormat`, `Intl.getCanonicalLocales`, locale-aware prototype
methods. **Missing: `Intl.PluralRules`, `Intl.RelativeTimeFormat`,
`Intl.Locale`, `Intl.DisplayNames`, `Intl.ListFormat`, `Intl.Segmenter`,
`Locale.getTextInfo`.**
(https://github.com/facebook/hermes/blob/main/doc/IntlAPIs.md)

Template polyfill order (imported first in app/_layout.tsx, unconditionally —
identical CLDR behavior on device and under Node keeps the vitest i18n suite
authoritative): `@formatjs/intl-getcanonicallocales` → `@formatjs/intl-locale`
→ `@formatjs/intl-pluralrules` → `@formatjs/intl-relativetimeformat` (+ locale
data per catalog locale). The i18n module must NOT rely on
`NumberFormat.formatToParts` (iOS lacks it) unless
`@formatjs/intl-numberformat` is added — prefer plain `.format()`.

## Testing / export

- Router-aware tests: `import { renderRouter, screen } from
  'expo-router/testing-library'` (current). Peer: `@testing-library/react-native
  >= 13.2`. Keep test files OUT of `app/`.
  (https://docs.expo.dev/router/reference/testing/)
- jest-expo is a standard Jest preset: `--coverage` +
  `coverageReporters: ['json']` yields istanbul `coverage/coverage-final.json`.
  Under pnpm, `transformIgnorePatterns` MUST include `.pnpm`:
  `node_modules/(?!(.pnpm|(jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|...))`.
  (https://docs.expo.dev/develop/unit-testing/)
- `expo export` → `dist/`: native bundles at
  `dist/_expo/static/js/{ios,android}/entry-<hash>.hbc` (**Hermes bytecode by
  default** — basename follows the entry module, `entry` for
  `expo-router/entry`; `--no-bytecode` for plain JS), `metadata.json` at dist
  root, assets content-addressed under `dist/assets/<md5>`, sourcemaps only
  with `--source-maps`. bundle-measure logical chunk keys: platform dir +
  extension (e.g. `android/entry.hbc`). EMPIRICALLY CONFIRMED in the W3
  scaffold (Hermes bytecode v98; hash byte-identical across two fresh
  scaffolds — the ratchet's determinism premise holds).
  (https://docs.expo.dev/guides/analyzing-bundles/)
- `expo-sqlite/kv-store`: `import Storage from 'expo-sqlite/kv-store'` with
  `getItemSync`/`setItemSync`/`removeItemSync`/`clearSync` — current, drop-in
  for async-storage. (https://docs.expo.dev/versions/latest/sdk/sqlite/)

## iOS privacy manifests

Key: `ios.privacyManifests` → `NSPrivacyAccessedAPITypes[]` entries. Expo SDK
pods ship their own PrivacyInfo files BUT Apple doesn't reliably aggregate
static-pod manifests — copy required-reason entries into the app-level config
(store-metadata module scaffolds this). (https://docs.expo.dev/guides/apple-privacy/)
