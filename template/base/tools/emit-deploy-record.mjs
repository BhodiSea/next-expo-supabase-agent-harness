#!/usr/bin/env node
// Lane tool (deploy-record.yml, job `deploy-record`) — the deploy-time artefact
// channel's EMITTER. Builds the manifest of what this checkout ships (the commit,
// the migration set, the Edge Function trees, the resolved dependency set) and
// judges it with deployManifestProblems() BEFORE writing: the artefact a reader
// downloads later is one that passed. Never a chain step — it describes a
// DEPLOYMENT EVENT, which `pnpm validate` does not have.
//
//   env: DEPLOY_COMMIT (the deployed sha), DEPLOYED_AT (the deployment event's own
//   timestamp — never invented here), DEPLOY_SURFACE (the environment name).
// SOURCE: tools/lib/deploy-record.mjs (the judgements and the ASD-numbers rule)
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { deployManifestProblems } from './lib/deploy-record.mjs'
import { fail, ok } from './lib/gate.mjs'
import { parseLockVersions } from './lib/framework-floor.mjs'
import { walkFiles } from './lib/fs-walk.mjs'

const GATE = 'deploy-record'
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

const commit = process.env.DEPLOY_COMMIT ?? ''
const deployedAt = process.env.DEPLOYED_AT ?? ''
const surface = process.env.DEPLOY_SURFACE ?? ''

const migrations = existsSync('supabase/migrations')
  ? readdirSync('supabase/migrations')
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((name) => ({ name, sha256: sha256(readFileSync(join('supabase/migrations', name))) }))
  : []

// One hash per function DIRECTORY (name + every file's bytes, order-stable), so a
// changed shared helper inside a function changes that function's identity.
const functions = existsSync('supabase/functions')
  ? readdirSync('supabase/functions', { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .map((name) => {
        const h = createHash('sha256')
        for (const rel of walkFiles(join('supabase/functions', name))) {
          h.update(rel).update(readFileSync(join('supabase/functions', name, rel)))
        }
        return { name, sha256: h.digest('hex') }
      })
  : []

if (!existsSync('pnpm-lock.yaml')) {
  fail(
    GATE,
    'no pnpm-lock.yaml in the deployed checkout — a manifest without the resolution set starves the patch-window judgement',
  )
}
const lockText = readFileSync('pnpm-lock.yaml', 'utf8')
const resolutions = [...parseLockVersions(lockText).entries()].flatMap(([name, versions]) =>
  [...versions].map((version) => ({ name, version })),
)

const manifest = {
  commit,
  deployedAt,
  surface,
  packageVersion: JSON.parse(readFileSync('package.json', 'utf8')).version,
  lockfileSha: sha256(lockText),
  migrations,
  functions,
  resolutions,
}

const problems = deployManifestProblems(manifest)
if (problems.length > 0) {
  fail(
    GATE,
    `the deploy manifest does not pass its own judgement — nothing is emitted:\n  - ${problems.join('\n  - ')}`,
  )
}

mkdirSync('artifacts', { recursive: true })
writeFileSync('artifacts/deploy-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`)
ok(
  GATE,
  `deploy manifest emitted for ${surface} @ ${commit.slice(0, 12)} — ${String(migrations.length)} migration(s), ${String(functions.length)} function(s), ${String(resolutions.length)} resolution(s) bound to ${deployedAt}`,
)
