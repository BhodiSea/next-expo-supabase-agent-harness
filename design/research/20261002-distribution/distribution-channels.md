# Distribution channels, as of 2026-10-02

The brief behind #162 to #171. Some facts were read on the primary page:

- the Claude Code plugin pages ("Publish and distribute a plugin", "Add components to a plugin", "Test plugins with evals");
- the plugin directory's pre-submission checklist;
- GitHub's Copilot hooks reference.

Cursor's, Codex's and some vendor pages were blocked by the egress proxy. Facts from those pages come from search extracts, and are marked † here.

## Claude Code plugin distribution (#163)

**Your own marketplace.**
- A `.claude-plugin/marketplace.json` in a git repository publishes a plugin, with no submission step.
- Users run `claude plugin marketplace add <owner/repo>`, then `claude plugin install <name>@<marketplace>`.
- From Claude Code v2.1.275, one step in a session also works: `/plugin install <name> --marketplace <owner/repo>`.
- Auto-update is off by default for third-party marketplaces.
- A CLI that ships a plugin is expected to print the two commands.

**Anthropic's directory.**
- Submission is through the developer portal (`claude.ai/directory/manage`), from a paid plan. A listing reaches Claude Code, claude.ai and Cowork.
- The `claude-plugins-official` marketplace takes no portal submissions.
- The portal's checks:
  - **blocking:** a README of at least 40 words outside code blocks, and a license;
  - **reviewer hold:** more than 512 files, or any non-image file over 256 KiB, in the plugin folder;
  - **reviewer hold:** a name matching a known brand.

**Plugin components.**
- Plugins can ship hooks (`hooks/hooks.json`).
- A plugin's `settings.json` applies only `agent` and `subagentStatusLine`, so permissions cannot ship.
- Plugin agents are named `<plugin>:<name>`.

**Plugin evals.** `claude plugin eval` runs cases with and without the plugin (`--ablation with-without`). It
writes `--json` results and a self-contained HTML report, and takes a `--max-cost-usd` ceiling.

## Try before install (#164)

**StackBlitz is not viable.** WebContainers cannot run Postgres or Docker†.

**Codespaces.**
- A `codespaces.new/<owner>/<repo>` badge opens one.
- Docker-in-Docker is the documented route to `supabase start`†.
- Whether a default machine fits the stack is unmeasured.

**A deploy button.** It would deploy only the web app and would not apply migrations. The Supabase integration on the
Vercel Marketplace was in public alpha†.

**Template repositories.** A generated repository has unrelated history. That is one more reason the example should be a
separate repository, not this one's template flag.

## README and repository page (#165, #166)

**Evidence on READMEs.**
- A study of about 2,000 repositories associates lists, images and contribution guidelines in the README with popularity (arXiv 2206.10772†).
- Status badges read as quality signals (CMU STRUDEL badges study†).

**The repository page.**
- GitHub allows 20 topics. Social preview images should be 1280×640 and under 1 MB.
- The page currently has 10 topics and GitHub's generated card.
- `charmbracelet/vhs` renders a terminal recording from a committed `.tape` file, and has an official action.

## Contributor funnel (#167)

- GitHub lists `good first issue` and `help wanted` on a repository's `/contribute` page.
- **up-for-grabs.net:** a YAML file per project, in a pull request to that site's repository.
- **goodfirstissue.dev:** requires at least ten contributors and three labelled issues†, so this repository is not eligible yet.
- **Discussions or Discord:** Discussions is indexed by search engines and needs no separate account; Discord is neither†.

## Other agents (#169)

**GitHub Copilot** (primary page).
- The CLI loads `.github/hooks/*.json` among other sources; the cloud agent reads only that path.
- `preToolUse` can allow, deny or ask.
- `agentStop` and `subagentStop` can `block`, which forces another turn.
- The cloud agent runs a subset of events, on Linux, honouring only `bash` and `command`.

**Cursor**†.
- It loads Claude Code hooks from `.claude/settings.json` when third-party configs are enabled, and accepts both Stop response formats.
- Its forum reports hooks not loading with the setting on, and Stop hooks firing for background sessions.

**Codex CLI**†.
- A `hooks.json` with twelve events, including `PreToolUse` and `Stop`.
- A Stop `block` becomes a continuation prompt.
- Experimental, off by default, not on Windows.

**AGENTS.md.** The scaffold's `CLAUDE.md` is `@AGENTS.md`, so instructions are already shared across agents.

## Comparable projects

Star counts are from GitHub search on 2026-10-01†.

| Project | Stars | What it is | Distribution |
|---|---|---|---|
| mksglu/context-mode | 24,774 | Context management through hooks and MCP, many agents | npm, its own plugin marketplace, per-agent installers, a benchmark file |
| t3-oss/create-t3-turbo | 6,108 | Next.js, Expo and tRPC monorepo starter | `create-turbo` example, template repository, deploy docs |
| FailproofAI/failproofai | 5,237 | Hook policy enforcement across agents | npm, docs site, recording in the README |
| nizos/tdd-guard | 2,355 | TDD enforcement through Claude Code hooks | Its own plugin marketplace, npm, recording in the README |
| JoeSlain/Nexpo | 77 | Next.js, Expo, tRPC and Supabase starter | Template repository, deploy button |
