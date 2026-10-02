# Distribution research, 2026-10-02

The research behind issues #161 to #171. Claude Code research agents ran it, and the maintainer
asked for two things: an issue to publish the package to npm with trusted publishing (OIDC), and
issues for changes that make the harness easier to find, evaluate, try and contribute to.

Internal facts refer to the 2.0.0 stack head (`stack/52-i37-work-plan`, commit `b158f5a`). External
facts were read on 2026-10-01 and 2026-10-02. Where the environment's egress proxy blocked a
primary page, the briefs say so, and the issues mark those facts as needing confirmation.

| File | Subject |
|---|---|
| [npm-trusted-publishing.md](npm-trusted-publishing.md) | Trusted publishing, provenance, the first-publish bootstrap, hardening, pnpm, dist-tags, npx resolution, Scorecard and zizmor |
| [distribution-channels.md](distribution-channels.md) | Claude Code plugin distribution, try-before-install, README and docs, contributor funnel, other agents' hooks, comparable projects |

## Reproduced here, not only read

- **npm 12 refuses the documented install.** npm's `latest` dist-tag is `12.2.0`, whose
  `allow-git` default is `none`. With the npm 12.2.0 tarball,
  `npx --yes github:BhodiSea/next-expo-supabase-agent-harness#v1.0.4 --help` fails with
  `EALLOWGIT`, and the same command with `--allow-git=root` runs (on Node 22.22.0, which npm 12
  warns is below its supported `^22.22.2`).
- **The scaffold already names the registry package.** A fresh `init` contains
  `npx next-expo-supabase-agent-harness …` 57 times in 32 files, and the name returns 404 on the
  registry.
- **The plugin folder is the repository root**: 1,242 tracked files, with
  `template/base/tools/conformance-map.json` at 696 KiB and `CHANGELOG.md` at 580 KiB, against
  the plugin directory's 512-file and 256 KiB review holds.
- **`init --tier core --with-demo`** plants nine workflows, and the only secret any of them reads
  is `SUPABASE_ACCESS_TOKEN`, in two jobs that do not run on pull requests.
- **The factory's suites need no install.** On a fresh checkout (Node 22, Linux container) they took:
  - installer: 466 tests, 51 s;
  - hooks: 585 tests, 35 s;
  - gates: 2,775 tests, 101 s.

  One gates test needed release tags the checkout lacked.

## Issues filed

| Issue | Subject | Owner action |
|---|---|---|
| #161 | Publish to npm with trusted publishing and provenance; `npx github:` fails on npm 12 | First publish of the attested 1.0.4 tarball, the trusted-publisher configuration, "disallow tokens" |
| #162 | `init`'s 389-character next-steps note becomes a numbered list | |
| #163 | A generated `plugin/` folder, install instructions, and the plugin directory | Directory submission |
| #164 | A public example project that upgrades itself in public | Create the repository |
| #165 | A README recording driven by the hooks themselves, and a statement of fit | |
| #166 | Social preview, topics, one description, the template flag, a discussion per release | Settings |
| #167 | A first-change path in CONTRIBUTING and more `good first issue` labels | Labels, up-for-grabs listing |
| #168 | macOS in `installer-unit`, and a scaffold lane without Docker | |
| #169 | Probe Copilot, Cursor and Codex hook support; decide on adapters | |
| #170 | A pre-registered with/without outcome evaluation | |
| #171 | A searchable docs site with `llms.txt`, or an index | |

## Considered and not filed

Each of these is a submission or an announcement by the maintainer, not a change to this repository:

- **awesome-claude-code.** Recommendations go through its web issue form only. The submitter
  must be a human, and its maintainer asks that the list not be used as a promotion channel.
- **A Show HN post.** Its rules ask for something people can try without barriers, so it waits
  on #161 and #164.
- **The Vercel templates gallery.** It would list only the web app; this waits on #164.
- **The Supabase partner catalog.** It is closed to names containing "Supabase".
- **Homebrew core.** It needs at least 225 stars, 90 forks or 90 watchers.
- **The OpenSSF Best Practices "passing" badge.** Its current status could not be read from this
  environment.
