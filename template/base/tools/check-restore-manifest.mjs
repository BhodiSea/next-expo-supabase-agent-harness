#!/usr/bin/env node
// Lane tool (deploy-record.yml, job `restore-manifest`) — binds the platform's
// backup FACT to the latest deploy manifest and emits the RB-02 record: data,
// applications and settings named at a common point in time, WITH the verified
// exclusions the platform backup is known not to contain (the Vault root key
// above all — the thing most likely to be discovered during a real recovery
// rather than before one). Scheduled beside backup-evidence, same clock, same
// no-PR-blocking posture; emit-after-judge like every artefact in this family.
//
//   env: SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF (the same pair
//   backup-evidence uses); usage: [--manifest=artifacts/deploy-manifest.json]
// SOURCE: tools/lib/deploy-record.mjs (judgeRestoreBinding — the RB-02 shape)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { judgeRestoreBinding } from './lib/deploy-record.mjs'
import { fail, failures, ok, skipOrFail } from './lib/gate.mjs'

const GATE = 'restore-manifest'
const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback

const manifestPath = arg('manifest', 'artifacts/deploy-manifest.json')
if (!existsSync(manifestPath)) {
  skipOrFail(
    GATE,
    `${manifestPath} not found — no deploy-record artifact to bind (has a deployment run the deploy-record job?)`,
  )
}
let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (e) {
  fail(GATE, `${manifestPath} is not valid JSON (${e.message})`)
}

const token = process.env.SUPABASE_ACCESS_TOKEN
const ref = process.env.SUPABASE_PROJECT_REF
if (!token || !ref) {
  skipOrFail(
    GATE,
    'SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF not set — the backup fact lives in the platform control plane (the backup-evidence posture, one job over)',
  )
}

// The same control-plane read backup-evidence performs: one HTTPS GET, judged.
const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/backups`, {
  headers: { authorization: `Bearer ${token}` },
})
if (!res.ok) {
  fail(
    GATE,
    `the backups endpoint answered ${String(res.status)} — a restore manifest cannot bind a backup fact it could not read`,
  )
}
const body = await res.json()
const completed = (body.backups ?? [])
  .filter((b) => /completed/i.test(String(b.status ?? '')))
  .map((b) => String(b.inserted_at ?? b.created_at ?? ''))
  .sort()
const backup = body.pitr_enabled
  ? { mechanism: 'pitr', latestAt: null }
  : { mechanism: 'daily-backup', latestAt: completed.at(-1) ?? null }

const { problems, record } = judgeRestoreBinding({ manifest, backup })
failures(
  GATE,
  problems,
  '\nRB-02 binds three asset classes to one point in time; a binding that fails its own judgement is not emitted.',
)

mkdirSync('artifacts', { recursive: true })
writeFileSync('artifacts/restore-manifest.json', `${JSON.stringify(record, null, 2)}\n`)
ok(
  GATE,
  `restore manifest bound: ${backup.mechanism}${backup.latestAt ? ` (latest completed ${backup.latestAt})` : ''} ↔ commit ${manifest.commit.slice(0, 12)} @ ${manifest.deployedAt} — ${String(manifest.migrations.length)} migration(s), ${String(manifest.functions.length)} function(s), ${String(record.knownExclusions.length)} known exclusion(s) carried in the artefact`,
)
