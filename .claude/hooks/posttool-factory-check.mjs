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
// THE HOOK RUNS FROM THE EDITED LAYER (2.0.3, #223). The shipped hook reads the consumer path
// from its working directory and exits 0 when that read fails. Through 2.0.2 this adapter
// stripped any layer's prefix but always ran the hook from template/base/, so an edit to
// template/stack/<p>, template/modules/<module>/<p> or template/presets/<preset>/<p> was
// judged on template/base/<p>, a file that is usually not there (and a different one when it
// is), and template/demo/ was not a layer at all: those edits passed unread. The working
// directory is now the root of the layer the edit is under, so the consumer path resolves to
// the edited file.
//
// Advisory by construction: PostToolUse feedback informs the turn, and the tree-wide
// closure is `check-sources.mjs` inside validate. This hook exists so a missing citation
// is noticed while the author still remembers why the line is there.
//
// ALL THREE CHANNELS PASS THROUGH (1.1.0, #69). Until then the shipped hook spoke only by
// exiting 2 with stderr, so forwarding stderr and the exit code was the whole verdict. Since
// the advisory split it answers an advisory-class site with a PostToolUse
// `additionalContext` object on STDOUT at exit 0; an adapter that dropped stdout would turn
// that answer into silence. tests/hooks/posttool-factory-check.test.mjs proves the three
// channels arrive byte for byte.
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { readHookInput } from '../../template/base/.claude/hooks/lib/hookio.mjs'

const SHIPPED = fileURLToPath(
  new URL('../../template/base/.claude/hooks/posttool-source-check.mjs', import.meta.url),
)
// The shipped hook loads its tables (tools/decision-groups.json) from CLAUDE_PROJECT_DIR, the
// INSTALL ROOT, which for the bytes in this repo is template/base/, whichever layer the edit
// is under: no other layer ships that file.
const TEMPLATE_ROOT = fileURLToPath(new URL('../../template/base/', import.meta.url))

const input = await readHookInput()
const raw = String(input?.tool_input?.file_path ?? input?.tool_input?.path ?? '')
if (raw === '') process.exit(0)

const root = (process.env.CLAUDE_PROJECT_DIR ?? process.cwd()).split('\\').join('/')
const posix = raw.split('\\').join('/')
const rel = posix.startsWith(root) ? posix.slice(root.length).replace(/^\/+/, '') : posix

// Anything outside the template layers (the installer, the scripts, the tests) is not a
// PRODUCT decision site; those are covered by the factory's own closure checks in
// stop-factory-gate.mjs. The layers are every tree an install receives a file from, the same
// list scripts/check-canary-coverage.mjs walks: base, stack, the worked example, each preset
// and each module.
const TEMPLATE_LAYER = /^(template\/(?:base|stack|demo|modules\/[^/]+|presets\/[^/]+))\//
const layer = TEMPLATE_LAYER.exec(rel)
if (layer === null) process.exit(0)
const consumerPath = rel.slice(layer[0].length)

const res = spawnSync(process.execPath, [SHIPPED], {
  input: JSON.stringify({
    ...input,
    tool_input: { ...input.tool_input, file_path: consumerPath },
  }),
  encoding: 'utf8',
  // The root of the layer the edited file sits under, so `consumerPath` resolves to it.
  cwd: resolve(root, layer[1]),
  env: { ...process.env, CLAUDE_PROJECT_DIR: TEMPLATE_ROOT },
})
// The shipped hook's own exit code, stdout and stderr are the verdict — passing them
// through unaltered is what makes this an adapter rather than a second opinion.
if (res.stdout) process.stdout.write(res.stdout)
if (res.stderr) process.stderr.write(res.stderr)
process.exit(res.status ?? 0)
