# next-expo-supabase-agent-harness

A deterministic agent harness for pnpm monorepos that ship a **Next.js 16 web
app AND an Expo (React Native) mobile app over one shared Supabase backend** —
deployed to **Vercel** and to the **Apple App Store and Google Play via EAS
Build/Submit** — installable into any new or existing project.

Its single purpose is the two-surface shape: one schema, one contract package,
one token source, one authorization boundary (Postgres row-level security),
two clients. The cross-surface seams are enforced by gates, not by discipline.

> **Status: pre-release, W0 of 10 complete — the stack tree is NOT yet this
> lineage's.** This repo was forked from
> [`expo-postgres-agent-harness`](https://github.com/BhodiSea/expo-postgres-agent-harness)
> (itself descended from
> [`tauri-postgres-agent-harness`](https://github.com/BhodiSea/tauri-postgres-agent-harness)).
> The harness machinery below — installer, gate chain, hooks, CI — is ported
> and green. **`template/stack/` is still the Expo + Hono + Drizzle reference
> app verbatim** and is replaced in W1 by the Next + Expo + Supabase tree; until
> then the gate chain describes that inherited stack, not the target one.
> Nothing is claimed here that the selftest matrix does not prove.

## What it is

An npm-installable CLI + Claude Code plugin that scaffolds the monorepo and
installs three enforcement layers into it:

1. **Agent-time hooks** — PreToolUse guards driven by a pure-data rule table
   (73 guard-rule ids: shell-command denials, write-protected harness paths,
   banned content everywhere), a PostToolUse provenance check, and a Claude
   Code `Stop` hook that refuses to end a turn until the validation chain,
   RLS isolation tests, and both unit suites pass.
2. **Commit-time checks** — lefthook + commitlint + gitleaks.
3. **CI** — the same validation chain, fail-closed, plus device lanes
   (Android emulator + Maestro) and release automation (release-please +
   EAS Build/Submit with honest degrade when credentials are absent).

## The gate chain

`pnpm validate` in a scaffolded project runs `tools/validate.mjs`, driven by a
single config (`tools/harness.config.mjs`) shared by the Stop hook and CI so
the three layers can never disagree about what "done" means. The chain is
21 gates, cheap → expensive:

format (biome) → gate-integrity (manifest sha over the gate scripts/hooks —
tampering is turn-fatal) → types (`tsc -b`) → lint (typescript-eslint
strictTypeChecked + react-native/a11y every-rule-error + React Compiler rules +
cognitive-complexity ≤ 15 + the fetch/secure-store/chart-library boundary
bans) → provenance (`SOURCE:` on every decision site) → **expo-policy**
(identity lock, ATS/cleartext, permissions + config-plugin allowlists, CNG
purity, secret-shaped `extra` ban, splash-color lockstep, eas.json sanity) →
**native-deps** (`expo install --check`, CNG purity, plugin allowlist) →
version-sync → prompts (hash-locked LLM prompts) → licenses → **schema-rls**
(every `pgTable` FORCE RLS + per-operation policies, or a reviewed exemption) →
migrations (append-only, DML-free) → contracts → dead-code (`knip --strict`) →
architecture (dependency-cruiser: mobile never imports server code or the
server stack, driver confined to the db layer, `db/context` DAL-only) → build →
styleguide (OKLCH token manifest regen-diff) → perf-budget → route-manifest →
e2e (the jest-expo + RNTL fast lane) → docs-sync.

CI runs the same chain against the frozen snapshot `tools/validate.floor.json`
(`node tools/validate.mjs --min-floor`; write-guard-protected, fail-closed if
missing, kept in lockstep with the config by `scripts/generate-floor.mjs`) — a
locally-weakened config cannot weaken CI. Toolchain-dependent gates skip
loudly without their prerequisite locally and fail closed in CI
(`HARNESS_REQUIRE_TOOLCHAINS=1`); a skip is never mistakable for a pass.
**Honest limit:** the chain contains no on-device proof — Maestro device flows
and startup-budget measurement run in CI device lanes, not at agent time.

Before a turn may end, the Stop hook runs the full chain (`--report-all`, so
every red surfaces at once) and then, invoked directly rather than through a
redefinable package script: the RLS isolation suite against real Postgres,
the vitest unit suite and the jest-expo mobile suite (both with coverage),
then per-file diff-coverage over the merged maps, duplication, the i18n seam,
test-quality (assertion presence, no committed `.only`), and the mobile-perf
closure (every route has a Maestro flow and a startup-budget row).

## The harness under its own bar

The repo applies the doctrine to itself: `scripts/` carries the machinery
self-checks, blocking in this repo's CI. `check-rule-integrity.mjs` hashes the
shipped depcruise forbidden rules + scan options and pins the shipped eslint
config text against `scripts/rule-integrity.json`, so a deleted, narrowed, or
severity-flipped boundary rule reds even though the lint/architecture runners
would still exit 0. `check-complexity-ratchet.mjs` re-lints with
`--no-inline-config` so a ratcheted function cannot grow behind its disable
directive. `check-claims.mjs` recomputes the machine-derivable numbers in this
README (chain length, guard-rule ids) and asserts README/CHANGELOG timing
figures cannot contradict each other. `check-release-lockstep.mjs` asserts one
version everywhere (package.json, plugin manifest, hook stamps, CITATION.cff,
CHANGELOG). `generate-floor.mjs` keeps the CI floor snapshot equal to the
canonical chain. Wall-clock timings are deliberately absent here: none have
been measured on this port yet, and unmeasured numbers do not ship.

## Install

### Scaffold an app

```sh
npx --yes github:BhodiSea/next-expo-supabase-agent-harness init
```

### Use this template — fork the harness itself

This repository is a GitHub **template repository**. "Use this template"
produces your own copy of the *harness* — installer, `template/`, selftest
machinery — to rebrand and extend into a sibling lineage; it does **not**
produce an app (the npx path above does that). A template copy starts from a
single commit with no upstream history or tags, and the selftest, hygiene, and
lint workflows run owner-agnostically in the copy.

The shipped `template/` tree needs no rebranding — it is placeholder-clean, and
the hygiene gate denies upstream references inside it. What does need rewriting
in a copy is the checklist of repo-root sites that hardcode the upstream owner:

- `package.json` — `repository.url`
- `README.md` — the npx command above, the sibling-harness link in the status
  note, and this checklist
- `CITATION.cff` — `title`, `authors`, `repository-code`
- `SECURITY.md` — the advisories URL and the `update` command
- `.claude-plugin/plugin.json` — the npx command in `description`, `author`
- `.claude-plugin/marketplace.json` — `owner`
- `scripts/check-corpus-fidelity.mjs` — the User-Agent contact URL
- `installer/lib/detect.mjs` — the sibling-harness redirect messages
- `scripts/hygiene.mjs` — two edits, and the second is the one that bites.
  **(a)** Keep the upstream-handle deny pattern (it stops upstream references
  from ever entering your `template/`) and add your own handle alongside it;
  likewise keep the upstream copyright notices (`REUSE.toml`, `LICENSES/`) and
  append your own. **(b)** Re-seed the **cross-porting detectors**: they ban a
  sibling harness's stack vocabulary anywhere under `template/`, so a lineage
  whose stack *is* that vocabulary reds on its own first file. Drop only the
  words your lineage now owns, and add the words of the lineage you forked
  away from — never delete a pattern to make a run pass. (This fork dropped
  `/supabase/i` and `/vercel/i`, and arms `/\bhono\b/i` + `/drizzle/i` in W1
  when the inherited stack tree leaves.)

Then prove closure the way the harness proves everything else:

```sh
grep -rn "BhodiSea\|Cogvera" --exclude-dir=node_modules .
```

should return only the attribution you deliberately kept and the hygiene deny
pattern.

## Layout

- `installer/` — the CLI (`init`, `update`, `doctor`, `enable`, `graduate`).
  Zero runtime dependencies.
- `template/base/` — the harness machinery installed into a consumer: gate
  scripts, Claude Code hooks/agents/rules, CI workflows (stored dotless),
  db bootstrap, RLS/migration test harnesses.
- `template/stack/` — the reference app. **Inherited, not yet this lineage's:**
  currently `apps/mobile` (Expo + expo-router), `apps/server` (Hono + Drizzle
  over Postgres FORCE RLS), `packages/{contracts,schema,importer,eval}`. W1
  replaces it with `apps/{web,mobile}` + `packages/{api,contracts,verticals/*,
  shared/*,platform/*,design-tokens,design-system,design-system-native}` +
  `supabase/`.
- `template/modules/` — opt-in modules (EAS release automation, EAS Update,
  store metadata, device e2e, crash reporting, observability, …).
- `scripts/`, `tests/` — the harness holding itself to its own bar.

## License

Apache-2.0 for the repository; everything under `template/**` is
"Apache-2.0 OR 0BSD" (recipients choose either — the scaffolded code carries
no attribution requirement).
