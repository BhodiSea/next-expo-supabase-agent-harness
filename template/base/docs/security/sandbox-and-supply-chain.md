# Sandbox posture & the lethal trifecta

SOURCE: docs/harness/README.md (lethal-trifecta posture; Simon Willison's "lethal
trifecta", June 2025).

## The lethal trifecta

An agent is dangerous when it combines all three of:

1. **Access to private data** (user rows, tokens, store credentials), and
2. **Exposure to untrusted content** (web docs, user-supplied content, GitHub issues), and
3. **The ability to externally communicate** (Bash, network, opening PRs).

If an agent has all three, an attacker can trick it into exfiltrating private data.
**Break at least one leg** for any agent that touches private data.

## How this repo breaks the trifecta

- **No standing exfiltration.** `.claude/settings.json` denies `curl`/`wget`,
  force-push, hard reset, `.env*` and `.dev-auth/` reads, and ssh keys; the
  `WebFetch(domain:...)` allow rules cover a few documentation domains, and any other
  domain PROMPTS. That second half became true at 0.9.0: until then a bare `WebFetch`
  allow entry sat above the scoped rules, and permission evaluation is first-match with
  no specificity reordering, so every domain-scoped rule was decorative. The bare
  `Bash`/`WebFetch`/`WebSearch` entries are gone and the `wiring` gate reds their return.
- **No privileged-role exposure.** The `service_role` key (the RLS-bypassing role)
  lives only in ADR-governed Edge Functions and is kept out of the client bundle and
  the mobile graph; the authenticated caller runs under RLS (`auth.uid()`), asserted by
  the pgTAP + supabase-js isolation suites. Store and build credentials (`EXPO_TOKEN`,
  keystores, Apple submission keys) exist only in CI secrets; any shell contact with
  them is denied. The mobile app itself holds nothing but a scoped bearer token in the
  platform keychain. RLS is the backstop.
- **Read-only reviewers.** `torvalds-reviewer`, `security-reviewer`,
  `mobile-security-reviewer`, `accessibility-reviewer`, `citation-verifier` hold file
  reads/searches only — they cannot write or run shell (citation-verifier adds
  `corpus_search`; the security reviewers the read-only `rls_verify` probe — still no
  write/shell). As of 0.9.0 citation-verifier holds NO WebFetch: with repo read +
  external fetch + egress it carried all three trifecta legs in one agent, so external
  URLs it cannot ground in the corpus are reported for a HUMAN to open instead.
- **Least privilege per subagent.** Authors get write/Bash; reviewers do not. The local
  MCP servers (`corpus_search`, `rls_verify`) are network-free and read-only by design.

## Supply chain

- **Dependencies are pinned.** Versions live only in the pnpm-workspace.yaml catalog
  (SDK-lockstep and regen-sensitive tools EXACT-pinned — enforced by the
  `version-sync` gate); Renovate owns bumps with cooldown; bulk `pnpm update` is
  bash-guard-blocked. `expo install --check` (the `native-deps` gate) holds every
  Expo-managed package to the SDK-blessed version — native ABI drift is a build-time
  red, not a device-time crash.
- **License gates.** `licenses` (npm allowlist) runs in every validate; gitleaks runs
  pre-commit (lefthook, self-skipping) and over full history in CI.
- **No secret ships in a client bundle — on either surface, by two different routes.**
  Stated per surface rather than as one sentence, because until 0.5.0 the one sentence
  was wrong for half the product: `build-check.mjs` was `const APP = 'apps/mobile'`,
  so "the build gate greps the exported bundle" described a scan that never saw the web
  output, and `docs/harness/enforcement-tiers.md` said so in a row nothing read.
  - **Mobile** — chain step 25 (`build`) runs `expo export` on every validate and greps
    the emitted bundle for DSNs, service-role key NAMES, the service-role factory name,
    `sk_live_` and private-key headers. Deterministic and offline, so it runs on a laptop.
    It does **not** value-scan for `sb_secret_…`, and that is a measured limit rather than
    an omission: Hermes interns its string table contiguously with no delimiter between
    entries, so the `sb_secret_` prefix constant that `@app/supabase` legitimately ships —
    the one the runtime uses to REFUSE a secret key on a client surface — runs straight
    into whatever was interned next and satisfies any "prefix plus N characters of key
    material" rule. A real leaked key on this surface is caught by gitleaks in the source
    it came from, and by the `EXPO_PUBLIC_` name rule below.
  - **Web** — the same marker list **plus the `sb_secret_…` value scan**, which is
    decidable here because `.next/static` is JavaScript text and the value sits inside
    quotes. Over `apps/web/.next/static/**`, the chunks a browser downloads, in the
    path-filtered `web-build` CI job (`build-check.mjs --web`). It is a
    lane and not a chain step because a `next build` is minutes, not seconds. Two
    honest qualifications: it does **not** run on a PR that touches no web path (the lane
    is path-filtered, and `tools/ci/summarize-gate.mjs` greens over a skipped lane after
    naming it), and it deliberately does **not** scan `.next/server/**`, which legitimately
    holds the service-role factory and every server-only import.
  - **Both** — `EXPO_PUBLIC_`- and `NEXT_PUBLIC_`-prefixed secret-shaped names are
    write-guard-denied and `secrets`-gate-denied, because both prefixes are inlined into
    their shipped bundle; the judgement is by NAME shape, so it holds before any build
    exists. `.env.example` documents shape with empty values.
- **Generated native projects are not a review surface.** CNG purity (expo-policy +
  native-deps) keeps `android/`/`ios/` out of the repo entirely, so native intent is
  reviewable in `app.config.ts` + the plugin/permission allowlists instead of in
  thousands of generated lines an injection could hide in.

## Running sessions on sensitive code

- Use the built-in sandbox / a devcontainer (macOS Seatbelt, Linux bubblewrap) with no
  standing access to SSH keys, `.env`, or production DSNs.
- Reserve `--dangerously-skip-permissions` for sandboxed CI only.
- `disableBypassPermissionsMode: "disable"` is set so one developer cannot undo team rules.
- **Keep Claude Code at or above the floor.** `tools/cc-floor.json` is not a preference: it
  carries the published advisories, each with a link, and `version-sync` recomputes the floor
  from them. Repository-controlled-config bypasses are fixed only in current versions.
- New MCP servers / Skills must be on `approved-tools.md` (scanned, pinned) before first use.
- Managing this across a team is `managed-settings.md` — the layer a developer cannot switch
  off, and the only defence against `disableAllHooks`.

## The sandbox, with its limits stated first (0.6.0)

The harness **does not turn the sandbox on for you**, and this section says why rather than
leaving the recommendation floating. The sandbox is the only primitive here that binds child
processes regardless of what the model chose to run — every other control in this repo judges
text before a command runs. That makes it worth adopting deliberately, and worth understanding
before you do.

**How it is turned on.** Through settings only. There is no CLI flag that enables or disables
it; `--settings` is the only flag that carries sandbox keys. `--dangerously-skip-permissions`
does **not** disable it — that flag governs whether each tool call is approved, not whether the
process is confined. `--add-dir` / `/add-dir` widens the directory set sandboxed tools can see,
so it is a sandbox-relevant flag even though it never mentions the sandbox.

**What it allows by default.** Writes to the working directory and below, and the session temp
directory. Plus one that surprises people: in a **linked git worktree**, writes to the main
repository's shared `.git` are allowed so `git commit` can update refs and the index — with
`hooks/` and `config` inside it still denied. If you are reasoning about "nothing outside the
worktree is writable", that is the exception.

**The network rules are not an exfiltration control, and this is the important one.** The
allowlist the sandbox prompts against is the same list `WebFetch(domain:...)` allow rules feed,
so widening one widens the other. Non-allowlisted hosts *prompt* rather than fail unless you set
`network.strictAllowlist` (v2.1.219+, honoured from user, managed or `--settings` only —
**ignored from project settings**, so committing it to the repo does nothing) or, at the managed
level, `allowManagedDomainsOnly`. And CVE-2026-54316 was out-of-band exfiltration through a
*pre-approved* domain: a host allowlist bounds where data can go, not whether it goes. Treat it
as blast-radius reduction, never as prevention. Note also that the sandbox's network config does
not restrict `WebFetch` itself — that tool is governed by permission rules.

**Escape hatches and blind spots, named:**

- `dangerouslyDisableSandbox` is a per-command escape on the **Bash** tool input. Set
  `allowUnsandboxedCommands: false` to remove it entirely, or at minimum an `ask` rule on it.
- Whether `Monitor` commands are sandboxed at all is **not documented** — the sandbox reference
  never mentions the tool, and `MonitorInput` carries no `dangerouslyDisableSandbox` field. Do
  not assume parity with Bash.
- **Plugin monitors run unsandboxed, at the same trust level as hooks**, and start without
  Claude calling any tool. A plugin is not a lesser trust boundary than a hook.
- `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` makes Claude Code ignore `filesystem.disabled` **from
  every source, including managed settings**, keeping filesystem isolation on. It is the one
  place an environment variable overrides policy rather than the other way round — useful, and
  worth knowing before you debug why a managed `filesystem.disabled` is not taking effect.
- **There is no native Windows support** (macOS Seatbelt, Linux and WSL2 only). Windows is
  already the platform where this harness is thinnest — no Bash tool without Git Bash, and its
  own privilege-escalation advisory (CVE-2026-35603). Do not write a policy that assumes the
  sandbox is present everywhere; it is absent on the platform that needs it most.
