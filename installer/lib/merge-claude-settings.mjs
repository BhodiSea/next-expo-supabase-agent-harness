// Retrofit merge for .claude/settings.json. Without this, a project that
// already carries Claude Code settings would either lose them (clobber) or
// never receive the harness enforcement wiring (skip) — and an unwired
// settings.json means NO hooks run, i.e. the harness is silently inert.
// Semantics: theirs is the base; harness hooks / permissions / env / MCP
// servers are ADDED, never replacing an existing choice. Returns null when
// either side is not parseable JSON (caller parks ours as a conflict).
// eslint-disable-next-line sonarjs/cognitive-complexity -- ceiling is machine-enforced by scripts/complexity-ratchet.json (G16); this directive only silences the rule, the ratchet is what stops the score growing
export function mergeClaudeSettings(existingText, incomingText) {
  let theirs
  let ours
  try {
    theirs = JSON.parse(existingText)
    ours = JSON.parse(incomingText)
  } catch {
    return null
  }
  if (typeof theirs !== 'object' || theirs === null || Array.isArray(theirs)) return null

  const merged = structuredClone(theirs)
  const report = []

  // env: add missing keys only.
  merged.env = { ...(ours.env ?? {}), ...(theirs.env ?? {}) }

  // MCP servers: union.
  merged.enabledMcpjsonServers = [
    ...new Set([...(theirs.enabledMcpjsonServers ?? []), ...(ours.enabledMcpjsonServers ?? [])]),
  ]

  // hooks: per event, append each harness hook GROUP whose command set is not
  // already wired. Identity = the hook command strings (paths are stable:
  // $CLAUDE_PROJECT_DIR/.claude/hooks/<name>.mjs).
  merged.hooks = { ...(theirs.hooks ?? {}) }
  for (const [event, ourGroups] of Object.entries(ours.hooks ?? {})) {
    const theirGroups = Array.isArray(merged.hooks[event]) ? [...merged.hooks[event]] : []
    const theirCommands = new Set(
      theirGroups.flatMap((g) => (g.hooks ?? []).map((h) => h.command).filter(Boolean)),
    )
    for (const group of ourGroups) {
      const cmds = (group.hooks ?? []).map((h) => h.command).filter(Boolean)
      if (cmds.every((c) => theirCommands.has(c))) continue
      theirGroups.push(group)
      report.push({ kind: 'hooks-added', event, commands: cmds })
    }
    merged.hooks[event] = theirGroups
  }

  // permissions: union each list (deny rules and gate allowances must land);
  // scalar settings (defaultMode, disableBypassPermissionsMode) keep theirs
  // when present — overriding a human's permission posture is not our call.
  const theirPerm = theirs.permissions ?? {}
  const ourPerm = ours.permissions ?? {}
  merged.permissions = { ...ourPerm, ...theirPerm }
  for (const list of ['allow', 'ask', 'deny']) {
    merged.permissions[list] = [...new Set([...(theirPerm[list] ?? []), ...(ourPerm[list] ?? [])])]
  }
  for (const scalar of ['defaultMode', 'disableBypassPermissionsMode']) {
    if (theirPerm[scalar] !== undefined && ourPerm[scalar] !== undefined && theirPerm[scalar] !== ourPerm[scalar]) {
      report.push({ kind: 'scalar-kept', name: `permissions.${scalar}`, existing: theirPerm[scalar], harness: ourPerm[scalar] })
    }
  }

  // statusLine: only when they have none.
  if (merged.statusLine === undefined && ours.statusLine !== undefined) {
    merged.statusLine = ours.statusLine
  }
  if (merged.$schema === undefined && ours.$schema !== undefined) merged.$schema = ours.$schema

  return { merged: `${JSON.stringify(merged, null, 2)}\n`, report }
}
