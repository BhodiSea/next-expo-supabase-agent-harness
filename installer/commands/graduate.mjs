// `graduate` (G26) — advance an upgraded install's baseVersion once its ramped checks
// are clean. The version ramp (tools/lib/gate.mjs#rampNote) downgrades a not-yet-adopted
// check to a NOTE on installs whose baseVersion predates it, so a pre-0.1.6 consumer is
// never ambushed by a new gate. That protection used to be advisory FOREVER: the only way
// to make the semantic checks turn-fatal was a hand edit of .harness/manifest.json.
//
// This closes that loop deterministically: run the ramp-aware validate, and ONLY if it
// emits zero ramp NOTEs advance baseVersion to the installed harness version — so the
// checks become turn-fatal exactly when the project has actually swept the findings, never
// before. Refuses (and lists the outstanding NOTEs) while any remain. Idempotent.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { installerVersion, readManifest, writeManifest } from '../lib/manifest.mjs'

/** @param {string} a @param {string} b */
function cmpDotted(a, b) {
  const pa = String(a).split('.')
  const pb = String(b).split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const na = Number.parseInt(pa[i] ?? '0', 10)
    const nb = Number.parseInt(pb[i] ?? '0', 10)
    if (na !== nb) return na < nb ? -1 : 1
  }
  return 0
}

export async function graduate(opts) {
  const targetDir = opts.dir
  const manifest = readManifest(targetDir)
  if (!manifest) {
    console.error('graduate: no .harness/manifest.json — run `init` first')
    return 1
  }
  const target = installerVersion()
  const base = manifest.baseVersion ?? manifest.harnessVersion
  if (typeof base === 'string' && cmpDotted(base, target) >= 0) {
    console.log(`graduate: baseVersion already ${base} (>= ${target}) — nothing to graduate`)
    return 0
  }
  if (!existsSync(join(targetDir, 'tools/validate.mjs'))) {
    console.error('graduate: tools/validate.mjs not found — is this an installed harness?')
    return 1
  }

  console.log(
    `graduate: running the ramp-aware validate to confirm the pre-${target} findings are swept…`,
  )
  // Run the real chain in the target project. The ramp gates print `NOTE — … (ramp …)`
  // for anything still outstanding; a clean run prints none.
  const res = spawnSync('node', ['tools/validate.mjs'], {
    cwd: targetDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`

  if (res.status !== 0) {
    console.error(
      'graduate: validate is RED — fix the failures first, then graduate. (Graduation only tightens ramped checks; it never masks a real red.)',
    )
    return 1
  }

  // A ramp NOTE is `<gate>: NOTE — … (ramp …)` (rampNote) or `<gate>: NOTE — (ramp) …`
  // (the docs-sync catalog lockstep). Either shape means findings remain withheld.
  const rampLines = out
    .split('\n')
    .filter((l) => /NOTE\s*—/.test(l) && /ramp/i.test(l))
  if (rampLines.length > 0) {
    console.error(
      `graduate: ${String(rampLines.length)} ramped finding(s) still outstanding — sweep these, then re-run graduate:`,
    )
    for (const l of rampLines) console.error(`  ${l.trim()}`)
    return 1
  }

  writeManifest(targetDir, { ...manifest, baseVersion: target })
  console.log(
    `graduate: clean — baseVersion advanced ${typeof base === 'string' ? base : '(none)'} → ${target}. The ramped checks up to v${target} are now turn-fatal on this install.`,
  )
  return 0
}
