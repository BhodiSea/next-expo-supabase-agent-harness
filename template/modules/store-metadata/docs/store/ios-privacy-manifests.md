<!-- cspell:ignore xcprivacy plutil -->

# iOS privacy manifests — app-level scaffolding notes

A privacy manifest is a `PrivacyInfo.xcprivacy` file in the iOS native project
declaring, among other things, which "required reason" APIs the app and its
dependencies touch and why. Expo exposes it as config — you never hand-edit the
generated iOS project (CNG keeps `ios/` disposable); entries are declared under
`expo.ios.privacyManifests` in `apps/mobile/app.config.ts`.
SOURCE: https://docs.expo.dev/guides/apple-privacy/

## What Expo SDK 57 covers for you — and what it does not

Verified against Expo's Apple-privacy guide (claims below are the guide's own):

- **Covered:** every Expo SDK package that uses a required-reason API ships its
  own `PrivacyInfo` file inside the package directory. The SDK's
  self-declarations exist without any work from you.
- **NOT covered:** Apple does not correctly parse all `PrivacyInfo` files
  included by **static CocoaPods dependencies** — so a library's own manifest
  can be invisible to App Store checks. Expo's guidance is to copy the
  required-reason entries your dependencies declare into the **app-level**
  config yourself. Nothing aggregates them for you, and the base scaffold
  deliberately ships **no** `privacyManifests` block rather than a guessed one.

The required-reason API areas are: UserDefaults, file timestamp, system boot
time, disk space, and active keyboard access — an open list Apple can expand,
which is one more reason the sweep below is a recurring step, not a one-off.

## The scaffolding to add (before first store submission)

App-level shape — the guide's own example entry (UserDefaults, reason `CA92.1`):

```ts
// apps/mobile/app.config.ts (inside the expo.ios block)
ios: {
  // ...existing identity/build fields...
  privacyManifests: {
    NSPrivacyAccessedAPITypes: [
      {
        NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults',
        NSPrivacyAccessedAPITypeReasons: ['CA92.1'],
      },
      // ...one entry per required-reason API your dependency sweep finds...
    ],
  },
},
```

Declare an entry when (and only when) your dependency sweep shows the API in
use, with the reason codes the owning library documents.

## The dependency sweep (run it, don't guess)

1. **Package-level manifests** (works on any OS; `-L` because pnpm's
   `node_modules` is symlinks):

   ```sh
   cd apps/mobile
   find -L node_modules -name 'PrivacyInfo.xcprivacy' -path '*/ios/*'
   ```

   Libraries usually keep it in `node_modules/<package>/ios/` — a library
   WITHOUT one that still touches the file-timestamp/UserDefaults/boot-time/
   disk-space/keyboard APIs is the case you must chase in its docs or source.

2. **Pod-level manifests** (macOS; prebuild runs `pod install`):

   ```sh
   cd apps/mobile
   npx expo prebuild -p ios
   find ios/Pods -name 'PrivacyInfo.xcprivacy'
   ```

3. For each manifest found, read its `NSPrivacyAccessedAPITypes` entries
   (`plutil -p <file>` on macOS, or open it — it is plist XML) and union them
   into the app-level block above, keeping each library's own reason codes.

4. Re-run the sweep in the SAME diff as any mobile dependency or config-plugin
   change (the `native-deps` gate already forces those changes through review —
   ride that diff).

## Honest limits

- **No gate automates this union.** The sweep needs the resolved pod set (a
  macOS `pod install`), which the credential-free validate chain deliberately
  never runs. This checklist plus review discipline IS the mechanism. What the
  base chain DOES automate (0.1.2, expo-policy gate): the SHAPE and reviewed
  lockstep of whatever you declare — `ios.privacyManifests` entries must use
  Apple's category vocabulary with real reason codes and a matching reviewed
  row in `tools/store-policy.json` `privacyAccessedApiTypes` (declared-but-
  unreviewed and reviewed-but-undeclared both red), and the tracking
  declarations must agree with the ATT string and the dependency set. The gate
  still cannot compute the union for you; the sweep remains manual.
- **The backstop is post-submission:** Apple notifies developers after a build
  is submitted with missing privacy-manifest reasons. Treat that email as a red
  gate — fix the app-level entries and resubmit.
- The manifest format also covers collected-data-type and tracking declarations;
  keep whatever you declare there consistent with the App Store Connect privacy
  questions and `docs/store/play-data-safety.md` — one privacy story, three
  places it gets told.
