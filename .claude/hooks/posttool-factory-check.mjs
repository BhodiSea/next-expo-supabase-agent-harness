#!/usr/bin/env node
// FACTORY dogfood: the per-edit provenance check, run on the harness's own edits.
//
// The shipped harness wires posttool-source-check on every Edit/Write, so a decision site
// written without a `// SOURCE:` citation is caught at the moment of the edit rather than
// at the end of the turn. The factory wired NO PostToolUse hook at all until 0.3.0 — and
// the factory writes exactly the same class of decision site (every gate script cites the
// doctrine it enforces), so the layer the harness demands of consumers was the one layer
// its own authors never got.
//
// A THIN ADAPTER, not a fork. The only thing that needs translating is the PATH the hook
// is told about: a consumer's `packages/api/src/x.ts` is this repo's
// `template/stack/packages/api/src/x.ts`. Everything else — the heuristic, the
// decision-group data, the message — is the exact bytes consumers run, resolved from the
// shipped hook itself, so a change to that hook reaches this one the same day.
//
// Advisory by construction: PostToolUse feedback informs the turn, and the tree-wide
// closure is `check-sources.mjs` inside validate. This hook exists so a missing citation
// is noticed while the author still remembers why the line is there.
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { readHookInput } from '../../template/base/.claude/hooks/lib/hookio.mjs'

const SHIPPED = fileURLToPath(
  new URL('../../template/base/.claude/hooks/posttool-source-check.mjs', import.meta.url),
)
// The shipped hook resolves its rules relative to the INSTALL ROOT, which for the bytes in
// this repo is template/base/ — so that is the cwd and CLAUDE_PROJECT_DIR it runs under.
const TEMPLATE_ROOT = fileURLToPath(new URL('../../template/base/', import.meta.url))

const input = await readHookInput()
const raw = String(input?.tool_input?.file_path ?? input?.tool_input?.path ?? '')
if (raw === '') process.exit(0)

const root = (process.env.CLAUDE_PROJECT_DIR ?? process.cwd()).split('\\').join('/')
const posix = raw.split('\\').join('/')
const rel = posix.startsWith(root) ? posix.slice(root.length).replace(/^\/+/, '') : posix

// Anything outside the two template trees (the installer, the scripts, the tests) is not a
// PRODUCT decision site; those are covered by the factory's own closure checks in
// stop-factory-gate.mjs.
const TEMPLATE_PREFIX = /^template\/(?:base|stack|modules\/[^/]+|presets\/[^/]+)\//
if (!TEMPLATE_PREFIX.test(rel)) process.exit(0)
const consumerPath = rel.replace(TEMPLATE_PREFIX, '')

const res = spawnSync(process.execPath, [SHIPPED], {
  input: JSON.stringify({
    ...input,
    tool_input: { ...input.tool_input, file_path: consumerPath },
  }),
  encoding: 'utf8',
  cwd: TEMPLATE_ROOT,
  env: { ...process.env, CLAUDE_PROJECT_DIR: TEMPLATE_ROOT },
})
// The shipped hook's own exit code and stderr are the verdict — passing them through
// unaltered is what makes this an adapter rather than a second opinion.
if (res.stderr) process.stderr.write(res.stderr)
process.exit(res.status ?? 0)
