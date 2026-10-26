---
title: next-expo-supabase-agent-harness
description: The harness doctrine, gates catalog, runbooks, decision records and module guides that next-expo-supabase-agent-harness writes into every project it scaffolds.
template: splash
head:
  - tag: title
    content: next-expo-supabase-agent-harness documentation
hero:
  tagline: A CLI that scaffolds a pnpm monorepo with a Next.js web app and an Expo (React Native) mobile app on one Supabase backend, plus Claude Code hooks and CI gates that block an agent turn or a merge until validation passes.
  actions:
    - text: Read the doctrine
      link: /next-expo-supabase-agent-harness/harness/
      icon: right-arrow
    - text: Gates catalog
      link: /next-expo-supabase-agent-harness/harness/gates-catalog/
      variant: secondary
    - text: GitHub
      link: https://github.com/BhodiSea/next-expo-supabase-agent-harness
      variant: minimal
---

Start a new project from an empty folder:

```sh
npx --yes next-expo-supabase-agent-harness@latest init
```

`init` writes these pages into the new project's `docs/` folder. This site renders the same
Markdown files from the repository's `template/` tree whenever the main branch is built, so
it can describe changes that are not released yet. Where a page shows a placeholder such as
`{{SECURITY_OWNERS}}`, `init` fills in the project's own value.

- [The harness doctrine](/next-expo-supabase-agent-harness/harness/): why each enforcement
  mechanism exists, which script implements it, and where its limits are.
- [Gates catalog](/next-expo-supabase-agent-harness/harness/gates-catalog/): every gate in
  `pnpm validate`, in the Stop hook and in CI. Each gate has a link that stays the same when
  the chain is renumbered, such as
  [`#gate-secrets`](/next-expo-supabase-agent-harness/harness/gates-catalog/#gate-secrets).
- Runbooks, for example
  [local development](/next-expo-supabase-agent-harness/runbooks/local-development/) and
  [upgrading an installed project](/next-expo-supabase-agent-harness/runbooks/harness-upgrade/).
- [Opt-in modules](/next-expo-supabase-agent-harness/harness/gates-catalog/#opt-in-modules):
  what each module adds and why it is not on by default. Each module also has its own pages,
  such as [e2ee](/next-expo-supabase-agent-harness/modules/e2ee/) and
  [push-notifications](/next-expo-supabase-agent-harness/modules/push-notifications/).
- [Architecture decisions](/next-expo-supabase-agent-harness/adr/): the decision records a
  new project starts with, and how to add one.

The source is on [GitHub](https://github.com/BhodiSea/next-expo-supabase-agent-harness), and
the CLI is published on [npm](https://www.npmjs.com/package/next-expo-supabase-agent-harness).
