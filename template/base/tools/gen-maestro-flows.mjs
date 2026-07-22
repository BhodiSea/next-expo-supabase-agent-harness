#!/usr/bin/env node
// tools/gen-maestro-flows.mjs — the flow generator CLI over tools/lib/maestro-flows.mjs.
//
// Three verbs, all pure functions of committed data (src/routes.ts, the identity lock,
// the interaction budgets) — never hand-copied YAML:
//
//   --sweep [--out <file>]         The generated route sweep (every ROUTES entry deep-
//                                  linked and container-asserted). Run-time output for
//                                  the device lane; NEVER commit it (no copy, no drift).
//   --perf-harness [--out <file>]  The perf-harness journey, budgets read from
//                                  tools/interaction-budget.json into the deep link.
//   --flow <id>                    Scaffold the COMMITTED maestro/flows/<id>.yaml the
//                                  mobile-perf closure demands for a new route. Refuses
//                                  to overwrite — an existing flow is hand-tuned nav.
//
// tools/check-e2e-device.mjs imports the same builders directly; this CLI exists for
// humans and for the scaffold step an agent runs when the closure gate names a missing
// flow file.
// SOURCE: docs/harness/gates-catalog.md (mobile-perf closure; CI-only device lane) [corpus: harness/doctrine]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
import {
  budgetsFromInteractionFile,
  buildPerfHarnessYaml,
  buildRouteFlowYaml,
  buildSweepYaml,
} from './lib/maestro-flows.mjs'
import { parseRoutes, readAppIdentity } from './lib/mobile-app-meta.mjs'

const ROUTES_FILE = 'apps/mobile/src/routes.ts'
const IDENTITY_LOCK = 'tools/identity.lock.json'
const BUDGET_FILE = 'tools/interaction-budget.json'
const FLOWS_DIR = 'maestro/flows'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const valueOf = (name) => {
  const at = args.indexOf(name)
  return at !== -1 && at + 1 < args.length ? args[at + 1] : null
}

function die(message) {
  console.error(`gen-maestro-flows: ${message}`)
  process.exit(1)
}

function emit(outPath, yaml, label) {
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, yaml)
  console.log(`gen-maestro-flows: wrote ${label} -> ${outPath}`)
}

let routes
let identity
try {
  routes = parseRoutes(ROUTES_FILE)
  identity = readAppIdentity(IDENTITY_LOCK)
} catch (e) {
  die(e instanceof Error ? e.message : String(e))
}

if (flag('--sweep')) {
  const out = valueOf('--out') ?? 'artifacts/maestro/route-sweep.yaml'
  emit(out, buildSweepYaml(routes, identity), `route sweep (${String(routes.length)} routes)`)
} else if (flag('--perf-harness')) {
  if (!existsSync(BUDGET_FILE)) {
    die(
      `${BUDGET_FILE} is missing — the perf-harness journey carries its caps, so there is nothing to generate`,
    )
  }
  let budgets
  try {
    budgets = budgetsFromInteractionFile(JSON.parse(readFileSync(BUDGET_FILE, 'utf8')))
  } catch (e) {
    die(e instanceof Error ? e.message : String(e))
  }
  const out = valueOf('--out') ?? 'artifacts/maestro/perf-harness.yaml'
  emit(out, buildPerfHarnessYaml(identity, budgets), 'perf-harness journey')
} else if (valueOf('--flow') !== null) {
  const id = valueOf('--flow')
  const route = routes.find((r) => r.id === id)
  if (route === undefined) {
    die(`no ROUTES entry has id '${String(id)}' — register the route in ${ROUTES_FILE} first`)
  }
  const out = `${FLOWS_DIR}/${route.id}.yaml`
  if (existsSync(out)) {
    die(
      `${out} already exists — flows are hand-tuned after scaffolding; edit it instead of regenerating over it`,
    )
  }
  emit(out, buildRouteFlowYaml(route, identity), `flow scaffold for route '${route.id}'`)
} else {
  die(
    'usage: gen-maestro-flows --sweep [--out <file>] | --perf-harness [--out <file>] | --flow <route-id>',
  )
}
