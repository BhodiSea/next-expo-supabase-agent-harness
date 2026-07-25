# Spec: <feature>

<!--
Spec-first SOP (SOURCE: docs/harness/README.md — spec-first SOP): for any change
touching auth, RLS, migrations, the native config surface (app.config.ts / eas.json /
config plugins / permissions), or the API contract — write this spec, get human
sign-off, THEN implement (ideally in a fresh session). The spec is necessary but not
sufficient; the gate holds the line either way.
Copy to specs/<feature>.md and fill in.
-->

**Summary / one-liner:**

**Why now / success looks like (measurable):**

**Goals / Non-goals:**

**Files & interfaces touched (name them):**

**Security invariants implicated** (RLS policies? DAL / request-scoped client? migration —
expand/contract phase? auth verification? keychain seam (`src/host`/`src/auth`)?
`app.config.ts` / `eas.json` / permission or config-plugin change? new screen (routes
manifest + Maestro flow + startup budget)? prompt/lock change?):

**Contract impact** (`openapi.json` diff? Older mobile clients still work — store
review lags and staged rollouts mean a long skew tail; see
`docs/runbooks/expand-contract.md`?):

**Out of scope:**

**End-to-end verification step (the exact command that proves it works):**
