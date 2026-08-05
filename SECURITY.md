# Security Policy

## Reporting a vulnerability

Report vulnerabilities privately via
[GitHub Security Advisories](https://github.com/BhodiSea/next-expo-supabase-agent-harness/security/advisories/new).
Do not open public issues for security reports, and never include live
credentials (database DSNs, Supabase service-role keys or JWT secrets, Expo
access tokens, App Store Connect API keys, Play service-account JSON, Android
upload keystores, Vercel tokens) in a report.

## Supported versions

The latest tagged release and `main` are supported. Installed projects should
run `npx --yes github:BhodiSea/next-expo-supabase-agent-harness update` to pick up
fixes.

## Scope notes

- The harness's guard hooks and permission denies are **tamper-evident, not
  tamper-proof**: a determined agent with shell access can bypass local
  enforcement. CI parity (`tools/validate.mjs --min-floor`), manifest hashing
  (the `gate-integrity` step, which runs on every install), the frozen
  `tools/stop.floor.json` the Stop hook UNIONs into its chain, and CODEOWNERS
  review are the backstops. Reports that "the agent can edit its own gate with
  `HARNESS_ALLOW_SELF_EDIT=1`" describe the documented human escape hatch, not a
  vulnerability.
- **MCP tool calls are default-deny** (0.3.0). `.claude/hooks/pretool-mcp-guard.mjs`
  (matcher `mcp__.*`) reads the registry in `tools/approved-tools.json` and denies
  unregistered servers, tools outside a server's list, and write-shaped tool names
  on a server registered `readOnly` — the last by NAME SHAPE, so it covers verbs a
  vendor has not shipped yet. It fails closed on every ambiguity, including a
  missing or unparseable registry. Before 0.3.0 the `PreToolUse` matchers were
  literally `Bash` and `Edit|Write|MultiEdit`, so an `mcp__` call matched no hook at
  all; a report that an MCP server reached the database on **0.2.1 or earlier** is
  describing that gap, which is fixed, not a new finding.
- **A schema change is a reviewed file, never a tool call.** `supabase/migrations/`
  is what the write-guard's SQL rules judge as it is written, what `schema-rls` /
  `tenancy` / `migrations` judge tree-wide, and what a human sees under CODEOWNERS.
  Any path that reaches DDL without producing a migration file — an MCP
  `apply_migration`, a raw `psql`, an interpreter one-liner — bypasses all four, and
  a report showing a NEW such path is in scope.
- **Credential scanning runs in two places on purpose.** `gitleaks` (deep: entropy,
  the default ruleset, history) runs after a push; the `secrets` chain step (hermetic,
  zero-dependency) runs on every machine in every turn. Their **rule ids are held in
  lockstep** in both directions, so the two may differ in expression but never in
  scope. A shape one catches and the other does not is a bug worth reporting.
- Template workflows are stored dotless under `template/` precisely so they
  can never execute in this repository's own Actions context.
- The scaffolded stack's authorization boundary is Postgres row-level
  security, enforced identically for both client surfaces. The web session
  (httpOnly cookies), the mobile SecureStore token cache, and any client-side
  check are defense-in-depth only; reports demonstrating "the web or mobile
  client can call a procedure it shouldn't render UI for" must show the
  RLS/DAL layer failing, not the client hiding a button.
- Signing and store-submission material (EAS credentials, ASC keys, Play
  service accounts) lives in the EAS credentials service or GitHub
  environment secrets, never in the repo or a scaffold; workflows degrade
  honestly (labeled unsigned artifacts) when it is absent.
