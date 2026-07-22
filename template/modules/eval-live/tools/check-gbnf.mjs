#!/usr/bin/env node
// Gate: gbnf — grammar pre-validation for constrained decoding (eval-live module).
// llama.cpp enforces JSON shape at DECODE time via a GBNF grammar converted from a
// JSON Schema. If the conversion fails — an unsupported keyword, a schema feature
// the converter cannot express — you find out mid-eval on a GPU box. This gate
// runs the SAME converter llama.cpp uses, in check mode, over every schema in
// packages/eval/schemas/*.schema.json, so a grammar-breaking schema change dies
// in CI instead.
// Requires LLAMA_CPP_DIR pointing at a llama.cpp checkout (the GPU runner has
// one); skips loudly elsewhere and FAILS CLOSED when CI requires toolchains.
// SOURCE: docs/harness/gates-catalog.md (eval-live module) [corpus: llamacpp/json-schema]
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fail, failures, ok, skipOrFail } from './lib/gate.mjs'

const GATE = 'gbnf'
const SCHEMA_DIR = 'packages/eval/schemas'

if (!existsSync(SCHEMA_DIR)) {
  fail(GATE, `${SCHEMA_DIR} not found — the eval-live module ships it; restore it`)
}
const schemas = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.schema.json'))
if (schemas.length === 0) {
  fail(
    GATE,
    `${SCHEMA_DIR} contains no *.schema.json — a grammar gate with nothing to check is vacuous`,
  )
}

const llamaDir = process.env.LLAMA_CPP_DIR
if (!llamaDir) {
  skipOrFail(
    GATE,
    'LLAMA_CPP_DIR not set (point it at a llama.cpp checkout; the GPU runner sets it)',
  )
}

// The converter has moved around llama.cpp's tree over time; accept the known homes.
const converter = ['examples/json_schema_to_grammar.py', 'scripts/json_schema_to_grammar.py']
  .map((rel) => join(llamaDir, rel))
  .find((p) => existsSync(p))
if (!converter) {
  fail(
    GATE,
    `json_schema_to_grammar.py not found under ${llamaDir} (checked examples/ and scripts/)`,
  )
}

const errs = []
for (const schema of schemas) {
  const schemaPath = join(SCHEMA_DIR, schema)
  let grammar = ''
  try {
    grammar = execFileSync('python3', [converter, schemaPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    errs.push(`${schemaPath}: conversion FAILED — ${String(e.stderr ?? e.message).slice(0, 400)}`)
    continue
  }
  // A grammar without a root rule constrains nothing — that's a silent no-op, not a pass.
  if (!/^root\s*::=/m.test(grammar)) {
    errs.push(
      `${schemaPath}: converter produced no root rule — the grammar would constrain nothing`,
    )
  }
}

failures(GATE, errs)
ok(GATE, `${schemas.length} schema(s) convert to valid GBNF grammars`)
