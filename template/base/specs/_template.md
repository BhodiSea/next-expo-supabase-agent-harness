# Spec: <feature>

<!--
Spec-first SOP (SOURCE: docs/harness/README.md — spec-first SOP): for any change
touching auth, RLS, migrations, the native config surface (app.config.ts / eas.json /
config plugins / permissions), or the API contract — write this spec, get human
sign-off, THEN implement (ideally in a fresh session). The spec is necessary but not
sufficient; the gate holds the line either way.
Copy to specs/<feature>.md and fill in. Every `##` heading is an addressable section:
`node tools/spec-anchor.mjs specs/<feature>.md` lists the ids, and
`node tools/spec-anchor.mjs specs/<feature>.md#security-invariants` prints one section.
Keep the headings: reviewers and ADRs cite them by id. Write "and", never "&", in a heading.
-->

## Summary

One line: what this feature does.

## Why now

Why now, and what success looks like (measurable).

## Goals

## Non-goals

## Files and interfaces

Name every file and interface this touches.

## Security invariants

Which does this touch? RLS policies? DAL / request-scoped client? migration — expand/contract
phase? auth verification? keychain seam (`src/host`/`src/auth`)? `app.config.ts` /
`eas.json` / permission or config-plugin change? new screen (routes manifest + Maestro flow +
startup budget)? prompt/lock change?

## Contract impact

`tools/generated/action-inventory.json` / `event-catalog.json` diff after `pnpm gen`? Older
mobile clients still work — store review lags and staged rollouts mean a long skew tail; see
`docs/runbooks/expand-contract.md`?

## Decisions

One `###` heading per decision, named in a few words, then what was chosen, what was
rejected and why. A reviewer or an ADR cites a decision by its id: `### Keyset cursor, not
offset` is `specs/<feature>.md#keyset-cursor-not-offset`.

## Out of scope

## Verification

The exact end-to-end command that proves it works.
