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
   the migrator DSN, store/signing credentials, or user PII. Keep private data out of
   the lethal trifecta (see `sandbox-and-supply-chain.md`).

## Approved registry

| Tool | Type | Source / pin | Reviewed | Rationale |
|---|---|---|---|---|
| `corpus_search` | MCP (local stdio) | `tools/mcp/corpus-search-server.mjs` @ this repo | self-authored | citation grounding; no network, reads only the local pinned corpus (`tools/mcp/corpus/index.json`) |
| `rls_verify` | MCP (local stdio) | `tools/mcp/rls-verify-server.mjs` @ this repo | self-authored | mid-turn cross-user RLS probe; connects only to the local `DATABASE_URL` as the unprivileged `app_api` role; read-only, always rolled back |
| `authoring-vertical-slice` | Skill | `.claude/skills/authoring-vertical-slice/` @ this repo | self-authored | the slice recipe (migration → RLS → DAL → route → screen → tests); bundled scripts reviewed with the harness itself |
| `designing-mobile-ui` | Skill | `.claude/skills/designing-mobile-ui/` @ this repo | self-authored | the design doctrine (typography/spacing/motion/state choreography + per-surface checklists); prose only — ships NO scripts by design |

Anything not listed here does not run. Record scan results + pinned versions as evidence
for security reviews. Both shipped servers are wired in `.mcp.json` and allow-listed in
`.claude/settings.json` (`enabledMcpjsonServers`); adding a third requires a registry
row FIRST, then a human edit to those files (both write-guard/permission-protected).

## Privileged database access (the migrator carve-out)

There is no service key in this stack; the equivalent privilege is
`MIGRATOR_DATABASE_URL` — the `app_migrator` role owns the schema, so it can rewrite
the RLS policies themselves (and would bypass them entirely on any table missing
FORCE). The API never uses this role, and the mobile app never sees ANY database
credential — it holds only a scoped bearer token. Sanctioned uses, enforced by the
bash guard:

1. `drizzle-kit migrate` / `generate` / `check` (`pnpm db:migrate`),
2. `tests/migrations/migration-apply.mjs` (the fresh-apply runner behind the RLS
   suite, including the plan probe's seeding + ANALYZE).

Anything else that wants the migrator DSN needs a governing ADR (`docs/adr/`), a row in
this registry, and CODEOWNERS sign-off — there is no other sanctioned home for
privileged database access.

## Store & build credentials (the mobile carve-out)

`EXPO_TOKEN`, Android upload keystores, and Apple submission keys are the mobile
equivalent of signing material: they exist ONLY as CI secrets in the release lanes
(the `ci-mobile-release` module). No agent session, MCP server, or Skill may read,
mint, or export them; the bash guard denies shell contact, and the credential-free
selftest doctrine means no default lane ever needs them.
