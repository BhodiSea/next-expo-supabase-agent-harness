# The README recording: what an agent sees when the harness says no. No model runs in it.
# The hooks are programs that read Claude Code's JSON payload on stdin, and the gates are
# programs that exit 1, so every line of output below is printed by the harness itself.
#
# Regenerate from the repository root, never edit the GIF by hand:
#
#   vhs docs/media/harness-demo.tape
#
# It needs vhs (https://github.com/charmbracelet/vhs, with ttyd and ffmpeg), node and git.
# It installs from THIS checkout, so the recording shows what the tree being released prints.
#
# tests/installer/readme-recording.test.mjs runs every typed command below without vhs and
# checks it against this file: each `# expect:` line names text the NEXT typed command must
# print, a `# exit: N` line the exit status it must end with (0 when absent). A changed
# message reds that test, and the fix is to update this file and regenerate the GIF.

Output docs/media/harness-demo.gif

Require node
Require git

Set Shell "bash"
Set FontSize 15
Set Width 1280
Set Height 420
Set Padding 20
Set TypingSpeed 30ms
Set Theme "Catppuccin Mocha"

# Shell plumbing only: a short prompt, the CLI name pointing at this checkout, and an
# empty temporary folder for the new project.
Hide
Type `export PS1='$ ' REPO="$PWD"; next-expo-supabase-agent-harness() { node "$REPO/installer/cli.mjs" "$@"; }; cd "$(mktemp -d)"; clear`
Enter
Show

# 1. Scaffold a project. The secrets gate scans tracked files, so give it a repository.
# expect: harness init (bootstrap)
Type "next-expo-supabase-agent-harness init --yes"
Enter
Sleep 2s
Type "git init -q && git add -A"
Enter
Sleep 2s

Hide
Type "clear"
Enter
Show

# 2. An agent's Bash call, piped to the guard the way .claude/settings.json invokes it.
Type "# the agent asks to run: git push --force origin main"
Enter
# expect: "permissionDecision":"deny"
# expect: Blocked: force-push is forbidden
Type `echo '{"tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}' | node .claude/hooks/launch.mjs pretool-bash-guard.mjs; echo`
Enter
Sleep 4s

Hide
Type "clear"
Enter
Show

# 3. The secrets gate's red proof from tests/canary/injections.json (selftest Canary 26):
#    a service-role key in a tracked file. The gate names the file, the rule and the fix.
Type "# the agent writes a service-role key into a tracked file"
Enter
Type `printf "export const k = 'sb_secret_9f2a1c4b7e0d3856aa11bb22'\n" > apps/web/lib/leak.ts && git add apps/web/lib/leak.ts`
Enter
# expect: secrets: FAIL (1)
# expect: apps/web/lib/leak.ts:1 — supabase-secret-key
# expect: FIX[secrets]:
# exit: 1
Type "node tools/check-secrets.mjs"
Enter
Sleep 6s

Hide
Type "clear"
Enter
Show

# 4. The fix, and the same gate green again.
Type "git rm -q --cached apps/web/lib/leak.ts && rm apps/web/lib/leak.ts"
Enter
# expect: secrets: OK
Type "node tools/check-secrets.mjs"
Enter
Sleep 4s
