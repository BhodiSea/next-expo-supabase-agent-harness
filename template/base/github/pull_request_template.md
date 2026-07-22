<!-- SOURCE: docs/harness/README.md (pre-merge human-review checklist; test-evidence over assertion) -->

## What & why

<!-- One-liner + link to specs/<feature>.md if this touches auth, RLS, migrations,
     the app identity/native-config surface (app.config.ts, eas.json, the permission/plugin allowlists), or the eval pipeline. -->

## Test evidence (prove, don't claim)

Paste the REAL output of the gate, not a claim that it passed:

```
$ pnpm validate
<paste the validate summary — all steps ✓>
$ pnpm test:rls        # REQUIRED if this PR touches migrations / RLS / the DAL / tenant data
<paste — must end with the literal line: [rls] OK>
```

## Security & regulated-work checklist (tick what applies; CODEOWNERS sign-off required)

- [ ] Every new/changed exposed table has `ENABLE` + `FORCE ROW LEVEL SECURITY` and
      per-operation policies in the SAME migration; policy columns indexed; no policy
      wider than its operation; INSERT covered by `WITH CHECK`.
- [ ] Migrations are append-only (new file, never an edit); destructive DDL carries
      `-- adr:` and follows docs/runbooks/expand-contract.md.
- [ ] User identity flows ONLY via the GUC discipline (`set_config('app.user_id', …, true)`
      inside a transaction — `SET LOCAL` semantics); no interpolated identity, no
      superuser/BYPASSRLS role on the request path.
- [ ] Authorization decisions live in the DAL against RLS-scoped connections — never in
      the mobile client, never trusting client-supplied IDs.
- [ ] Token verification unchanged, or reviewed: issuer/audience/algorithm stay pinned;
      `AUTH_MODE=stub` still refuses to boot in production.
- [ ] Native/store surface unchanged, or reviewed: identity matches
      `tools/identity.lock.json`; no ATS/cleartext loosening; every new Android
      permission and config plugin carries a reasoned allowlist entry
      (`tools/expo-permissions.json` / `tools/expo-plugins.json`); android/ and
      ios/ stay generated, never committed (CNG purity).
- [ ] No secret-shaped `EXPO_PUBLIC_` name; nothing database-shaped reaches the
      shipped bundle (the `build` gate scans the exported Hermes bytecode).
- [ ] A11y checks pass (eslint react-native-a11y + the RNTL primitives suite)
      for UI changes; interactive controls render through `src/components`
      primitives with role/label contracts and leaf testIDs.
- [ ] Every non-trivial decision carries a `// SOURCE:`; ADR emitted (`/adr`);
      `/verify-citations` is CLEAN.
- [ ] Any new MCP server / Skill is on `docs/security/approved-tools.md` (scanned, version-pinned).

<!-- Add your project's design-system review checklist here (see docs/harness/gates-catalog.md). -->
