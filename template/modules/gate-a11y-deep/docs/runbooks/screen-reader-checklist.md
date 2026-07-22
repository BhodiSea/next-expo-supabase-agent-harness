# Runbook: screen-reader release pass (gate-a11y-deep module)

The automated layers — eslint-plugin-react-native-a11y at error, the RNTL
suites, this module's deep sweep — verify the ACCESSIBILITY TREE. None of them
can hear what TalkBack or VoiceOver actually announce, in what order, or
whether a gesture path dead-ends. That judgement needs a human with a screen
reader on real hardware. Run this checklist before each release and file the
results in the release PR.

The unit of work is the ROUTE MANIFEST: walk **every entry in
`apps/mobile/src/routes.ts`**, the same list every automated lane iterates. A
screen missing from that manifest is a `route-manifest` gate failure, never a
checklist judgement call — so this pass can trust the list to be complete.

## Setup

- **Android / TalkBack** — a physical device, or an emulator image that ships
  the Android Accessibility Suite (`google_apis` images). The CI device lane's
  stripped ATD emulator image has no TalkBack, which is one reason this pass
  is manual by design. Enable via Settings → Accessibility → TalkBack, or from a
  connected shell:
  `adb shell settings put secure enabled_accessibility_services com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService`
- **iOS / VoiceOver** — a physical iPhone or iPad (Settings → Accessibility →
  VoiceOver, or the side-button triple-click shortcut). The iOS Simulator does
  not run VoiceOver; Xcode's Accessibility Inspector covers tree and label
  inspection there, but not the announced experience this pass exists for.
- **Build** — a release-shaped binary (the same `expo prebuild` + release
  assembly the device lane installs, or an EAS build). Never a dev-client with
  the dev menu in the traversal order, and never a build with stub auth.

## Per release — walk every ROUTES entry

For each route: open it, then traverse the whole screen with swipe-next /
swipe-previous (TalkBack) or flick-next / flick-previous (VoiceOver) until the
end is announced.

- [ ] **Landing**: opening the route announces the screen's context (the tab
      label or header title — the catalog string behind `route.titleKey`);
      focus is not lost and does not land on a decorative element.
- [ ] **Traversal order** matches the visual order — title, connection status
      (home), content, actions. No element is unreachable, none is announced
      twice, and traversal terminates (no cycle that never reaches the end).
- [ ] **Names and roles**: every control announces a meaningful name AND its
      role ("…, button", "…, tab"); nothing announces as a bare "unlabeled"
      element. (The deep sweep proves a non-empty name exists — you are
      judging whether the name is RIGHT.)
- [ ] **Canonical states**: with the API stopped, the route's error state is
      announced and its retry button is reachable and operable by
      double-tap; the empty state announces its guidance text, not silence.
- [ ] **Live announcements**: a failed write announces the error toast
      WITHOUT moving focus (the Toast's live region), exactly once — no
      re-announcement chatter on re-render.
- [ ] **Modal containment** (actions): opening the actions modal moves
      reading context into it; traversal stays inside until it is dismissed;
      dismissal is possible by screen-reader gesture alone (the back
      affordance is announced), and focus returns somewhere sensible.
- [ ] **Tab bar**: each tab announces name + role + selected state; switching
      tabs announces the new context.
- [ ] **Search** (actions): the search field announces its label — not its
      placeholder — and typing filters without stealing reading focus;
      the no-match empty state is announced.
- [ ] **Text scaling**: at the OS's largest standard font size, every swept
      screen keeps all controls visible and reachable (nothing clipped out of
      the traversal). The device lane (`device-e2e` module, when enabled)
      sweeps `font_scale` 1.3 and 2.0 for testID survival; this pass is the
      readability judgement beyond it.
- [ ] **RTL spot-check**: boot in the `ar-XB` pseudo-locale (the i18n
      journey's seed) and confirm traversal order follows the mirrored
      layout on one content route.
- [ ] **Reduced motion**: with the OS reduce-motion setting on, no surface
      relies on an animation to convey a state change.
- [ ] **Hardware keyboard (Android, optional but recommended)**: with a
      Bluetooth keyboard, focus is visible and every control on each route is
      reachable and operable.

## Recording the result

Add to the release PR:

```
Screen-reader pass: <date>
  Android: TalkBack <version>, Android <version>, device <model>
  iOS: VoiceOver, iOS <version>, device <model>
  App: <version> (<release build id>)
Routes walked: <every ROUTES id — name any skipped, with the reason>
Findings: <none | list with severity and issue links>
```

A finding that blocks task completion for a screen-reader user is a release
blocker — the same severity as a data-loss bug. File it, fix it or make the
call to ship with it EXPLICITLY, never silently.
