<!-- cspell:ignore symbolicate -->

# Patch: source-map upload in the release lane (honest degrade)

A crash you cannot symbolicate is a crash you will misdiagnose. Two upload
paths exist in this stack, and they run in DIFFERENT places — wire both, and
make the absent-credential path loud in both:

| Half | Where the upload runs | Credential | Degrade when absent |
| --- | --- | --- | --- |
| native store builds | EAS build servers (the config plugin's build phases) | `SENTRY_AUTH_TOKEN` as an EAS secret env var | see step 1 — configure it BEFORE the plugin lands |
| OTA updates | the GitHub release/update workflow (this repo's runner) | `SENTRY_AUTH_TOKEN` as a GitHub Actions secret | `::warning::` + `SOURCEMAPS-NOT-UPLOADED.txt` artifact, never silent, never blocking |

Verified 2026-07-18 against
<https://docs.sentry.io/platforms/react-native/sourcemaps/uploading/expo/> and
<https://docs.expo.dev/eas/environment-variables/>; re-verify on
`@sentry/react-native` major bumps.

## 1. Native half: the EAS secret, created FIRST

The `@sentry/react-native/expo` plugin (mobile patch, step 3) adds upload
phases to the GENERATED release build. Those phases run on EAS servers, so the
token must live in EAS's env store — it never touches a GitHub runner:

```
eas env:create --name SENTRY_AUTH_TOKEN --value <token> \
  --environment production --visibility secret
```

Order matters: create the secret BEFORE the plugin diff lands. With the plugin
present and the token absent, the iOS upload phase is a known build-breaker
(the failure arrives as a red EAS build, not a skipped upload — see
[sentry-react-native#5507](https://github.com/getsentry/sentry-react-native/issues/5507),
and [#3552](https://github.com/getsentry/sentry-react-native/issues/3552) /
[#4961](https://github.com/getsentry/sentry-react-native/issues/4961) for the
env plumbing sharp edges). That failure mode is at least LOUD — but it blocks a
release on an observability credential, which inverts this harness's honest-
degrade doctrine. If you must build without the token (temporarily, or in a
deliberate no-upload posture), set `SENTRY_DISABLE_AUTO_UPLOAD=true` in the
same EAS environment and record why in the release notes
(<https://docs.sentry.io/platforms/react-native/manual-setup/manual-setup/> —
the same switch the plugin's build phases honor everywhere).

Debug builds never upload: during development the source is resolved by Metro
and source maps are unused (Sentry Expo source-maps guide) — so nothing here
touches the credential-free selftest or dev loops.

## 2. OTA half: the release workflow steps

The OTA bundle is exported on the GitHub runner (`eas update` writes `dist/`
— its default output directory), so this upload runs HERE. Add to the job that
runs `eas update` (the eas-update module's workflow; place the steps directly
after the update step), and mirror the release-workflow degrade idiom
(presence surfaced as a job-level env var — secrets cannot be referenced in a
step `if:` directly):

```yaml
    env:
      HAVE_SENTRY: ${{ secrets.SENTRY_AUTH_TOKEN != '' }}
```

```yaml
      # crash-reporting module — OTA source-map upload. Org/project/url come
      # from the @sentry/react-native/expo plugin config in app.config.ts; only
      # the auth token rides the environment. BOTH tokens gate this step: with
      # EXPO_TOKEN absent the publish step above was skipped, so `dist/` does
      # not exist yet (the degrade export below writes it later) and nothing
      # shipped that needs source maps — uploading would fail on a missing
      # directory for a publish that never happened.
      - name: Upload update source maps to self-hosted Sentry
        if: env.HAVE_SENTRY == 'true' && env.HAVE_TOKEN == 'true'
        run: pnpm --filter mobile exec sentry-expo-upload-sourcemaps dist
        env:
          SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}

      # HONEST DEGRADE: absent Sentry token → the update still ships, but the
      # gap is recorded loudly — an annotation on the run plus a marker file in
      # the run's artifacts. Never silent green, never a hard requirement.
      # (Gated on HAVE_TOKEN too: if nothing was published, there is no
      # shipped-without-source-maps gap to record — the eas-update workflow's
      # own NOT-PUBLISHED.txt degrade already covers that run.)
      - name: Record missing source-map upload loudly
        if: env.HAVE_SENTRY != 'true' && env.HAVE_TOKEN == 'true'
        run: |
          echo "::warning::SENTRY_AUTH_TOKEN not configured — this update shipped WITHOUT source maps; crashes from it will show minified frames until you upload them (sentry-expo-upload-sourcemaps dist)."
          printf '%s\n' \
            'This OTA update shipped WITHOUT uploading source maps (no SENTRY_AUTH_TOKEN secret in CI).' \
            'Crashes from this update will show minified frames.' \
            'Fix: add the SENTRY_AUTH_TOKEN repository secret, or upload manually with' \
            '  pnpm --filter mobile exec sentry-expo-upload-sourcemaps dist' \
            > SOURCEMAPS-NOT-UPLOADED.txt

      - name: Attach the degrade marker to the run
        if: env.HAVE_SENTRY != 'true' && env.HAVE_TOKEN == 'true'
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: sourcemaps-not-uploaded
          path: SOURCEMAPS-NOT-UPLOADED.txt
```

Notes:

- `sentry-expo-upload-sourcemaps` is a bin shipped by `@sentry/react-native`
  (verified against the npm registry, 2026-07-18), so it resolves through the
  mobile workspace with no extra install — and `--filter mobile exec` also puts
  the working directory at `apps/mobile`, where `dist/` lands. Sentry's docs
  now front a standalone `npx @sentry/expo-upload-sourcemaps` package (same
  tool, split out since SDK 8.9.0); this patch deliberately keeps the
  workspace-resolved bin because a bare `npx <pkg>` in a release job fetches an
  unpinned package at run time — exactly the supply-chain surface this repo's
  SHA-pinned workflows exist to avoid.
- With the env vars unset, the tool reads Sentry org/project/url from the Expo
  plugin config — one config source, no drift between build-time and CI-time
  upload targets.
- Keep the steps AFTER the update publish: an upload failure with the token
  PRESENT should red the job (a real credential that stops working is an
  incident, not a degrade), but it must never un-publish the update — order
  makes that causality readable.
- The store-build release workflow (ci-mobile-release module) needs NO upload
  step: its source maps upload during the EAS build itself (step 1). If you
  want the release job to assert that posture, the marker-file idiom above
  ports directly (gate on the same secret and warn when absent).

## 3. Prove it once

After the first credentialed run, open the uploaded artifact bundle in your
Sentry UI (Settings → Source Maps / Debug Files) and confirm the release you
just shipped lists bundles for both platforms. Then break it on purpose in a
branch — unset the secret, dispatch the workflow, and confirm the run goes
green WITH the warning annotation and the marker artifact. A degrade path you
have never seen degrade is a degrade path you do not have.
