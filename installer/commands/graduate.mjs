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
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { installerVersion, readManifest, writeManifest } from '../lib/manifest.mjs'
import { rollbackDirFor } from '../lib/rollback.mjs'

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

// THE STAMP CACHE MUST NOT DECIDE A GRADUATION (0.10.0). tools/lib/gate.mjs#stampGate
// short-circuits a gate to `ok(… inputs unchanged since last green run …)` when its declared
// inputs are byte-identical to the last GREEN run and we are not in CI — and a gate that does
// not RUN prints no ramp NOTE. graduate's entire contract is "advance only if zero ramp NOTEs
// remain", so a cached green reads to it as "nothing outstanding" while findings are in fact
// being withheld. It then advances baseVersion, which is the very act that makes those
// findings turn-fatal: the ambush the ramp system exists to prevent, delivered by the command
// whose job is to prevent it.
//
// FOUND BY UPGRADE-LANE LEG A at 0.10.0 — the first release whose leg A reaches graduate with
// a GREEN validate and outstanding NOTEs. It watched graduate advance 0.9.9 → 0.10.0 over two
// withheld findings (version-sync's arrived eol acceptance, rate-limits' outage fallback) and
// leave the install RED on its next validate.
//
// Invalidating the stamps rather than setting CI=true: CI also flips every toolchain-dependent
// gate from skip-loudly to fail-closed, so a consumer graduating on a workstation with no
// database running would meet a red chain and a refusal that is about their laptop rather than
// their sweep. The stamp is documented as "a local convenience, never proof"; this is a place
// that needs proof, and nothing else.
//
// `.sort()` because the determinism sweep holds every directory read in this repo to a stable
// order — the rule the harness ships to consumers, applied to its own installer.
/** @param {string} targetDir */
function clearGateStamps(targetDir) {
  const stampDir = join(targetDir, '.harness')
  if (!existsSync(stampDir)) return
  for (const f of readdirSync(stampDir).sort()) {
    if (f.endsWith('.ok')) rmSync(join(stampDir, f), { force: true })
  }
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

  clearGateStamps(targetDir)

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
    // SAY WHICH GATE. Without this the refusal is undiagnosable: the reader is told the
    // whole chain is red and not which step, so their only route to the answer is
    // to re-run validate by hand and hope it reproduces. The upgrade lane hit exactly
    // that dead end — a red visible only in CI, reported as one unattributed sentence.
    // A gate reds as `<gate>: FAIL …`, optionally followed by `  - <detail>` bullets; the
    // chain stops at the first one, so the bullets in scope belong to it. Fall back to the
    // tail rather than printing nothing — a gate that died without the harness's own
    // formatting is exactly when the raw output is worth most.
    const lines = out.trimEnd().split('\n')
    const reds = lines.filter(
      (l, i) => /^\S+: FAIL\b/.test(l) || (/^ *- /.test(l) && /^\S+: FAIL\b/.test(lines[i - 1] ?? '')),
    )
    for (const line of reds.length > 0 ? reds : lines.slice(-15)) console.error(`  ${line}`)
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
  // The rollback blob predates this graduation: restoring it would silently
  // regress baseVersion — worse than having no snapshot. Delete it here, the
  // one place the tree's vintage deliberately advances.
  rmSync(rollbackDirFor(targetDir), { recursive: true, force: true })
  console.log(
    `graduate: clean — baseVersion advanced ${typeof base === 'string' ? base : '(none)'} → ${target}. The ramped checks up to v${target} are now turn-fatal on this install.`,
  )
  return 0
}
