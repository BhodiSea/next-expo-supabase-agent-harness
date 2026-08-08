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
  // POWERSHELL (0.6.0), and the reason it is a separate line rather than more alternatives
  // above: PowerShell's bash-compatible ALIASES (`cp`, `mv`, `tee`, `rm`, `cat`) already
  // match the patterns above, and `>`/`>>` redirect there too — so the gap was never the
  // aliases, it was the CANONICAL cmdlet spelling, which shares no token with its alias.
  // This matters more than it sounds: on Windows without Git Bash, Claude Code does not
  // register the Bash tool at all, so PowerShell is the only shell those sessions have.
  // SOURCE: https://code.claude.com/docs/en/hooks (PowerShell tool; Bash unregistered on Windows without Git Bash)
  new RegExp(
    String.raw`\b(?:Set-Content|Add-Content|Out-File|Tee-Object|New-Item|Copy-Item|Move-Item|Rename-Item)\b[^|;&]*${PROT}`,
    'i',
  ),
]

// The delete VERB, in every shell the harness's hooks now see. PowerShell's `-Recurse` and
// `-Force` already satisfy the flag classes in the `rm-rf` rule below (they are just longer
// spellings of the same letter classes), so `rm -Recurse -Force` was covered on the day that
// rule was written — verified, not assumed. What was never covered is the canonical
// `Remove-Item` and the non-bash aliases, which share no token with `rm`.
const DELETE_VERB = String.raw`(?:rm|Remove-Item|ri|rd|rmdir|del|erase)`

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

// ── the DISARM verbs: commands that neutralize the surface without writing to it ──
// Every rule above this comment asks "do these bytes land somewhere protected". That
// question has a blind spot the whole size of the enforcement surface, because the
// cheapest way to disable a control is not to rewrite it — it is to delete it, empty it,
// move it aside, revert it to a weaker revision, or drop a bit off it. None of those
// writes a single byte to the path, so none of them matched a redirect, a tee, a sed -i,
// a cp destination or an interpreter's program text.
//
// These are tripwires, exactly like the rest of this table: the surface is judged by
// gate-integrity's hashes and CI parity, which do not depend on pattern-matching. What
// these buy is the moment of the act.
const DISARM = {
  chmod: new RegExp(String.raw`\bchmod\b[^|;&]*\s(?:"|')?${PROT}`),
  // Plain `rm` (the -rf spelling has its own rule above, which fires first). A deletion
  // is the most complete disarm there is: no file, no hash mismatch to notice, and on a
  // manifest-recorded path the gate reports "missing from disk", which reads as an
  // installation problem rather than as an act.
  rm: new RegExp(String.raw`\brm\b(?![^|;&]*\s-(?:[a-zA-Z]*[rR][a-zA-Z]*\b|-recursive\b))[^|;&]*\s(?:"|')?${PROT}`),
  // Zeroing a file leaves it present and readable — and empty. A gate whose rule table,
  // budget or allowlist is empty does not crash; it judges nothing and prints OK.
  truncate: new RegExp(String.raw`\btruncate\b[^|;&]*\s(?:"|')?${PROT}`),
  // The existing cp/mv rule catches a protected DESTINATION. This is the other
  // direction: moving the file AWAY leaves nothing behind to check.
  moveAway: new RegExp(String.raw`\bmv\b[^|;&]*\s(?:"|')?${PROT}(?:"|')?\s+[^\s|;&]`),
}

// `git checkout <rev> -- <protected>` / `git restore --source=<rev> <protected>` reinstate
// an OLDER revision of a protected file — a gate script from before a rule was added, a
// floor from before a step was added — with a clean working tree and a green gate-integrity
// afterwards only because the manifest was re-recorded, or red in a way that reads as drift.
//
// Deliberately NOT denied: `git checkout -- <path>` and `git restore <path>` with no source
// revision. Those restore the CURRENT committed content, which is the exact remedy a dozen
// gate failure messages prescribe ("restore it from git history"). A guard that denies its
// own prescribed fix teaches people to reach for the escape hatch, which is the one habit a
// guard must never teach.
const GIT_OLD_REVISION_RES = [
  new RegExp(String.raw`\bgit\s+(?:-\S+\s+)*checkout\s+(?!--[\s=])\S+\s+--\s+[^|;&]*${PROT}`),
  new RegExp(String.raw`\bgit\s+(?:-\S+\s+)*restore\b[^|;&]*\s(?:--source[=\s]|-s\s)[^|;&]*${PROT}`),
]

// Each rule: { id, re | test(cmd), message, allowWhen?(cmd, ctx) }. The guard denies on the
// FIRST matching rule (array order = message priority) unless allowWhen suppresses it. ctx
// carries { selfEdit } (HARNESS_ALLOW_SELF_EDIT=1). No env is read here — the guard reads it.
export const BASH_RULES = [
  {
    id: 'rm-rf',
    // Both a recursive and a force flag anywhere in the same command segment:
    // covers -rf, -fr, -Rf, split `-r -f`, the long/reversed spellings, and (0.6.0) the
    // PowerShell verbs. Case-insensitive because PowerShell is.
    re: new RegExp(
      String.raw`\b${DELETE_VERB}(?=\s)(?=[^|;&]*\s-(?:[a-zA-Z]*[rR][a-zA-Z]*\b|-recursive\b))(?=[^|;&]*\s-(?:[a-zA-Z]*[fF][a-zA-Z]*\b|-force\b))`,
      'i',
    ),
    message:
      "Blocked: a recursive force-delete (any flag spelling, any shell — `rm`, `Remove-Item`, `del`, `rd`) is forbidden by the harness. Use the non-force recursive form and let the shell tell you what it cannot remove.",
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
    // The exec bit is no longer IN the trust path — 0.3.0 moved every hook command to
    // `node "<path>"`, so a hook without +x still executes. This rule ships anyway,
    // because `chmod` on the enforcement surface has no legitimate agent use and the
    // structural fix is the control, not this.
    id: 'chmod-protected',
    re: DISARM.chmod,
    message:
      'Blocked: chmod on the enforcement surface. Nothing an agent does needs to change the mode of a gate script, a hook, a stamp or a workflow — and until 0.3.0 `chmod -x` on the Stop hook silently disarmed the turn gate while every sha256 in the manifest still matched, because gate-integrity hashes CONTENT and never mode. Hook commands now invoke `node` explicitly, so the bit is not load-bearing; this is the tripwire, not the control.',
    allowWhen: (_cmd, ctx) => ctx.selfEdit,
  },
  {
    id: 'rm-protected',
    re: DISARM.rm,
    message:
      'Blocked: deleting a file on the enforcement surface (gate scripts, hooks, stamps, lockfiles, migrations, workflows, the strictness configs). A deletion is the most complete disarm there is — there is no altered content for a hash to catch, and a manifest-recorded path simply reports "missing from disk", which reads as an installation problem rather than as an act. If the file is genuinely obsolete, remove it in a reviewed commit (HARNESS_ALLOW_SELF_EDIT=1).',
    allowWhen: (_cmd, ctx) => ctx.selfEdit,
  },
  {
    id: 'truncate-protected',
    re: DISARM.truncate,
    message:
      'Blocked: truncating a file on the enforcement surface. An emptied rule table, budget or allowlist does not crash — it judges nothing and the gate prints OK, which is worse than a red.',
    allowWhen: (_cmd, ctx) => ctx.selfEdit,
  },
  {
    id: 'move-protected-away',
    re: DISARM.moveAway,
    message:
      'Blocked: moving a file OFF the enforcement surface leaves nothing behind to check — the same outcome as deleting it, spelled as a rename. (Moving a file INTO the surface is denied by shell-write-protected.)',
    allowWhen: (_cmd, ctx) => ctx.selfEdit,
  },
  {
    id: 'git-restore-old-revision',
    test: (cmd) => GIT_OLD_REVISION_RES.some((re) => re.test(cmd)),
    message:
      'Blocked: checking out an OLDER REVISION of a protected file reinstates a gate script from before a rule existed, or a floor from before a step existed, with a clean working tree afterwards. Restoring the CURRENT committed content — `git checkout -- <path>` / `git restore <path>`, the remedy the gate messages prescribe — is allowed and is almost certainly what you want. If you really need an older revision, that is a reviewed act (HARNESS_ALLOW_SELF_EDIT=1).',
    allowWhen: (_cmd, ctx) => ctx.selfEdit,
  },
  {
    // The sibling of gen-lock-writer, for the generators whose output is a BASELINE the
    // gates judge against rather than a lock. Re-running one is not a write to the
    // surface — it is one ordinary subprocess that turns the agent's own regression into
    // the new normal, and every gate is green immediately afterwards BY CONSTRUCTION.
    // Named explicitly rather than by shape: `pnpm gen`'s inventory generators are
    // regen-DIFFED by the contracts gate, so re-running those is checked, not accepted.
    id: 'self-rebaseline-writer',
    re: /\b(?:node|pnpm|npx|tsx)\b[^|;&]*(?:\bcheck-mutation-ratchet\.mjs\b[^|;&]*--write|\bperf-baseline\.mjs\b|\bperf:baseline\b)/,
    message:
      'Blocked: re-recording a ratchet BASELINE (the surviving-mutant set, the gzip floor) accepts the regression the ratchet just caught, and leaves every gate green by construction. Accepting a survivor or a size increase is a reviewed human act that must land in the PR diff — read the report, then re-baseline deliberately (HARNESS_ALLOW_SELF_EDIT=1).',
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
    // The PowerShell cmdlet spellings ride along (0.6.0). Its bash-compatible aliases
    // (`cat`, `more`, `sls`) already matched; `Get-Content` and `Select-String` did not.
    re: /\b(cat|less|more|head|tail|grep|nano|vim|code|xxd|strings|sed|awk|base64|od|dd|Get-Content|Select-String|Format-Hex)\s+[^|;&]*\.env(?!\.(example|sample|template)\b)(\.|\b)/i,
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
    re: /\b(cat|less|more|head|tail|grep|nano|vim|code|xxd|strings|sed|awk|base64|od|dd|cp|mv|scp|open|Get-Content|Select-String|Format-Hex|Copy-Item|Move-Item)\s+[^|;&]*(\.keystore|\.jks|\.p8|\.p12|google-services\.json|GoogleService-Info\.plist)\b/i,
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

// ── mcp-guard: the shape rules for a tool call that changes something ────────
// Until 0.3.0 the PreToolUse matchers were literally "Bash" and
// "Edit|Write|MultiEdit", so an `mcp__` call matched NO hook: it reached the
// database, the filesystem or the network with nothing in its path, while
// docs/security/approved-tools.md declared default-deny. The registry
// (tools/approved-tools.json) answers "is this server approved, and for which
// tools"; this table answers the question a per-tool allowlist cannot, because
// it is about verbs that do not exist yet.
//
// A server marked readOnly is approved to OBSERVE. Enumerating its write tools
// in order to leave them out is a list that decays on the vendor's next release,
// so the ban is by NAME SHAPE — the same reasoning as the EXPO_PUBLIC_/
// NEXT_PUBLIC_ secret-name rules, which judge shape rather than value because a
// name-shape rule with an exception is not a rule.
// SOURCE: docs/security/approved-tools.md (default-deny; least privilege)
export const MCP_RULES = [
  {
    id: 'mcp-write-on-readonly',
    // Two families: the two SQL verbs by exact name (they are the ones that reach
    // a live database with arbitrary statements), and the mutating verb prefixes.
    re: /^(?:apply_migration|execute_sql|run_sql|query_sql|(?:create|update|upsert|insert|delete|remove|drop|deploy|write|set|reset|restore|merge|rebase|pause|revoke|grant|send|publish|rename|move|copy|install|enable|disable|confirm)_[a-z0-9_]+)$/,
    message:
      'this server is registered readOnly in tools/approved-tools.json, and the tool name is write-shaped. A schema change is a REVIEWED FILE under supabase/migrations/ — that is what the write-guard SQL rules judge as it is written, what check-rls-manifest / check-tenancy / check-migrations judge tree-wide, and what lands in a PR under CODEOWNERS. A tool call leaves no file, so it bypasses all four. Write the migration (`supabase migration new <slice>`), or flip readOnly to false in tools/approved-tools.json as a deliberate human act (it is write-guard-protected).',
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

  // WHAT SURVIVES A PERSON'S DELETION. Every entry in data-flow.json is a decision that some
  // data outlives the account it belongs to, or that a portability response leaves something
  // out. Both are answers a controller has to be able to defend, and an agent widening either
  // one mid-turn is the change least likely to be noticed in a diff and most likely to matter.
  { id: 'data-flow', re: /^tools\/data-flow\.json$/ },

  // WHO OWES A REVIEW. Narrowing a pattern here is how a reviewer stops being summoned by
  // the diff it exists for, and it is a one-word edit in a file that reads like config.
  { id: 'reviewer-triggers', re: /^tools\/reviewer-triggers\.json$/ },

  // The rate-limit budget. Raising a number here raises what a single caller may cost
  // everyone else on the deployment, and the gate judges the running code against it —
  // so an agent that could edit this file could widen its own limit and stay green.
  { id: 'rate-limit-budget', re: /^tools\/rate-limit-budget\.json$/ },
  // The web response posture the `security-headers` gate diffs the evaluated
  // apps/web/lib/security-headers.ts against BY VALUE. It sat in ESCAPE_LISTS and in
  // SEEDED_FILES from 0.2.0 with no rule here at all — one layer where every peer in
  // this block has three — so deleting a CSP directive from the reviewed side was an
  // unguarded edit that makes the code side agree with it. Found by
  // scripts/check-escape-registry.mjs on its first run (0.5.0).
  { id: 'security-headers-policy', re: /^tools\/security-headers\.json$/ },
  // The applied-history acknowledgement (0.4.0), tolerated-absent. CREATING it is the
  // widening — it converts a hard `migrations` red into an exemption for a (file, rule)
  // pair — so it is exactly the class this block exists for, and it shipped without a
  // rule for the same reason security-headers.json did: nothing compared the lists.
  { id: 'migrations-allow', re: /^tools\/migrations-allow\.json$/ },
  // The framework SECURITY floor (0.5.0). Unlike its neighbours in this block it is
  // harness-OWNED rather than seeded — `update` must be able to carry a new advisory to
  // an existing install — but the agent-time hazard is identical and sharper: the file
  // names the exact minimum patch level, so lowering one number turns a red naming four
  // HIGH CVEs into a green, and the diff reads like a version bump. `gate-integrity`
  // sha-pins it (step 2) and this denies the edit mid-turn; the two answer different
  // questions, and only this one answers it before the write lands.
  { id: 'framework-floor', re: /^tools\/framework-floor\.json$/ },
  // The CLAUDE CODE floor, and it earns its own line rather than riding the one above for a
  // reason worth stating: every OTHER floor in this repo protects something the harness
  // ships. This one protects the thing the harness RUNS INSIDE — lower it and the tool
  // enforcing all thirty-three gates may itself carry a published settings-injection or
  // sandbox-escape. The file's value is its citations, so the edit that matters is the quiet
  // one: drop an advisory row, and the derived floor falls with it and version-sync stays
  // green. That is precisely the diff a human must see.
  { id: 'cc-floor', re: /^tools\/cc-floor\.json$/ },
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
  { id: 'web-route-allowlist', re: /^tools\/web-route-allowlist\.json$/ }, // exempting a web PAGE from the registry is the same decision on the other surface
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
  // THE COMPENSATING CONTROL ~TEN GATES CITE IN THEIR OWN FAILURE TEXT. Escape-list
  // widenings, seeded-data edits and every "reviewed human act" in this repo end with
  // "…so it lands in the PR diff under CODEOWNERS" — and until 0.3.0 CODEOWNERS itself
  // appeared in no WRITE_PROTECTED entry, no PROT_DIRS pattern and no permissions.deny.
  // An agent that can delete the rule covering `tools/**` has disarmed the control that
  // every one of those messages leans on, and no gate would have noticed. Deliberately
  // NOT hash-pinned in gate-integrity: a pin guaranteed to break on correct use (adding a
  // team, moving a directory) is a gate everyone learns to ignore. A write rule, a
  // permissions deny, and the `wiring` gate's coverage invariant are the three controls
  // that survive legitimate use.
  { id: 'codeowners', re: /^\.github\/CODEOWNERS$/ },
  // The CI configs that decide how strictly the workflow lint lanes read the workflows.
  { id: 'actionlint-config', re: /^\.github\/actionlint\.yaml$/ },
  { id: 'zizmor-config', re: /^\.github\/zizmor\.yml$/ },
  // The PR template carries the paste-the-real-gate-output contract — the one place the
  // "prove, don't claim" rule meets a human reviewer.
  { id: 'pr-template', re: /^\.github\/pull_request_template\.md$/ },
  // .gitignore is an enforcement surface in one direction nobody looks at: adding a line
  // to it makes a file invisible to `git status`, which is what the escape-list dirty
  // check, the diff-coverage change set, and the append-only migration diff all read. An
  // agent that could append `tools/` here would silence three gates with one line, and
  // every one of them would print OK.
  { id: 'gitignore', re: /^\.gitignore$/ },
  // Renovate owns dependency bumps (the bash guard denies `pnpm update` for the same
  // reason). Widening its config is how a bump stops being pinned, cooled-down, reviewed.
  { id: 'renovate-config', re: /^renovate\.json$/ },
  // The mutation lane's config: its ignore/threshold surface decides which code the
  // mutation ratchet is even allowed to change, so weakening it re-baselines the one
  // control that asks whether a test would notice the code breaking.
  { id: 'stryker-config', re: /^stryker\.config\.mjs$/ },
  { id: 'commitlint-config', re: /^commitlint\.config\.mjs$/ },
  // The CI lane helpers the workflows exec. A doctored device/perf lane script is a
  // doctored workflow with none of the workflow's protection.
  { id: 'tools-ci', re: /^tools\/ci\// },
  // The agent-time hooks themselves and the statusline that runs every prompt. Layer 1
  // (settings.json deny) already covered .claude/hooks/**, but layer 2 did not — and a
  // deny list is only as good as the settings file it lives in, which an agent that
  // reaches this surface is one edit away from.
  { id: 'claude-hooks', re: /^\.claude\/hooks\// },
  { id: 'claude-statusline', re: /^\.claude\/statusline\.mjs$/ },
  // ---- 0.3.0 data files: each one IS a gate's policy ----
  // The MCP registry. An agent that could append to it could approve its own reach.
  { id: 'approved-tools', re: /^tools\/approved-tools\.json$/ },
  // The credential shapes the `secrets` gate scans for. Deleting a pattern is deleting
  // the finding.
  { id: 'secret-patterns', re: /^tools\/secret-patterns\.json$/ },
  // The closed token map the doctrine check reads: removing a token retires the rule.
  { id: 'doctrine-symbols', re: /^tools\/doctrine-symbols\.json$/ },
  // The frozen Stop-chain floor — the same trust level as tools/validate.floor.json, and
  // for the same reason: the union runner trusts THIS file over the local config.
  { id: 'stop-floor', re: /^tools\/stop\.floor\.json$/ },
  // The two reviewed-acceptance files. Both are tolerated-absent by design (their gates
  // read absent-as-empty), so neither ships — but each converts a red into a NOTE, which
  // makes creating one exactly as consequential as widening an escape list.
  { id: 'retrofit-accept', re: /^tools\/retrofit-accept\.json$/ },
  { id: 'secret-scan-allow', re: /^tools\/secret-scan-allow\.json$/ },
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
  // Covers .harness/reviewer-ledger.jsonl too — the SubagentStop verdict ledger (0.6.0).
  // No rule of its own: it is RUNTIME output no template ships, and a deny over a path that
  // cannot exist is satisfied by every input, so its canary would pass while guarding nothing.
  // scripts/check-canary-coverage.mjs reds on exactly that, and did when one was written here.
  { id: 'harness-dir', re: /^\.harness\// },
  // CNG purity: the native dirs are GENERATED (prebuild output) — never committed,
  // never hand-edited. Native surface changes go through app.config.ts + reviewed
  // config plugins; CI regenerates the dirs from a clean tree.
  { id: 'cng-android', re: /^apps\/mobile\/android\// },
  { id: 'cng-ios', re: /^apps\/mobile\/ios\// },
]

// ── write-guard: content checks on NON-SOURCE config files ───────────────────
// The everywhere-checks below run only after `if (!anyRel(/\.(ts|tsx|…)$/)) pass()`, which
// is correct for them and leaves every JSON/YAML config unreachable by any content rule.
// This table runs ABOVE that gate and is always pathRe-scoped, so a config file is judged
// on the one or two weakenings that matter for it and nothing else.
export const WRITE_CONFIG_CHECKS = [
  {
    // package.json stays agent-editable — adding a dependency or a script is ordinary
    // work, and blanket-protecting it would make the harness unusable. But the npm
    // lifecycle hooks are a different thing wearing the same clothes: `postinstall` runs
    // arbitrary code on every `pnpm install`, in CI, on every developer's machine, before
    // any gate in this repo has executed. It is the shortest path from "an agent edited a
    // file nobody guards" to "code runs with the developer's credentials", and it is the
    // canonical supply-chain foothold.
    //
    // `prepare: lefthook install` is the one sanctioned entry: it is what installs the
    // commit-time enforcement layer, and doctor reds when it has not run.
    id: 'package-lifecycle-script',
    pathRe: /(^|\/)package\.json$/,
    re: /"(?:preinstall|install|postinstall|prepublish|prepublishOnly|prepack|prepare)"\s*:\s*"(?!(?:pnpm exec )?lefthook install")/,
    message:
      'npm lifecycle scripts (preinstall/install/postinstall/prepublish/prepack/prepare) execute on every `pnpm install` — in CI, on every machine, BEFORE any gate in this repo runs. That is the canonical supply-chain foothold, and package.json is deliberately agent-editable for everything else. The one allowed entry is `"prepare": "lefthook install"` (it installs the commit-time gate). Anything else belongs in an explicit script a human runs by name.',
  },
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
