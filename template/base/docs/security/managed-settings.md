# Managed settings — the only layer a developer cannot switch off

**Read this if you are deploying the harness across a team.** Everything else in this repo is
enforced by hooks the project itself wires. This document is about the one thing that layer
cannot defend: a developer turning it off.

## The single point of failure, named

`disableAllHooks: true` in a user, project, or local settings file **stops every non-managed
hook from running** — the Stop gate, both PreToolUse guards, the provenance check, the reviewer
verdict hook, all of it — and there is no hook left to notice. The permission `deny` list keeps
applying, and `pnpm validate` still works when a human types it, but the agent-time layer is
gone and nothing in the repository can tell.

The fix is not a setting that forbids it. There is exactly one documented property that helps:

> Hooks configured through **managed policy settings** cannot be disabled by `disableAllHooks`
> set in user, project, or local settings. Only `disableAllHooks` set at the managed level can
> disable managed hooks.

So a hook survives a developer disabling hooks **if and only if it lives in the managed file**.
That is the whole design constraint, and it is worth being precise about two near-misses:

- **`allowManagedHooksOnly` is not what protects your hooks.** Its documented effect is to
  *block every non-managed hook*. Turn it on with the harness hooks still living in the project
  and you have disabled the harness — the same outcome as `disableAllHooks`, arrived at while
  trying to prevent it. It only makes sense once the hooks you care about are managed.
- **`allowManagedPermissionRulesOnly` is not free.** It drops user and project permission
  `allow` rules and `additionalDirectories` as they are read. That is a large change to how
  every developer's session behaves, and it should be a decision somebody makes on purpose, not
  a line copied out of a hardening template.

## Where the file goes

| Delivery | Location |
| --- | --- |
| macOS (file) | `/Library/Application Support/ClaudeCode/managed-settings.json` |
| Linux and WSL (file) | `/etc/claude-code/managed-settings.json` |
| Windows (file) | `C:\Program Files\ClaudeCode\managed-settings.json` |
| macOS (MDM) | `com.anthropic.claudecode` managed-preferences domain; top-level keys mirror the JSON |
| Windows (Group Policy / Intune) | `HKLM\SOFTWARE\Policies\ClaudeCode`, `Settings` value holding the JSON |
| Server-managed | delivered at sign-in from the admin console or a self-hosted gateway |

Two operational notes. The legacy Windows path `C:\ProgramData\ClaudeCode\managed-settings.json`
**stopped being read at v2.1.75** — a deployment left there is a policy nobody is enforcing and
nothing announces it. And a `managed-settings.d/` drop-in directory beside the main file merges
systemd-style (base first, then `*.json` alphabetically; scalars override, arrays concatenate
and de-duplicate, objects deep-merge), so separate teams can ship fragments without editing one
file — use numeric prefixes such as `10-telemetry.json`, `20-security.json` when order matters.

`policyHelper` and `wslInheritsWindowsSettings` are **not** honoured through the server-managed
channel; they need MDM or a system file. Treat that exception list as open-ended rather than as
exactly those two.

## The minimal correct policy

Minimal is the point. Every key below earns its place; nothing is here because it sounded
hardening-ish.

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Monitor|PowerShell",
        "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/managed-hook.mjs\" pretool-bash-guard", "timeout": 10 }]
      },
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/managed-hook.mjs\" pretool-write-guard", "timeout": 10 }]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/managed-hook.mjs\" stop-validate-gate", "timeout": 600 }]
      }
    ]
  },
  "permissions": {
    "disableBypassPermissionsMode": "disable"
  }
}
```

That is it. `disableBypassPermissionsMode` at the managed level is what a developer cannot
override, and putting the hooks here is what makes them survive `disableAllHooks`. Adding
`allowManagedHooksOnly` on top would *disable the project's own hooks*, which is the opposite of
the goal; add it only if you have deliberately moved every hook you rely on into this file.

## Why the indirection through `managed-hook.mjs`

A managed hook fires in **every project on the machine**, including ones that have never heard of
this harness. Pointing the managed policy straight at
`$CLAUDE_PROJECT_DIR/.claude/hooks/stop-validate-gate.mjs` would make every unrelated repository
on that developer's laptop fail its hook with "module not found" — and `stop-validate-gate.mjs`
in particular *blocks* when it cannot load its config, which is right inside a harness install
and catastrophic outside one.

So the managed policy names a dispatcher that exits 0 when this project is not a harness
install, and otherwise hands the payload to the real hook. Deploy this file with the scaffold,
or have IT drop it in — it is deliberately tiny and deliberately boring:

```js
#!/usr/bin/env node
// .claude/managed-hook.mjs — run a harness hook if this project has one, else do nothing.
// A managed hook fires in EVERY project on the machine. In a project that is not a harness
// install there is no hook to run and nothing to enforce, and a policy that errors there
// teaches people to remove the policy.
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const name = process.argv[2]
const hook = new URL(`./hooks/${name}.mjs`, import.meta.url)
if (!/^[a-z0-9-]+$/.test(String(name)) || !existsSync(hook)) process.exit(0)

// stdin is the hook payload; pass it through untouched and propagate the exit code, because
// exit 2 IS the block and a wrapper that swallowed it would be worse than no wrapper.
const r = spawnSync(process.execPath, [hook.pathname], { stdio: 'inherit' })
process.exit(r.status ?? 2)
```

The `exit(r.status ?? 2)` is the part to keep: if the child cannot be spawned at all, this fails
**closed**, the same posture `hookio.mjs` takes for a crashed guard.

## Proving the policy is live

Do not use `/hooks` for this. Its source labels are User Settings, Project Settings, Local
Settings, Plugin Hooks, Session Hooks and Built-in Hooks — there is **no managed category**, and
whether managed hooks appear there at all is undocumented. Three things that do work:

1. **`/doctor`** — lists resolved settings, and lists any entry that was *stripped* for failing
   schema validation, with its source file and field. Managed settings parse tolerantly: one bad
   entry is dropped with a warning and the rest of the policy still applies, so a typo does not
   take your whole policy down — but it does silently take that one protection away unless
   somebody reads this output. Make it part of onboarding.
2. **`claude --debug-file <path> --init-only`** — runs `Setup` and `SessionStart` hooks and
   exits; the log names which hooks ran.
3. **`claude -p --output-format stream-json --verbose --include-hook-events "<query>"`** — emits
   hook lifecycle events for every hook event, which is the machine-readable proof to assert in
   CI if you ever add a lane that runs Claude.

## What this does not buy you

- It does not sandbox anything. See `sandbox-and-supply-chain.md`.
- It does not stop a developer running the same commands outside Claude Code.
- It does not make the guards complete. They are tripwires over command text, and two published
  CVEs (piped `sed`, directory change) are that caveat as shipped bypasses — which is why
  `tools/cc-floor.json` exists and why the floor is a version, not a promise.
