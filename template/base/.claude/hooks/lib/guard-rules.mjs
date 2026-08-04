// Guard rule tables — PURE DATA for the PreToolUse guards (pretool-bash-guard.mjs,
// pretool-write-guard.mjs). No imports, no side effects, no top-level env/fs reads: the
// guards dynamic-import this AFTER hookio's fail-closed handlers are active, and if it
// cannot load or is mis-shaped they BLOCK (a guard that cannot read its rules must approve
// nothing). Keeping the rules here — importable in-process by tests — turns falsifiability
// from a brittle count into a per-rule behavioral closure: every id below must have at
// least one deny/allow canary in tests/hooks/hook-contract.test.mjs (checked by
// scripts/check-canary-coverage.mjs). Regexes/conditions are byte-equivalent ports of the
// former inline rule tables — do not weaken them.
// SOURCE: docs/harness/README.md (tamper evidence; hooks fail closed)

// ── bash-guard: shell-write enforcement surface ──────────────────────────────
// A shell redirect writes the same bytes ungated: `echo x > tools/validate.mjs` or
// `echo <hash> > .harness/build.ok` (stamp forgery) would bypass every write-guard content
// check and per-edit provenance. Deny shell WRITES whose target sits on the surface.
// apps/mobile/{android,ios} ride along: the generated native dirs are never hand-edited
// (continuous native generation — prebuild output is a build artifact, not a source tree).
// [\\/] everywhere a separator appears: on Windows shells the same write is spelled
// `tools\validate.mjs`, and a `/`-only pattern would fail OPEN there.
const PROT_DIRS = String.raw`(?:\.[\\/])?(?:tools|\.claude|\.harness|\.github[\\/]workflows|supabase[\\/]migrations|tests[\\/]rls|tests[\\/]migrations|apps[\\/]mobile[\\/](?:android|ios))[\\/][^\s"'|;&]*`
// tsconfig(.base).json belongs here as much as it belongs in WRITE_PROTECTED: it carries
// the max-strict compiler surface every other type gate rests on, and while the Edit/Write
// path was guarded, `sed -i 's/"strict": true/"strict": false/' tsconfig.base.json` was
// caught by NOTHING — not this guard, not gate-integrity, not `tsc -b`, not CI.
const PROT_FILES = String.raw`(?:\.[\\/])?(?:pnpm-lock\.yaml|lefthook\.yml|biome\.jsonc|knip\.json|eslint\.config\.mjs|vitest\.config\.ts|apps[\\/]mobile[\\/]jest\.config\.js|stryker\.config\.mjs|commitlint\.config\.mjs|\.dependency-cruiser\.cjs|pnpm-workspace\.yaml|tsconfig(?:\.base)?\.json|\.gitleaks\.toml|\.mcp\.json)\b`
const PROT = `(?:${PROT_DIRS}|${PROT_FILES})`

const SHELL_WRITE_MSG =
  'Blocked: shell writes to the enforcement surface (gate scripts, hooks, stamps, lockfiles, migrations, workflows, the strictness configs, the generated native dirs) bypass the write-guard — edit via the Write tool with HARNESS_ALLOW_SELF_EDIT=1 (human-in-the-loop).'

// Five spellings of a write whose destination is the protected surface.
const SHELL_WRITE_RES = [
  // shell redirection: `> path` / `>> path`
  new RegExp(`(?:^|[^<>])>{1,2}\\s*(?:"|')?${PROT}`),
  // tee (with any flags)
  new RegExp(String.raw`\btee\s+(?:-[a-zA-Z]+\s+)*(?:"|')?${PROT}`),
  // in-place edit via sed/perl -i
  new RegExp(String.raw`\b(?:sed|perl)\b[^|;&]*\s-i\b[^|;&]*${PROT}`),
  // cp/mv/etc with a protected path as the DESTINATION (final argument). Reading
  // FROM the surface (`cp tools/x.mjs /tmp/`) stays allowed.
  new RegExp(String.raw`\b(?:cp|mv|rsync|install|ln)\b[^|;&]*\s(?:"|')?${PROT}(?:"|')?\s*(?:$|[|;&])`),
  // Patch application: `git apply` / `patch` reconstruct arbitrary bytes at a protected
  // path with no redirect operator to match on.
  new RegExp(String.raw`\b(?:git\s+apply|patch)\b[^|;&]*${PROT}`),
]

// An INTERPRETER is a write primitive: `node -e "fs.appendFileSync('tools/rls-exempt.json',…)"`
// lands the same bytes as `>` while matching none of the redirect spellings above — it was
// the one un-denied way to widen a security escape list, doctor a gate script, or forge a
// stamp. Deny an inline-eval invocation (or dd/base64 reconstruction) whose PROGRAM TEXT
// names the protected surface. This is a tripwire, not a sandbox: an obfuscated path
// (string concat, base64, a variable) still evades it, which is precisely why the harness
// claims tamper-EVIDENT, not tamper-proof — gate-integrity re-hashing and CI parity are the
// layers that do not depend on pattern-matching.
// SOURCE: docs/harness/README.md (tamper evidence; guards are tripwires, not sandboxes)
const INTERPRETER_WRITE_RE = new RegExp(
  String.raw`\b(?:node|deno|bun|python3?|ruby|perl|php)\b[^|;&]*\s-(?:e|c|-eval|-exec)\b[^|;&]*${PROT}` +
    String.raw`|\bdeno\s+eval\b[^|;&]*${PROT}` +
    String.raw`|\bdd\b[^|;&]*\bof=(?:"|')?${PROT}` +
    String.raw`|\bbase64\b[^|;&]*\s-{1,2}(?:d|decode)\b[^|;&]*${PROT}`,
)

// Each rule: { id, re | test(cmd), message, allowWhen?(cmd, ctx) }. The guard denies on the
// FIRST matching rule (array order = message priority) unless allowWhen suppresses it. ctx
// carries { selfEdit } (HARNESS_ALLOW_SELF_EDIT=1). No env is read here — the guard reads it.
export const BASH_RULES = [
  {
    id: 'rm-rf',
    // Both a recursive and a force flag anywhere in the same command segment:
    // covers -rf, -fr, -Rf, split `-r -f`, and the long/reversed spellings.
    re: /\brm(?=\s)(?=[^|;&]*\s-(?:[a-zA-Z]*[rR][a-zA-Z]*\b|-recursive\b))(?=[^|;&]*\s-(?:[a-zA-Z]*[fF][a-zA-Z]*\b|-force\b))/,
    message: "Blocked: 'rm -rf' (any flag spelling) is forbidden by the harness.",
  },
  {
    id: 'shell-write-protected',
    test: (cmd) => SHELL_WRITE_RES.some((re) => re.test(cmd)),
    message: SHELL_WRITE_MSG,
    // Honors the same HARNESS_ALLOW_SELF_EDIT=1 human escape hatch as the write-guard.
    allowWhen: (_cmd, ctx) => ctx.selfEdit,
  },
  {
    id: 'interpreter-write-protected',
    re: INTERPRETER_WRITE_RE,
    message:
      'Blocked: an inline interpreter (`node -e`, `python -c`, `deno eval`, dd/base64) writing to the enforcement surface bypasses the write-guard the same way a redirect would — widening an escape list (tools/rls-exempt.json), doctoring a gate script, or forging a stamp is a human-in-the-loop act (HARNESS_ALLOW_SELF_EDIT=1).',
    allowWhen: (_cmd, ctx) => ctx.selfEdit,
  },
  {
    // Without this the agent-surface lock is DECORATIVE. Every other write path to
    // `.claude/**` is denied (the write-guard covers the Write/Edit tools, PROT_DIRS
    // covers shell redirects), but regenerating the lock is not a write to the surface —
    // it is one ordinary subprocess that makes an edit to the surface invisible. The
    // generator refuses without HARNESS_ALLOW_SELF_EDIT=1 on its own; this is the second
    // layer, denying the INVOCATION rather than trusting one env var to be the whole
    // control. Matched by name shape (`gen-*lock*.mjs … --write`) so a future lock
    // generator is covered the day it is added rather than the day someone remembers.
    id: 'gen-lock-writer',
    re: /\b(?:node|pnpm|npx|tsx)\b[^|;&]*\bgen-[\w-]*lock[\w-]*\.mjs\b[^|;&]*--write/,
    message:
      'Blocked: regenerating a hash lock is how an edit to the locked files becomes invisible — the lock is a hash OF the thing being checked, not a derivation from something else the gates judge. Review the diff to the locked surface first, then update the lock as a human act (HARNESS_ALLOW_SELF_EDIT=1) so it lands in the PR.',
    allowWhen: (_cmd, ctx) => ctx.selfEdit,
  },
  {
    id: 'git-hookspath-repoint',
    re: /git\s+(?:-[a-zA-Z]+\s+)*config\b[^|;&]*core\.hooksPath|git\s+-c\s*core\.hooksPath/,
    message: 'Blocked: repointing core.hooksPath disables the lefthook commit-time layer.',
  },
  {
    // .dev-auth holds the dev JWKS + minted tokens; no shell command has a
    // legitimate reason to reference it.
    id: 'dev-auth-access',
    re: /\.dev-auth\//,
    message:
      'Blocked: .dev-auth/ holds local signing material — it is never read, copied, or listed from shell.',
  },
  {
    id: 'git-force-push',
    re: /git\s+push\s+(--force|-f|--force-with-lease)\b/,
    message: 'Blocked: force-push is forbidden; rewrite history via PR review only.',
  },
  {
    id: 'git-reset-hard',
    re: /git\s+reset\s+--hard\b/,
    message: "Blocked: 'git reset --hard' destroys uncommitted work.",
  },
  {
    id: 'git-commit-no-verify',
    re: /git\s+commit\s[^|;&]*(--no-verify|\s-n\b)/,
    message:
      'Blocked: bypassing commit hooks (--no-verify) defeats the gate; fix the failure instead.',
  },
  {
    id: 'fork-bomb',
    re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;/,
    message: 'Blocked: fork bomb pattern.',
  },
  {
    // Real secret files only — .env, .env.local, .env.production … but NOT the committed,
    // secret-free .env.example / .env.sample / .env.template that document required vars.
    id: 'read-env-file',
    re: /\b(cat|less|more|head|tail|grep|nano|vim|code|xxd|strings|sed|awk|base64|od|dd)\s+[^|;&]*\.env(?!\.(example|sample|template)\b)(\.|\b)/,
    message: 'Blocked: reading .env files is forbidden; secrets are injected at runtime.',
  },
  {
    // `source .env` / `. .env` loads secrets into the shell environment.
    id: 'source-env-file',
    re: /(?:^|[|;&]\s*)(?:source|\.)\s+[^|;&]*\.env\b(?!\.(example|sample|template)\b)/,
    message: 'Blocked: sourcing .env files is forbidden; secrets are injected at runtime.',
  },
  {
    // App-signing and store-credential material: Android keystores, Apple ASC/APNs
    // keys and PKCS#12 identities, Firebase/Google service files. Never read, copied,
    // or echoed from shell — credentials live in the EAS/CI secret store.
    id: 'credential-file-read',
    re: /\b(cat|less|more|head|tail|grep|nano|vim|code|xxd|strings|sed|awk|base64|od|dd|cp|mv|scp|open)\s+[^|;&]*(\.keystore|\.jks|\.p8|\.p12|google-services\.json|GoogleService-Info\.plist)\b/,
    message:
      'Blocked: app-signing/credential material (*.keystore, *.jks, *.p8, *.p12, google-services.json, GoogleService-Info.plist) is never read, copied, or echoed from shell — credentials live only in the EAS/CI secret store.',
  },
  {
    // The EAS auth credential. Setting it inline, echoing it, or grepping it into
    // shell output leaks a long-lived token into the transcript; CI injects it
    // from secrets and no local command legitimately prints it.
    id: 'expo-token-leak',
    re: /EXPO_TOKEN\s*=|\b(echo|printf|printenv|grep|cat)\b[^|;&]*EXPO_TOKEN/,
    message:
      'Blocked: EXPO_TOKEN must never be set, echoed, or read into shell output — CI injects it from secrets.',
  },
  {
    // Interactive credential management (keystores, ASC keys, push keys) is a
    // human console act — an agent turn has no business touching it.
    id: 'eas-credentials',
    re: /\beas\s+credentials\b/,
    message:
      'Blocked: `eas credentials` manages app-signing material — a human-only surface. Credentials are configured in the EAS console/CI secrets, never from an agent shell.',
  },
  {
    // No repo script sanctions a local prebuild: the native dirs are generated,
    // uncommitted, and regenerated hermetically by the device-e2e CI lane from a
    // clean tree. A local prebuild leaves a stale native tree that drifts from
    // app.config.ts and invites hand-edits the gates cannot see.
    id: 'expo-prebuild',
    re: /\bexpo\s+prebuild\b/,
    message:
      'Blocked: `expo prebuild` regenerates the native dirs by hand — the generated android/ and ios/ trees are never local artifacts. The device-e2e CI lane is the sanctioned place a prebuild runs (hermetically, from a clean tree).',
  },
  {
    // Staging a generated native dir commits build output as source: the tree
    // then drifts from app.config.ts and every config plugin silently.
    id: 'git-add-native-dirs',
    re: /\bgit\s+add\b[^|;&]*(?:\s|["'=])(?:\.[\\/])?(?:apps[\\/]mobile[\\/])?(?:android|ios)(?:[\\/][^\s"'|;&]*)?(?=$|[\s"'|;&])/,
    message:
      'Blocked: the generated native dirs (android/, ios/) are never committed — native surface changes go through app.config.ts + reviewed config plugins, and CI regenerates the dirs from a clean tree.',
  },
  {
    id: 'knip-fix',
    re: /\bknip\b[^|;&]*--fix\b/,
    message:
      'Blocked: `knip --fix` auto-deletes code and has false positives; remove dead code by hand after reviewing the report.',
  },
  {
    id: 'dependency-update',
    re: /\bpnpm\s+update\b/,
    message:
      'Blocked: bulk dependency updates are Renovate-owned (pinned, cooled-down, reviewed). Change one pin deliberately if needed.',
  },
  {
    id: 'destructive-sql',
    re: /\b(psql|pg_restore)\b[^|;&]*\bDROP\s+(TABLE|SCHEMA|DATABASE)\b/i,
    message: 'Blocked: destructive SQL must go through a reviewed, ADR-coupled migration.',
  },
]

// ── write-guard: harness-protected paths (tamper evidence, layer 2) ──────────
// Root-anchored (^…) against the POSIX-normalized project-relative path. Weakening any of
// these weakens the gate; edits require HARNESS_ALLOW_SELF_EDIT=1 (checked by the guard).
export const WRITE_PROTECTED = [
  { id: 'harness-config', re: /^tools\/harness\.config\.mjs$/ },
  { id: 'validate-runner', re: /^tools\/validate\.mjs$/ },
  // The frozen CI floor: `validate.mjs --min-floor` trusts THIS file over the config, so a
  // shell/tool edit here would be the way to weaken CI without touching the config.
  { id: 'validate-floor', re: /^tools\/validate\.floor\.json$/ },
  // perf-baseline.mjs is the ratchet-baseline regenerator — it sits at the same trust
  // level as the gates that consume its output.
  { id: 'gate-scripts', re: /^tools\/(check-[^/]+|build-check|perf-baseline)\.mjs$/ },
  // The bare-URL citation allowlist the provenance gate resolves against — widening it
  // weakens the gate, so adding a domain is a human decision. Listed BEFORE tools-lib
  // (which also covers the path) so the deny carries its own named, canaried rule id.
  { id: 'citation-domains', re: /^tools\/lib\/citation-domains\.mjs$/ },
  { id: 'tools-lib', re: /^tools\/lib\// }, // shared gate helpers — same trust level as the gates
  { id: 'tools-mcp', re: /^tools\/mcp\// }, // corpus + MCP servers the provenance gate resolves against
  { id: 'lock-json', re: /^tools\/(identity|prompts)\.lock\.json$/ },
  { id: 'rls-exempt', re: /^tools\/rls-exempt\.json$/ }, // exempting a table from RLS is a human decision
  // The tenancy contract. predicateForms IS the definition of a correct tenant
  // predicate and rpcWriterRole names the one role that may write a seat — an agent
  // that could append to this file could legalize its own broken policy mid-turn,
  // which is the difference between a closed form set and a suggestion.
  { id: 'tenancy-contract', re: /^tools\/tenancy\.json$/ },
  // Allowlisting a SECURITY DEFINER function now AUTHORIZES EXECUTE to authenticated
  // (0.2.0), so this file grants privilege-escalation reach rather than merely
  // silencing a nag. Same posture as rls-exempt.json, for the same reason.
  { id: 'security-definer-allow', re: /^tools\/security-definer-allow\.json$/ },
  // The audit contract, both halves. audit-columns.json AUTHORIZES value capture into
  // the trail and pii-columns.json is the deny-list that refuses it — an agent that
  // could edit either could approve copying a column it was about to leak into a
  // second, less-policied table, or delete the entry that forbade it.
  { id: 'audit-columns', re: /^tools\/audit-columns\.json$/ },
  { id: 'pii-columns', re: /^tools\/pii-columns\.json$/ },
  // The blast-radius ceilings. Every value here is the number the db-limits gate
  // judges the migrations against, so raising one in this file makes a widened
  // statement_timeout or a raised [api].max_rows pass as reviewed.
  { id: 'db-limits', re: /^tools\/db-limits\.json$/ },
  // The rate-limit budget. Raising a number here raises what a single caller may cost
  // everyone else on the deployment, and the gate judges the running code against it —
  // so an agent that could edit this file could widen its own limit and stay green.
  { id: 'rate-limit-budget', re: /^tools\/rate-limit-budget\.json$/ },
  // The plan-probe floor and budgets. `minRows` is the anti-vacuity floor: lower it and
  // tools/check-db-perf.mjs happily certifies a plan against a four-row table, which is
  // the exact state every structural check in the repo is already green in. An agent
  // that could edit this file could make the one gate that measures reality measure
  // nothing, and the run would still print OK.
  { id: 'db-perf-baseline', re: /^tools\/db-perf-baseline\.json$/ },
  // GENERATED, and protected for the opposite reason to a budget: nothing may hand-edit
  // it, ever. It is the record of what the DALs actually asked the database for, and the
  // `query-shapes` gate judges index service against it — so an agent that could edit it
  // could describe a query it did not write and be believed. `pnpm gen` is the only
  // author; `contracts` reds the moment the file and the code disagree.
  { id: 'query-shapes-manifest', re: /^tools\/generated\/query-shapes\.json$/ },
  // THE AGENT SURFACE — the most privileged prose in the repository, and until 0.2.0 the
  // least protected. `.claude/rules/` is loaded into every turn; `.claude/agents/` decides
  // which reviewers exist and what they may touch; `.claude/commands/` and
  // `.claude/skills/` are the recipes a turn follows. An agent that can edit these can
  // rewrite its own instructions, and the `docs-sync` roster check reads only frontmatter
  // (name, model, tools) — never the body, where the instructions actually are. Layer 3
  // (prevention) did not exist for any of them.
  { id: 'claude-rules', re: /^\.claude\/rules\// },
  { id: 'claude-agents', re: /^\.claude\/agents\// },
  { id: 'claude-commands', re: /^\.claude\/commands\// },
  { id: 'claude-skills', re: /^\.claude\/skills\// },
  // The hash OF that surface. Write-protected for the sharper reason: regenerating it
  // after an edit is precisely how the edit becomes invisible, so it is the one file
  // whose modification is never routine.
  { id: 'agents-lock', re: /^tools\/agents\.lock\.json$/ },
  { id: 'provenance-overrides', re: /^tools\/provenance-overrides\.json$/ }, // cross-group citation escapes are a human decision
  { id: 'decision-groups', re: /^tools\/decision-groups\.json$/ }, // extending the citation taxonomy is a human decision
  { id: 'license-exceptions', re: /^tools\/license-exceptions\.json$/ }, // license exceptions are a human decision
  // Reviewed platform-capability data: the expo-policy/native-deps gates read them, and
  // widening a permission or config-plugin allowlist is native reach — a human decision.
  { id: 'expo-permissions', re: /^tools\/expo-permissions\.json$/ },
  { id: 'expo-plugins', re: /^tools\/expo-plugins\.json$/ },
  // Store-readiness policy (0.1.2): targetSdk floors, export-compliance stance,
  // tracking signals, privacy-manifest lockstep, the account-deletion closure —
  // every value is a store-review posture, so widening it is a human decision.
  { id: 'store-policy', re: /^tools\/store-policy\.json$/ },
  { id: 'bundle-budget', re: /^tools\/bundle-budget\.json$/ },
  // The committed gzip-ratchet baseline: regenerated ONLY by `pnpm perf:baseline`
  // in a reviewed commit — an agent editing it would re-baseline its own regression.
  { id: 'perf-baseline', re: /^tools\/perf-baseline\.json$/ },
  { id: 'perf-budget', re: /^tools\/perf-budget\.json$/ },
  // Wall-clock budgets for the CI-only interaction-latency lane — raising one
  // re-baselines the agent's own UX regression, so the edit is human-only.
  { id: 'interaction-budget', re: /^tools\/interaction-budget\.json$/ },
  // Cold-start / fully-drawn / per-screen budgets for the device perf lane. Same
  // reason as every budget above it: raising a cap re-baselines the very
  // regression the lane just caught, so it is a reviewed human act.
  { id: 'startup-budget', re: /^tools\/startup-budget\.json$/ },
  { id: 'styleguide-manifest', re: /^tools\/styleguide\.manifest\.json$/ },
  { id: 'mutation-baseline', re: /^tools\/mutation-baseline\.json$/ }, // accepting a surviving mutant is a human decision
  { id: 'route-allowlist', re: /^tools\/route-allowlist\.json$/ }, // exempting a screen from ROUTES is a human decision
  { id: 'dto-bounds-allow', re: /^tools\/dto-bounds-allow\.json$/ }, // exempting a wire string from the .max() bound is a human decision
  { id: 'duplication-allow', re: /^tools\/duplication-allow\.json$/ }, // accepting a code clone is a human decision
  { id: 'i18n-allow', re: /^tools\/i18n-allow\.json$/ }, // letting a string bypass the catalog is a human decision
  { id: 'test-quality-allow', re: /^tools\/test-quality-allow\.json$/ }, // letting a disabled or assertion-free test stand is a human decision
  { id: 'rls-runner', re: /^tests\/rls\/run-rls\.mjs$/ }, // the RLS runner the Stop hook invokes directly
  // REMOVED in 0.2.0: 'migration-apply-runner', protecting tests/migrations/migration-apply.mjs
  // — a file no template has ever shipped and nothing has ever invoked. It had a rule, a
  // hook-contract case, a settings.json allow entry and a slot in check-gate-integrity's
  // SURFACE, and all four passed, because a deny rule over a path that cannot exist is
  // trivially satisfied. That is the exact "green but bad" shape this repo exists to
  // eliminate: coverage counted it, the canary registry counted it, and it guarded nothing.
  // Migrations are covered by tools/check-migrations.mjs and replayed by `supabase db reset`.
  { id: 'lefthook', re: /^lefthook\.yml$/ },
  { id: 'github-workflows', re: /^\.github\/workflows\// },
  // The lint/architecture config surface — weakening any of these weakens the gate.
  { id: 'eslint-config', re: /^eslint\.config\.mjs$/ },
  { id: 'biome-config', re: /^biome\.jsonc$/ },
  { id: 'knip-config', re: /^knip\.json$/ },
  { id: 'dependency-cruiser', re: /^\.dependency-cruiser\.cjs$/ },
  { id: 'vitest-config', re: /^vitest\.config\.ts$/ }, // the node-side test surface the Stop hook runs
  // The other half of the unit floor: the jest-expo preset config the Stop hook's
  // mobile-unit step runs — weakening its ignore/coverage surface weakens the gate.
  { id: 'jest-config', re: /^apps\/mobile\/jest\.config\.js$/ },
  { id: 'tsconfig', re: /^tsconfig(\.base)?\.json$/ },
  { id: 'pnpm-workspace', re: /^pnpm-workspace\.yaml$/ },
  { id: 'gitleaks-config', re: /^\.gitleaks\.toml$/ },
  // Permission + MCP surface: never let the agent widen its own grants or add MCP servers.
  { id: 'claude-settings', re: /^\.claude\/settings\.json$/ },
  { id: 'claude-settings-local', re: /^\.claude\/settings\.local\.json$/ },
  { id: 'mcp-json', re: /^\.mcp\.json$/ },
  { id: 'harness-dir', re: /^\.harness\// },
  // CNG purity: the native dirs are GENERATED (prebuild output) — never committed,
  // never hand-edited. Native surface changes go through app.config.ts + reviewed
  // config plugins; CI regenerates the dirs from a clean tree.
  { id: 'cng-android', re: /^apps\/mobile\/android\// },
  { id: 'cng-ios', re: /^apps\/mobile\/ios\// },
]

// ── write-guard: everywhere-checks (banned CONTENT in any source file) ───────
export const WRITE_GLOBAL_CHECKS = [
  {
    id: 'dangerously-set-inner-html',
    re: /\bdangerouslySetInnerHTML\b/,
    message:
      'dangerouslySetInnerHTML is banned (XSS); render sanitized text through approved components — the mobile client renders text, never raw HTML.',
  },
  {
    // EXPO_PUBLIC_ vars are inlined into the shipped client bundle at export time —
    // fine for a transport origin, fatal for a credential. Secret-SHAPED names only:
    // the transport origin itself legitimately rides this prefix.
    id: 'expo-public-secret-name',
    re: /EXPO_PUBLIC_[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|PRIVATE)/,
    message:
      'EXPO_PUBLIC_-prefixed vars are inlined into the shipped client bundle — never put secret-shaped names there.',
  },
  {
    // NEXT_PUBLIC_ vars are inlined into the Next.js CLIENT bundle at build time —
    // the web twin of EXPO_PUBLIC_ on mobile. Secret-SHAPED names only: the public
    // config rides NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE (no
    // KEY suffix, by design), so a NEXT_PUBLIC_*KEY/SECRET/TOKEN is a secret leaking
    // into a browser-shipped bundle.
    id: 'next-public-secret-name',
    re: /NEXT_PUBLIC_[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|PRIVATE)/,
    message:
      'NEXT_PUBLIC_-prefixed vars are inlined into the shipped web bundle — never put secret-shaped names there. The public config uses NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE (no KEY suffix); the service key stays server-only.',
  },
  {
    // Lazy [\s\S]*? instead of [^,]+ so a comma INSIDE the value expression
    // cannot hide the session-wide third argument; /i catches SQL-style FALSE.
    id: 'set-config-session-wide',
    re: /set_config\(\s*['"]app\.[a-z_.]+['"]\s*,[\s\S]*?,\s*false\s*\)/i,
    message:
      'set_config(..., false) sets the GUC session-wide and LEAKS across pooled connections — the third argument must be true (transaction-local). SOURCE: docs/harness/README.md (GUC discipline)',
  },
  {
    id: 'set-session-app-guc',
    re: /\bSET\s+SESSION\s+app\.|\bSET\s+app\./i,
    message:
      'RLS identity GUCs must be SET LOCAL inside a transaction, never session-wide (pooling leak).',
  },
  {
    // THE TIMEOUT TWIN of set-config-session-wide, with its own id so its canary is
    // specific. `SET statement_timeout` (no LOCAL) mutates the SESSION, and under
    // Supavisor transaction mode the session is a pooled backend that the next
    // request — belonging to another tenant — is handed. A request that raises its
    // own ceiling to run one slow report leaves that ceiling behind it, so the
    // blast-radius control the migration installs per role is quietly gone for
    // whoever comes next. `SET LOCAL` reverts at COMMIT and is the only safe form.
    //
    // pathRe scopes this to runtime code that talks to the pooled database. A gate
    // script under tools/ that PRINTS `SET lock_timeout` as remediation advice is
    // discussing the statement, not executing it — and check-migrations.mjs's own
    // fix message does exactly that.
    id: 'pg-session-timeout-set',
    pathRe: /^(?:apps|packages|supabase)\//,
    re: /(?<!\bALTER\s+(?:ROLE|DATABASE)\s+[\w"]+\s+)\bSET\s+(?!LOCAL\b)(?:SESSION\s+)?(?:statement_timeout|lock_timeout|idle_in_transaction_session_timeout)\s*(?:=|TO)/i,
    message:
      "SET statement_timeout / lock_timeout / idle_in_transaction_session_timeout without LOCAL changes the SESSION, and a pooled session is handed to the NEXT tenant's request with your ceiling still on it. Use `SET LOCAL` inside the transaction, or change the reviewed per-role ceiling in tools/db-limits.json and the resource-limits migration. SOURCE: https://www.postgresql.org/docs/17/sql-set.html (SET LOCAL is undone at transaction end)",
  },
  {
    // pg_advisory_lock holds until the SESSION ends or it is explicitly unlocked.
    // On a pooled connection the session outlives the request, so a handler that
    // takes one and then throws leaks a lock nobody holds a reference to — every
    // later caller of that key blocks forever, and the pool has no way to notice.
    // pg_advisory_xact_lock is released at COMMIT or ROLLBACK, always, including
    // on the error path.
    id: 'pg-advisory-session-lock',
    re: /\bpg_advisory_(?:un)?lock(?:_shared)?\s*\(/i,
    message:
      'pg_advisory_lock is SESSION-scoped: on a pooled connection it survives the request that took it, so an error path leaks a lock that blocks every later caller of that key and no pool release can clear. Use pg_advisory_xact_lock / pg_advisory_xact_lock_shared, which the transaction end releases unconditionally. SOURCE: https://www.postgresql.org/docs/17/explicit-locking.html (advisory locks)',
  },
  {
    // Supavisor's transaction mode multiplexes many clients over few backends, so a
    // named prepared statement created on one request is not there on the next —
    // and the driver, believing it cached it, sends the name instead of the SQL.
    // The failure is 26000 "prepared statement does not exist", intermittent, and
    // load-dependent: it passes every local test against a direct connection.
    //
    // File-scoped on purpose (the presence of `prepare: false` anywhere in the
    // file clears it). This is the layer-3 tripwire at the moment of the edit;
    // tools/check-db-limits.mjs does the per-construction closure over the tree.
    id: 'pg-prepared-statement',
    re: /(?:[=(,]|\bawait\b|\breturn\b)\s*postgres\s*\(\s*(?!\?)(?![\s\S]*prepare\s*:\s*false)/,
    message:
      "a postgres() connection with prepared statements left on breaks under Supavisor transaction mode: the backend that holds the prepared statement is not the backend the next request gets, and the driver sends the cached NAME — an intermittent 26000 that no local test against a direct connection reproduces. Pass `prepare: false`. SOURCE: https://supabase.com/docs/guides/database/connecting-to-postgres (transaction mode does not support prepared statements)",
  },
  {
    id: 'vitest-workspace-file',
    re: /defineWorkspace|vitest\.workspace/,
    message:
      'vitest workspace files are banned — projects are defined in the root vitest.config.ts (single gate surface).',
  },
]

// ---- SQL content checks (schema + migration surface) ----------------------------
//
// WHY THIS TABLE EXISTS. The write-guard police source code from one line down:
// `if (!anyRel(/\.(ts|tsx|...)$/)) pass()`. Everything above it is path protection
// and two hand-written checks. The consequence was that a `.sql` file — the ONE
// file class where this codebase's authorization boundary actually lives — reached
// no content rule at all except the WITH RECURSIVE guard. An agent could write
// `CREATE POLICY ... USING (true)` into a migration and the only thing standing
// between that and a merged PR was a gate that runs later, after the write landed.
//
// These are PREVENTION (layer 3), not detection. Every rule here is also enforced
// tree-wide by check-rls-manifest.mjs, deliberately: the hook stops the edit at the
// moment it is made and the gate proves the property over the whole tree. A hook
// alone is a tripwire an obfuscated write can step over; a gate alone lets the bad
// edit land and be forgotten.
//
// `pathRe` scopes a rule to the surface it means something on. The same bytes under
// supabase/tests/** are a TEST of the bad shape, not the bad shape — a fixture
// asserting that `USING (true)` is rejected must be writable.
export const WRITE_SQL_CHECKS = [
  {
    id: 'rls-disable-or-noforce',
    pathRe: /^supabase\/(migrations|schemas)\//,
    re: /\b(?:DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY)\b/i,
    message:
      'turning RLS off is not a schema change, it is the removal of this codebase\'s only authorization boundary — every table keeps ENABLE + FORCE ROW LEVEL SECURITY. If a table genuinely needs no per-caller policy, exempt it with a reviewed reason in tools/rls-exempt.json instead. SOURCE: .claude/rules/security-invariants.md (RLS is THE authorization boundary)',
  },
  {
    // `TO public` and `TO anon` are the two spellings that hand rows to an
    // unauthenticated caller. The policy still looks like a policy in review.
    id: 'policy-to-public-role',
    pathRe: /^supabase\/(migrations|schemas)\//,
    re: /\bCREATE\s+POLICY\b[\s\S]*?\bTO\s+(?:public|anon)\b/i,
    message:
      'a policy granted TO public or TO anon applies to unauthenticated callers — policies are TO authenticated, and anon holds no grants at all. SOURCE: .claude/rules/security-invariants.md',
  },
  {
    // A predicate that is literally `true` permits every row of every tenant. It
    // reads as "RLS is on" to anyone skimming the migration.
    id: 'policy-using-true',
    pathRe: /^supabase\/(migrations|schemas)\//,
    re: /\b(?:USING|WITH\s+CHECK)\s*\(\s*true\s*\)/i,
    message:
      'USING (true) / WITH CHECK (true) is a policy that permits every row — RLS is enabled and enforcing nothing. Key the predicate on the caller: (SELECT auth.uid()), or the org scope helper.',
  },
  {
    // SECURITY DEFINER runs as the function OWNER. Without a pinned search_path a
    // caller who controls their own schema resolves your unqualified names to their
    // objects and executes them with the owner's privileges.
    id: 'security-definer-no-search-path',
    pathRe: /^supabase\/(migrations|schemas|functions)\//,
    re: /\bSECURITY\s+DEFINER\b(?![\s\S]*?\bSET\s+search_path\s*(?:=|TO)\s*'')/i,
    message:
      "SECURITY DEFINER without `SET search_path = ''` is the standard privilege-escalation footgun: the caller controls name resolution and your function runs as its owner. Pin the search_path and schema-qualify every reference. SOURCE: https://www.postgresql.org/docs/17/sql-createfunction.html (writing SECURITY DEFINER functions safely)",
  },
]
