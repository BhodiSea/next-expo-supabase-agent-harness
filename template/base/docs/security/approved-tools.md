# Approved tools registry (MCP servers & Agent Skills)

SOURCE: docs/harness/README.md (allowlist-only, scan-before-install,
re-review-on-version-bump). MCP servers and Skills run with your privileges and can be
steered by prompt injection — a regulated operator must vet them, not trust them.

## Policy (default-deny)

1. **Default deny.** No MCP server or Skill runs on this codebase unless it is listed
   below, version-pinned to a reviewed commit. Prefer official/first-party servers.
2. **Vet before approve.** Read the `SKILL.md` and every bundled script; flag
   `allowed-tools: Bash(*)`, network calls, env-var harvesting, instructions hidden in
   comments; run a scanner; record provenance + a written trust rationale. Skills that
   ship executable scripts are ~2× higher risk — scan accordingly.
3. **Re-review on every version bump** (rug-pull defense — approving v1 does not
   approve v2).
4. **Least privilege + sandbox.** Scope tools per subagent; never hand an MCP server
   the direct database URL (`SUPABASE_DB_URL`), the `service_role` key, store/signing
   credentials, or user PII. Keep private data out of the lethal trifecta (see
   `sandbox-and-supply-chain.md`).

## Approved registry

| Tool | Type | Source / pin | Reviewed | Rationale |
|---|---|---|---|---|
| `corpus_search` | MCP (local stdio) | `tools/mcp/corpus-search-server.mjs` @ this repo | self-authored | citation grounding; no network, reads only the local pinned corpus (`tools/mcp/corpus/index.json`) |
| `rls_verify` | MCP (local stdio) | `tools/mcp/rls-verify-server.mjs` @ this repo | self-authored | mid-turn cross-user RLS probe; connects only to the local `SUPABASE_DB_URL` and impersonates via `SET LOCAL ROLE authenticated` + a transaction-local `request.jwt.claims`; read-only, always rolled back |
| `authoring-vertical-slice` | Skill | `.claude/skills/authoring-vertical-slice/` @ this repo | self-authored | the slice recipe (migration → RLS → DAL → route → screen → tests); bundled scripts reviewed with the harness itself |
| `designing-mobile-ui` | Skill | `.claude/skills/designing-mobile-ui/` @ this repo | self-authored | the design doctrine (typography/spacing/motion/state choreography + per-surface checklists); prose only — ships NO scripts by design |

Anything not listed here does not run. Record scan results + pinned versions as evidence
for security reviews. Both shipped servers are wired in `.mcp.json` and allow-listed in
`.claude/settings.json` (`enabledMcpjsonServers`); adding a third requires a registry
row FIRST, then a human edit to those files (both write-guard/permission-protected).

## Privileged database access (the direct-DB + service-role carve-out)

Two credentials outrank a normal `authenticated` request, and neither ever reaches the
app runtime or the mobile app (which holds only a scoped bearer token):

- `SUPABASE_DB_URL` — the direct, password-bearing Postgres connection. It owns the
  schema, so it can rewrite the RLS policies themselves (and would bypass them entirely
  on any table missing FORCE). Sanctioned uses:

  1. `supabase migration new` / `supabase db diff` / `supabase db push` / `supabase db reset` (`pnpm db:reset`, `pnpm db:test`),
  2. `tests/rls/run-rls.mjs` (the isolation runner behind the RLS suite — pgTAP + the
     supabase-js client suite).

- `SUPABASE_SERVICE_ROLE_KEY` — the `service_role` key that BYPASSES RLS through
  PostgREST. Its ONLY sanctioned home is an ADR-governed Edge Function
  (`supabase/functions/<name>`); the write-guard denies it anywhere in the web process.

Anything else that wants either credential needs a governing ADR (`docs/adr/`), a row in
this registry, and CODEOWNERS sign-off — there is no other sanctioned home for
privileged database access.

## Store & build credentials (the mobile carve-out)

`EXPO_TOKEN`, Android upload keystores, and Apple submission keys are the mobile
equivalent of signing material: they exist ONLY as CI secrets in the release lanes
(the `ci-mobile-release` module). No agent session, MCP server, or Skill may read,
mint, or export them; the bash guard denies shell contact, and the credential-free
selftest doctrine means no default lane ever needs them.
