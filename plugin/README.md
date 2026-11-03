# next-expo-supabase-agent-harness (Claude Code plugin)

The agent half of [next-expo-supabase-agent-harness](https://github.com/cogvera-labs/next-expo-supabase-agent-harness),
a scaffold for pnpm monorepos that ship a Next.js web app and an Expo mobile app over one
Supabase backend. This plugin carries the harness's subagents, slash commands and skills, so
you can use them in a Claude Code session without installing the harness.

## Install

```sh
claude plugin marketplace add cogvera-labs/next-expo-supabase-agent-harness
claude plugin install next-expo-supabase-agent-harness@next-expo-supabase-agent-harness
```

Or, inside a session on Claude Code 2.1.275 or later:

```
/plugin install next-expo-supabase-agent-harness --marketplace cogvera-labs/next-expo-supabase-agent-harness
```

## What it holds

- **Author agents:** `migration-rls-author` (a migration with row-level security policies),
  `dal-author` (the data access function and its DTOs) and `test-author`.
- **Reviewer agents:** `security-reviewer`, `web-security-reviewer`,
  `mobile-security-reviewer`, `accessibility-reviewer`, `design-reviewer`,
  `architecture-reviewer` and `torvalds-reviewer`. Reviewers are read-only: they cannot
  write or edit files.
- **`citation-verifier`**, an agent that checks each `// SOURCE:` and ADR citation.
- **Commands:** `/adr`, `/new-feature`, `/new-action`, `/new-migration`, `/rls-check`,
  `/verify-citations` and `/verify-invariants`.
- **Skills:** `authoring-vertical-slice` (one feature through the database, API, web and
  mobile layers), `authoring-e2ee-feature` (encrypting one feature end to end with the harness's opt-in e2ee
  module) and `designing-mobile-ui`.

## Examples

Each works in a Next.js, Expo or Supabase repository that the harness did not install.

- **Check a new migration's row-level security.** The command reviews the files that
  `git diff --name-only HEAD` lists. In a repository with at least one commit, stage the
  migration with `git add`, then run:

  ```
  /next-expo-supabase-agent-harness:rls-check
  ```

  The `security-reviewer` agent reports each finding with its file, line and SQL. The
  command ends `RLS: PASS` or `RLS: FAIL`; after a fail, Claude fixes the migration and
  offers to check again. Its live checks, the `rls_verify` probe and `pnpm db:test` against
  a running local stack, need a harness-installed project. Elsewhere it reviews the files
  alone; decline any command Claude asks to run for those checks.

- **Review a diff for user isolation.** With uncommitted changes to migrations, data access
  or server-side auth, ask:

  ```
  Use the security-reviewer agent on this diff.
  ```

  The agent reviews the files the diff touches. It flags such things as a server-side
  `getSession()`, an owner id taken from the request, or the service-role key outside an
  Edge Function, and ends `VERDICT: PASS` or `VERDICT: BLOCK`.

- **Restyle an Expo screen.** Run the skill on the screen's file:

  ```
  /next-expo-supabase-agent-harness:designing-mobile-ui app/(tabs)/index.tsx
  ```

  The skill works through the checklist for that kind of screen, its type roles and
  spacing, its loading, empty and error states, and its motion, then has the
  `design-reviewer` and `accessibility-reviewer` agents review the change. If Claude stops
  before the reviews, ask for them.

## What runs without asking

Opening a command runs the read-only commands on its `!` lines and puts their output in the
prompt: `git diff --name-only HEAD` in most, `git status --short` in `/new-feature`, and
`date` in `/adr` and `/new-migration`. `/new-feature` and the `authoring-vertical-slice`
skill may also run the plugin's slice scaffolder, which writes the stub files for a new
slice into your project and never overwrites a file. The commands and skills also
pre-approve reading and searching files, the plugin's own included, when you type them. A
skill that Claude starts by itself asks first. Every other command, and every file edit,
follows your own permission settings. The plugin has no hooks or MCP servers, and the
scaffolder makes no network request.

## What it does not hold

The hooks, the `pnpm validate` gate chain, the permission rules and the CI workflows are not
in this plugin. A plugin cannot carry permission rules, and the harness's hooks run the project's
own `tools/` and validate chain, so they belong to an installed project. Install them with
`npx --yes next-expo-supabase-agent-harness@latest init`.

The agents, commands and skills are written for a project the harness installed: they read
its docs under `docs/harness/` and its registers, run its tools and name its files. In
another project they work from whatever of that they find.

## Troubleshooting

- **A command, agent or skill is missing.** Run `/plugin` and open the **Errors** tab: it
  lists each load error and how to fix it.
- **Claude does not use the agent or skill you named.** Claude Code names each of the
  plugin's components `next-expo-supabase-agent-harness:<name>`, as in the
  `/next-expo-supabase-agent-harness:rls-check` command. Give the agent or skill that full
  name.
- **Inside a harness-installed project, the Stop hook keeps asking for a review.** The
  project's reviewer ledger records a verdict under the exact agent name it requires, so a
  verdict from the plugin's reviewer does not count. You do not need the plugin there:
  `init` already writes the same agents, commands and skills into the project's `.claude/`
  folder. Use those.

## License

Apache-2.0. See [LICENSE](LICENSE).
