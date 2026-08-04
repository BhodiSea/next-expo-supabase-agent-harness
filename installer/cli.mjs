#!/usr/bin/env node
// next-expo-supabase-agent-harness installer.
//   npx --yes github:<owner>/next-expo-supabase-agent-harness#<tag> <command> [flags]
// Commands: init | update | doctor | enable <module> | disable <module>
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string', default: '.' },
    tier: { type: 'string', default: 'standard' },
    modules: { type: 'string' },
    yes: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    'refresh-seeded': { type: 'string', multiple: true },
    consume: { type: 'boolean', default: false },
    set: { type: 'string', multiple: true },
    report: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
})

const command = positionals[0]
const opts = {
  dir: resolve(values.dir),
  tier: values.tier,
  modules: values.modules ? values.modules.split(',').map((m) => m.trim()) : undefined,
  yes: values.yes,
  dryRun: values['dry-run'],
  force: values.force,
  refreshSeeded: values['refresh-seeded'],
  consume: values.consume,
  set: values.set,
  report: values.report,
}

const USAGE = `next-expo-supabase-agent-harness

Usage:
  init     [--dir .] [--tier core|standard|strict] [--modules a,b] [--yes]
           [--set VAR=value ...] [--dry-run] [--report json] [--consume]
  update   [--dir .] [--dry-run] [--force] [--report json]
           [--refresh-seeded <path> ...]  (pull the template version of a
           seeded, project-owned file or whole subtree — e.g. a trailing '/'
           dir: overwrite when untouched, park on drift)
  doctor   [--dir .]
  graduate [--dir .]  (advance baseVersion once ramped checks are clean —
           runs validate, refuses while any ramp NOTE remains)
  enable   <module>   (ci-mobile-release, ci-web-deploy, device-e2e, eas-update,
           store-metadata, ci-provenance, gate-a11y-deep, crash-reporting,
           push-notifications, eval-live, observability)
  disable  <module>

Placeholders: PROJECT_NAME PROJECT_SLUG APP_IDENTIFIER APP_SCHEME WEB_ORIGIN
              DESIGN_TOKENS(default|metal) SUPABASE_PROJECT_REF GITHUB_OWNER
              SECURITY_OWNERS DEFAULT_BRANCH EAS_PROJECT_ID ASC_APP_ID
              APPLE_TEAM_ID`

try {
  let code = 0
  if (values.help || command === undefined || command === 'help') {
    console.log(USAGE)
  } else if (command === 'init') {
    const { init } = await import('./commands/init.mjs')
    code = await init(opts)
  } else if (command === 'update') {
    const { update } = await import('./commands/update.mjs')
    code = await update(opts)
  } else if (command === 'doctor') {
    const { doctor } = await import('./commands/doctor.mjs')
    code = await doctor(opts)
  } else if (command === 'graduate') {
    const { graduate } = await import('./commands/graduate.mjs')
    code = await graduate(opts)
  } else if (command === 'enable' || command === 'disable') {
    const { enable } = await import('./commands/enable.mjs')
    code = await enable(opts, positionals[1], command === 'enable')
  } else {
    console.error(`unknown command: ${command}\n\n${USAGE}`)
    code = 1
  }
  process.exit(code)
} catch (err) {
  console.error(`error: ${err.message}`)
  process.exit(1)
}
