#!/usr/bin/env node
// Lane tool (deploy-record.yml, job `patch-window`) — joins the DEPLOYED
// resolution set against OSV advisory publication dates and judges ASD's verbatim
// windows (PA-06 48 hours, PA-07 two weeks, PA-10 one month — and no invented
// ones). Scheduled + dispatch only, never a chain step: the judgement is clockful
// and network-bound BY SUBJECT — "how long has this advisory been public" cannot
// be answered hermetically — which is exactly the property that bars it from
// `pnpm validate` (the pnpm-audit reasoning) and licenses it here.
//
//   usage: node tools/check-patch-window.mjs [--manifest=artifacts/deploy-manifest.json] [--now=ISO]
//   The manifest is the LATEST deploy-record artifact, downloaded by the workflow —
//   the judgement runs against what is DEPLOYED, never against what main resolves
//   today (an undeployed fix satisfies no window).
// SOURCE: tools/lib/deploy-record.mjs (the window mapping and the ASD-numbers rule)
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { deployManifestProblems, judgePatchWindows } from './lib/deploy-record.mjs'
import { fail, failures, ok, skipOrFail } from './lib/gate.mjs'

const GATE = 'patch-window'
const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback

const manifestPath = arg('manifest', 'artifacts/deploy-manifest.json')
// A parameter for the red-proof's sake, exactly like floor-review's --today.
const now = arg('now', new Date().toISOString())

if (!existsSync(manifestPath)) {
  // No deployment has ever emitted a manifest: on a project that deploys, the
  // workflow downloads the latest one before this runs, so absence here means the
  // channel is not wired — loud skip locally, fail in CI (the toolchain asymmetry).
  skipOrFail(GATE, `${manifestPath} not found — no deploy-record artifact to judge (has a deployment run the deploy-record job?)`)
}

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (e) {
  fail(GATE, `${manifestPath} is not valid JSON (${e.message})`)
}
const shape = deployManifestProblems(manifest)
if (shape.length > 0) {
  fail(GATE, `the deploy manifest does not pass its own judgement:\n  - ${shape.join('\n  - ')}`)
}

// The production closure the PA-06/PA-07 mapping keys on: everything the deployed
// service resolves. The manifest's resolutions ARE that set (emitted from the
// deployed checkout's lockfile); build-time-only granularity is not recoverable
// from a lockfile alone, so the mapping treats every deployed resolution as the
// online service and reserves PA-10 for advisories whose subject the OSV record
// scopes to development tooling — the CONSERVATIVE direction: a dev-only advisory
// judged at two weeks reds earlier than ASD demands, never later.
async function queryOsv(resolutions) {
  const queries = resolutions.map((r) => ({
    package: { name: r.name, ecosystem: 'npm' },
    version: r.version,
  }))
  const out = []
  // querybatch caps at 1000 queries per call.
  for (let i = 0; i < queries.length; i += 1000) {
    const res = await fetch('https://api.osv.dev/v1/querybatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queries: queries.slice(i, i + 1000) }),
    })
    if (!res.ok) fail(GATE, `OSV querybatch answered ${String(res.status)} — the judgement cannot run blind, and a network fault must never read as "no advisories"`)
    const body = await res.json()
    for (const [j, r] of (body.results ?? []).entries()) {
      for (const v of r?.vulns ?? []) {
        out.push({ id: v.id, resolution: resolutions[i + j] })
      }
    }
  }
  return out
}

async function vulnDetail(id) {
  const res = await fetch(`https://api.osv.dev/v1/vulns/${id}`)
  if (!res.ok) fail(GATE, `OSV vuln fetch for ${id} answered ${String(res.status)}`)
  return res.json()
}

const hits = await queryOsv(manifest.resolutions)
const vulns = []
for (const { id, resolution } of hits) {
  const d = await vulnDetail(id)
  const severity = JSON.stringify(d.database_specific?.severity ?? '') + JSON.stringify(d.severity ?? '')
  vulns.push({
    id,
    package: resolution.name,
    version: resolution.version,
    published: d.published,
    critical: /critical/i.test(severity) || Boolean(d.database_specific?.cisa_kev),
    production: true,
    fixedIn: d.affected?.[0]?.ranges?.[0]?.events?.find((e) => e.fixed)?.fixed,
  })
}

const { findings, judged } = judgePatchWindows({ manifest, vulns, now })
failures(GATE, findings, '\nThe windows are ASD\'s verbatim numbers (PA-06/PA-07/PA-10). The remediation is a DEPLOY: the judgement measures the deployed resolution set, so merging a bump satisfies nothing until it ships.')
ok(
  GATE,
  `${String(manifest.resolutions.length)} deployed resolution(s) joined against OSV — ${String(judged)} advisory hit(s), none outside ASD's windows (deployed ${manifest.deployedAt}, judged at ${now})`,
)
