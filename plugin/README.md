# next-expo-supabase-agent-harness (Claude Code plugin)

The agent half of [next-expo-supabase-agent-harness](https://github.com/BhodiSea/next-expo-supabase-agent-harness),
a scaffold for pnpm monorepos that ship a Next.js web app and an Expo mobile app over one
Supabase backend. This plugin carries the harness's subagents, slash commands and skills, so
you can use them in a Claude Code session without installing the harness.

## Install

```sh
claude plugin marketplace add BhodiSea/next-expo-supabase-agent-harness
claude plugin install next-expo-supabase-agent-harness@next-expo-supabase-agent-harness
```

Or, inside a session on Claude Code 2.1.275 or later:

```
/plugin install next-expo-supabase-agent-harness --marketplace BhodiSea/next-expo-supabase-agent-harness
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

## What it does not hold

The hooks, the `pnpm validate` gate chain, the permission rules and the CI workflows are not
in this plugin. A plugin cannot carry permissions, and the harness's hooks run the project's
own `tools/` and validate chain, so they belong to an installed project. Install them with
`npx --yes next-expo-supabase-agent-harness@latest init`.

The agents and commands are written for a project the harness installed: they read its
`AGENTS.md`, its docs under `docs/harness/` and its registers, and they run its tools. In
another project they work from whatever of that they find.

## Inside a harness-installed project

You do not need the plugin there. `init` already writes the same agents, commands and skills
into the project's `.claude/` folder. Use those, not the plugin's: Claude Code names a plugin
agent `next-expo-supabase-agent-harness:<name>`, and the project's reviewer ledger records a
verdict under the exact agent name it requires, so a verdict from the plugin's reviewer does
not count and the Stop hook keeps asking for it.

## License

Apache-2.0. See [LICENSE](LICENSE).
