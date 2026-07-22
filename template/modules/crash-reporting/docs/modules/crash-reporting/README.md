<!-- cspell:ignore unredactable undertests -->

# Module: crash-reporting

Self-hosted crash/error reporting for the mobile app (and, optionally, the API
server) — with the REDACTION POLICY as the shipped, tested core and the
transports as documented opt-in patches. The policy lands as real code the
moment you enable the module; the `@sentry/react-native` wiring is
copy-when-ready, because pointing a crash pipeline at an ingest host is a
deployment decision, not a scaffold default.

## What it adds

| File | Purpose |
| --- | --- |
| `apps/mobile/src/crash/redact.ts` | dependency-free redaction policy (DSNs, tokens, JWTs, e-mails, home paths on all three OSes, secret-shaped keys) |
| `apps/mobile/src/crash/redact.test.ts` | the policy's unit tests — they join the jest-expo `mobile-unit` lane immediately |
| `docs/modules/crash-reporting/mobile-sentry.patch.md` | `@sentry/react-native` wiring: install, metro config, the config plugin + `tools/expo-plugins.json` same-diff rule, `Sentry.init` with the PII-scrubbing defaults, the log-seam swap |
| `docs/modules/crash-reporting/release-sourcemaps.patch.md` | source-map upload: the EAS-build half (runs on EAS servers) and the release-workflow half (honest degrade when `SENTRY_AUTH_TOKEN` is absent) |
| `docs/modules/crash-reporting/server-sentry.patch.md` | `@sentry/node` wiring for `apps/server`: env contract, beforeSend → redaction, `app.onError` funnel |

## Prerequisites

- None for the shipped code (it is dependency-free and tested).
- For the transports: a self-hosted Sentry (or GlitchTip) instance and its DSN,
  and — for readable release stacks — a `SENTRY_AUTH_TOKEN` in the two places
  the source-map patch names (an EAS secret env var for native builds, a GitHub
  Actions secret for the OTA lane). On-prem doctrine: your ingest host, never a
  third-party SaaS.
- No selftest or module path requires Sentry, EAS, Apple, or Google
  credentials. Enabling the module with zero Sentry config is a complete,
  green, useful state: the policy is enforced from day one.

## How enabling works

```
npx next-expo-supabase-agent-harness enable crash-reporting
```

copies the files. `redact.test.ts` joins `pnpm --filter mobile exec jest` (the
Stop chain's `mobile-unit` step and the CI unit lane) automatically. The
patches stay documentation until you apply them — no gate-config change, no new
dependency, no lockfile churn.

## The config plugin joins `tools/expo-plugins.json` in the SAME diff

`@sentry/react-native/expo` is a config plugin: at prebuild it rewrites the
GENERATED native projects (a Gradle task and an Xcode build phase that upload
source maps and native debug files during release builds). That makes adding it
a native-surface decision, and the harness treats it exactly like every other
plugin: the `expo-policy` gate locksteps the resolved `plugins[]` array against
`tools/expo-plugins.json` BIDIRECTIONALLY.

Land BOTH of these in one reviewed diff:

1. the plugin entry in `apps/mobile/app.config.ts` `plugins` (exact snippet in
   `mobile-sentry.patch.md`), and
2. this row in `tools/expo-plugins.json`:

```json
{
  "name": "@sentry/react-native/expo",
  "reason": "crash-reporting module: source-map + native debug-file upload phases in the generated release build; events leave only via the redaction boundary in src/crash/redact.ts"
}
```

Why the gate reds otherwise — both directions, verbatim from
`tools/check-expo-policy.mjs`:

- plugin present, row missing →
  `plugin "@sentry/react-native/expo" resolves but has no entry in tools/expo-plugins.json — a config plugin rewrites the generated native project; review it in with a reason`
- row present, plugin missing (e.g. you later back the plugin out but keep the
  row) →
  `tools/expo-plugins.json lists "@sentry/react-native/expo" but it no longer resolves — stale entry (the lockstep is bidirectional, so the allowlist mirrors reality)`

`tools/expo-plugins.json` is write-guard-protected against agents: a human
lands the row (edit outside an agent session, or set
`HARNESS_ALLOW_SELF_EDIT=1` for the one edit). The `native-deps` gate
additionally asserts the row carries a non-empty reason — a reasonless
allowlist row is a gate bypass.

## The log seam: `src/lib/log.ts` is THE seam

Features import `log` from `apps/mobile/src/lib/log.ts`, never `console` (the
`no-console` lint rule is fatal in `apps/mobile`). Release builds drop every
level by default. That file exposes exactly one hook for this module —
`setLogSink` — so the transport swap reaches every call site without touching
feature code. The patch, applied inside `initCrashReporting()` (full wiring in
`mobile-sentry.patch.md`):

```ts
import { setLogSink } from '../lib/log'
import { redactText } from './redact'

// Release builds only, and only once the transport is initialized. Dev builds
// keep the console sink. debug/info stay DROPPED in release even with the
// transport on: breadcrumb volume is a PII surface, so only the two levels
// with diagnostic value ship — warn as a breadcrumb, error as a captured
// event — and BOTH pass the redaction boundary first.
if (!__DEV__) {
  setLogSink({
    debug: () => undefined,
    info: () => undefined,
    warn: (...args) => {
      Sentry.addBreadcrumb({ level: 'warning', message: redactText(args.map(String).join(' ')) })
    },
    error: (...args) => {
      Sentry.captureMessage(redactText(args.map(String).join(' ')), 'error')
    },
  })
}
```

## PII scrubbing defaults (the doctrine, mapped to SDK options)

Every default below is spelled explicitly in the patch wiring, even where it
matches the SDK default — a crash pipeline's privacy posture must be readable
in YOUR code, not inferred from a vendor changelog.

| Setting | Value | Why |
| --- | --- | --- |
| `dsn` | unset ⇒ transport OFF | an empty/absent `EXPO_PUBLIC_SENTRY_DSN` disables crash reporting entirely — the default state |
| `sendDefaultPii` | `false` (explicit; SDK default is `false`) | no user context, no default identifiers ([options reference](https://docs.sentry.io/platforms/react-native/configuration/options/)) |
| `beforeSend` | → `redactText` / `redactCrashEvent` | the unit-tested policy runs on message, exception values, extra, and breadcrumbs of every outbound event |
| `beforeBreadcrumb` | → `redactText` on `message` and `data.url` | SDK auto-breadcrumbs (http, navigation, touch) are scrubbed at mint time, before they accumulate in memory |
| `attachScreenshot` / `attachViewHierarchy` | stay `false` (SDK default) | a screenshot of a data screen is unredactable by construction — never turn these on in this stack |

## Source maps in the release lane (summary)

Two halves, both in `release-sourcemaps.patch.md`:

- **Native builds (EAS)**: the config plugin + metro config make EAS release
  builds upload source maps automatically — ON EAS SERVERS, authenticated by a
  `SENTRY_AUTH_TOKEN` secret created with `eas env:create`. Create the secret
  BEFORE landing the plugin diff (the patch documents the failure mode
  otherwise).
- **OTA updates (release workflow)**: after `eas update` exports `dist/`, a
  workflow step runs `sentry-expo-upload-sourcemaps dist` when the
  `SENTRY_AUTH_TOKEN` repository secret exists — and when it does not, the
  degrade is HONEST: a `::warning::` annotation plus a
  `SOURCEMAPS-NOT-UPLOADED.txt` marker uploaded with the run's artifacts, never
  a silent green, never a hard requirement.

## How its gate can FAIL (anti-vacuity)

- Weaken the policy: delete the e-mail rule from `TEXT_REDACTIONS` in
  `redact.ts` → `redact.test.ts` fails in the `mobile-unit` lane. That is the
  gate: the POLICY is enforced from day one, transport or not.
- Break the same-diff rule: add the config plugin without its
  `tools/expo-plugins.json` row (or the reverse) → `expo-policy` reds with the
  exact messages quoted above.
- After wiring Sentry: capture a test error containing a credentialed DSN (the
  dev-shaped `postgres://app_api:postgres@127.0.0.1/app` works) and an e-mail;
  assert the payload your ingest host received shows `[redacted]` /
  `[redacted-email]` (mobile patch, step 7) — this proves the WIRING calls the
  policy, not just that the policy exists.
- Extend the fixtures with YOUR PII shapes (student identifiers, tenant
  names); a generic-shapes-only redaction test undertests your data.

## Honest limits

- The redaction suite runs under jest-expo (the `mobile-unit` lane), which the
  mutation lane's vitest runner cannot execute — mutants in `src/crash/` are a
  recorded honest loss, same as the RN-coupled carve-outs in
  `tools/lib/mutation-critical.mjs`. The suite is written to the mutation-kill
  standard anyway; if you want it mutated, move the pair into the vitest half
  of the runner split (add the test to the `unit-node` include list in
  `vitest.config.ts`, mirror it in `jest.config.js` `testPathIgnorePatterns`,
  convert the test's globals to vitest imports, and add `apps/mobile/src/crash/`
  to `CRITICAL_ROOTS`) — one reviewed diff, four touch points, all documented
  as consumer decisions in those files.
- After the mobile patch, the app carries a native module: Expo Go cannot load
  it — use the development-build flow this template already assumes (CNG
  prebuild), per Expo's own guidance.
- The DSN ships in the client bundle (`EXPO_PUBLIC_` inlining). That is how
  every mobile crash reporter works — a DSN is an ingest ADDRESS, not a
  credential; rate-limit and filter at your ingest host. The
  `SENTRY_AUTH_TOKEN` is a real credential and never enters the bundle, the
  repo, or any selftest path.
- The server half shares the policy by REVIEWED COPY, not by a shared package
  (`server-sentry.patch.md` explains the trade and the duplication-gate flow);
  while the copies match, the gate's fingerprint proves it — a deliberate
  divergence is a policy fork you own.
- For egress-forbidden deployments, keep the transport off: the policy still
  guards anything you export by hand (redacted log excerpts, support bundles),
  and the module stays useful with zero network surface.

## Verified facts this module is written against

Checked 2026-07-18; re-verify on `@sentry/react-native` major bumps.

- `@sentry/react-native` 8.19.0 is current; peer range `expo >=49` (npm
  registry, 2026-07-18). Expo SDK 50+ required for the SDK; the deprecated
  `sentry-expo` package is not used
  ([Sentry: Expo setup](https://docs.sentry.io/platforms/react-native/manual-setup/expo/)).
- Config plugin `"@sentry/react-native/expo"` with `url` / `organization` /
  `project` options; auth rides the `SENTRY_AUTH_TOKEN` env var, never a plugin
  option (same page).
- Source maps upload automatically during native RELEASE builds only; debug
  builds resolve source through Metro and upload nothing
  ([Sentry: Expo source maps](https://docs.sentry.io/platforms/react-native/sourcemaps/uploading/expo/)).
- OTA upload command `npx sentry-expo-upload-sourcemaps dist` (the bin ships in
  `@sentry/react-native`; npm registry bin listing, 2026-07-18) — `dist` is the
  default output directory of `eas update`; org/project/url fall back to the
  Expo plugin config when the env vars are unset (same Sentry page;
  [Expo: using Sentry](https://docs.expo.dev/guides/using-sentry/)).
- `eas env:create --name … --value … --environment production --visibility secret`
  is the current secrets surface (`eas secret:*` is gone)
  ([Expo: environment variables](https://docs.expo.dev/eas/environment-variables/)).
