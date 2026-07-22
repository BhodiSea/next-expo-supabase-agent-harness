// Unit tests for the retrofit merges of .claude/settings.json and .gitignore.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { mergeClaudeSettings } from '../../installer/lib/merge-claude-settings.mjs'
import { mergeGitignore } from '../../installer/lib/merge-gitignore.mjs'

const HARNESS_SETTINGS = readFileSync(
  fileURLToPath(new URL('../../template/base/.claude/settings.json', import.meta.url)),
  'utf8',
)

test('mergeClaudeSettings: harness wiring added, their choices kept', () => {
  const theirs = {
    env: { MY_FLAG: '1' },
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'their-guard.sh', timeout: 5 }] },
      ],
    },
    permissions: {
      allow: ['Bash(make test)'],
      deny: ['Read(./secrets/**)'],
      defaultMode: 'default',
    },
    statusLine: { type: 'command', command: 'their-statusline.sh' },
  }
  const res = mergeClaudeSettings(JSON.stringify(theirs), HARNESS_SETTINGS)
  assert.notEqual(res, null)
  const merged = JSON.parse(res.merged)

  // Their choices survive.
  assert.equal(merged.env.MY_FLAG, '1')
  assert.equal(merged.permissions.defaultMode, 'default')
  assert.equal(merged.statusLine.command, 'their-statusline.sh')
  assert.ok(merged.permissions.allow.includes('Bash(make test)'))
  assert.ok(merged.permissions.deny.includes('Read(./secrets/**)'))
  assert.ok(merged.hooks.PreToolUse.some((g) => g.hooks?.[0]?.command === 'their-guard.sh'))

  // Harness wiring lands: every hook, the deny rules, the env, MCP servers.
  const allCommands = Object.values(merged.hooks)
    .flat()
    .flatMap((g) => (g.hooks ?? []).map((h) => h.command))
  for (const hook of [
    'pretool-bash-guard',
    'pretool-write-guard',
    'posttool-source-check',
    'posttool-fast-check',
    'stop-validate-gate',
  ]) {
    assert.ok(allCommands.some((c) => c.includes(hook)), `missing hook wiring: ${hook}`)
  }
  assert.ok(merged.permissions.deny.some((d) => d.includes('.claude/hooks')), 'harness deny rules missing')
  assert.equal(merged.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP, '8')
  assert.ok(merged.enabledMcpjsonServers.includes('corpus_search'))
})

test('mergeClaudeSettings: idempotent when harness wiring already present', () => {
  const once = mergeClaudeSettings('{}', HARNESS_SETTINGS)
  const twice = mergeClaudeSettings(once.merged, HARNESS_SETTINGS)
  const a = JSON.parse(once.merged)
  const b = JSON.parse(twice.merged)
  assert.equal(
    b.hooks.PreToolUse.length,
    a.hooks.PreToolUse.length,
    'repeat merge must not duplicate hook groups',
  )
  assert.deepEqual(b.permissions.deny.sort(), a.permissions.deny.sort())
})

test('mergeClaudeSettings: unparseable input returns null (caller parks a conflict)', () => {
  assert.equal(mergeClaudeSettings('{ not json', HARNESS_SETTINGS), null)
  assert.equal(mergeClaudeSettings('[]', HARNESS_SETTINGS), null)
})

test('mergeGitignore: appends missing patterns once, keeps theirs verbatim', () => {
  const theirs = '# mine\nnode_modules/\ndist/\n'
  const ours = 'node_modules/\ntarget/\n.dev-auth/\n# comment ignored\n'
  const { merged, added } = mergeGitignore(theirs, ours)
  assert.ok(merged.startsWith('# mine\nnode_modules/\ndist/\n'))
  assert.deepEqual(added, ['target/', '.dev-auth/'])
  // Idempotent.
  const again = mergeGitignore(merged, ours)
  assert.deepEqual(again.added, [])
  assert.equal(again.merged, merged)
})
