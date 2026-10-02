# Claude Code hook surfaces for context injection (research, 2026-10-01)

Source: claude-code-guide research agent, against https://code.claude.com/docs/en/hooks.md,
hooks-guide.md, sub-agents.md, tools-reference.md.

1. **SubagentStart** exists. Input: `hook_event_name`, `agent_id`, `agent_type`. Output:
   `hookSpecificOutput.additionalContext` (10,000-char cap). Cannot block (exit 2 = stderr to user only).
   GAP: docs do not say whether the context lands in the SUBAGENT's conversation or the parent's —
   must be probed empirically.
2. **PreToolUse on the `Agent` tool** may return `hookSpecificOutput.updatedInput`, but whether that can
   rewrite the subagent's prompt text is NOT documented (low confidence) — probe empirically.
3. **PostToolUse on Edit/Write** may return `{"hookSpecificOutput":{"hookEventName":"PostToolUse",
   "additionalContext":"..."}}` — appears as a system reminder beside the tool result, no error framing.
   10,000-char cap; above it the text is saved to a file and a path + 2,000-char preview is shown.
4. **UserPromptSubmit / SessionStart** `additionalContext`: same 10,000-char cap. SessionStart also has
   `sessionTitle`, `watchPaths`, `reloadSkills`, `initialUserMessage`.
5. **Inheritance:** hooks in `.claude/settings.json` DO fire for tool events made inside subagents;
   SubagentStart/SubagentStop fire on spawn/stop. Frontmatter hooks of other agents do not inherit.
6. **Subagent frontmatter** supports `hooks:`, `skills:`, `mcpServers:` (plus tools/disallowedTools).
   A read-only reviewer can be given an MCP server; read-only is not automatic for MCP tools — restrict
   with `disallowedTools` / permission rules (the harness's pretool-mcp-guard already enforces readOnly
   servers by tool-name shape).
7. **Caps/timeouts:** additionalContext/systemMessage/stdout 10,000 chars. Command hook default timeout
   600 s (override per hook); prompt hooks 30 s; agent hooks 60 s.

Open empirical probes: (a) SubagentStart additionalContext destination; (b) Agent-tool updatedInput
prompt rewrite; (c) whether a PostToolUse hook fired by a subagent's own Edit reaches that subagent.
