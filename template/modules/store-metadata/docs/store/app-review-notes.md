# App Review notes — working template

The long-form record behind `apple.review.notes` in
`apps/mobile/store.config.json`. Keep THIS file as the source of truth; before
each submission distill it into that field (the schema caps it at 4000
characters) and push via the `store-metadata` workflow. Reviewers read the
notes field, not your repo.

Rule that the `store-config` gate enforces: **no credentials in the committed
store config** — `apple.review.demoPassword` in `store.config.json` fails
validation. If review needs a demo login, inject it at push time (see "Demo
account" below).

## App summary (what the reviewer sees first)

> FILL IN: two or three sentences. What {{PROJECT_NAME}} does, who it is for,
> and what the reviewer should try first.

## Account deletion (5.1.1(v)) — where the reviewer finds it

The app supports in-app account deletion out of the box: **Actions → "Delete
account…"** (the command palette), behind a native destructive confirm. It
calls `DELETE /api/me`, which removes every row the signed-in user owns under
FORCE RLS, then signs the user out. Say so in the notes field — reviewers
look for the path, and naming it avoids a rejection round-trip.

## Sign-in for review

The scaffold authenticates against your organization's identity provider, so an
App Review contractor has NO account that works. Decide and document:

- [ ] **Demo account provisioned** — a dedicated review user in your tenant
      (least privilege, seeded with representative data, disabled between
      submissions). Set `demoRequired: true` in `apple.review` when all content
      sits behind sign-in.
- [ ] **Demo account excluded** — only justifiable when reviewable functionality
      exists without sign-in. Say exactly what the reviewer can reach signed out.

### Demo account (never committed)

Two supported paths for the password:

1. **Dynamic store config**: EAS Metadata accepts a JS config that can read
   `process.env` at push time — switch `submit.<profile>.ios.metadataPath` in
   `apps/mobile/eas.json` to a `store.config.js` and source the credential from
   the environment of whoever runs the push.
   SOURCE: https://docs.expo.dev/eas/metadata/config/
2. **Operator-run push**: keep the static JSON credential-free and run
   `eas metadata:push` from an operator machine where the reviewer credentials
   are filled in locally and never committed.

## Server dependency (do not skip)

The app is a thin client for the API at `{{API_ORIGIN}}`.

- [ ] The origin baked into the RELEASE build is publicly reachable over HTTPS
      from outside your network — App Review runs on Apple's infrastructure.
      The scaffold's local-dev default is a loopback origin, which an App Review
      device can never reach: a review build pointed at loopback is an app that
      does not start doing anything. (The expo-policy gate enforces
      https-or-loopback; only https is reviewable.)
- [ ] The server stays up (and seeded with demo-visible data) for the whole
      review window.
- [ ] Rate limiting / IP allowlists do not block Apple's ranges.

## What to demo

> FILL IN: the shortest path through the app's real value. For the scaffold
> feature set, for example:
>
> 1. Sign in (demo account above).
> 2. Create a note, edit it, watch it sync.
> 3. Open the matrix view; scroll a large list.
> 4. Trigger an agent action and show the streamed result.

## Anything a reviewer could misread

> FILL IN or delete each line:
>
> - Background behavior, notifications, or permissions the app requests and why
>   (keep in lockstep with `tools/expo-permissions.json` and
>   `docs/store/play-data-safety.md`).
> - Features that look unfinished or hidden (dev-only screens are stripped from
>   release builds — say so if asked).
> - Third-party content/licensing questions.

## Pre-submission checklist

- [ ] `store.config.json` sentinel values replaced (the workflow's validate step
      is red until they are).
- [ ] `apple.review.notes` regenerated from this file; under 4000 characters.
- [ ] Demo account works from a device OUTSIDE your network, signed in fresh.
- [ ] `{{API_ORIGIN}}` reachable and seeded.
- [ ] Privacy manifest entries current (`docs/store/ios-privacy-manifests.md`).
- [ ] Play data-safety answers still true (`docs/store/play-data-safety.md`) —
      the two stores' privacy stories must not contradict each other.
