// The deploy-time artefact channel's judgements (1.0.0) — pure, so every red is
// provable without a runner. Three consumers, one file:
//   * emit-deploy-record.mjs builds a manifest of WHAT SHIPPED and judges it with
//     deployManifestProblems() BEFORE writing — the backup-evidence doctrine: the
//     artefact a reader downloads six months later is one that passed, never one
//     that merely emitted.
//   * check-patch-window.mjs joins the DEPLOYED resolutions against advisory
//     publication dates with judgePatchWindows() — ASD's verbatim windows
//     (PA-06 48 hours, PA-07 two weeks, PA-10 one month) and NO invented ones:
//     the assessment guidance sets no number for "in a timely manner", and a
//     24- or 72-hour SLA here would manufacture an obligation with no framework
//     backing.
//   * check-restore-manifest.mjs binds the platform's backup fact to the deploy
//     manifest with judgeRestoreBinding() — the RB-02 shape: data (the backup),
//     applications (the commit + function hashes) and settings (the migration
//     set) named at a common point in time, plus the honest exclusions the
//     platform backup is KNOWN not to contain.
// SOURCE: tools/essential-eight.json (PA-06/PA-07/PA-10 timeframes; RB-02 —
// ASD's verbatim numbers are the only ones this file may encode)

const SHA_HEX = /^[0-9a-f]{64}$/
const GIT_SHA = /^[0-9a-f]{40}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/

// Scalar fields, each with the judgement its absence starves.
const SCALARS = [
  ['commit', (v) => typeof v === 'string' && GIT_SHA.test(v), '`commit` must be the deployed 40-hex git sha — without it the restore manifest cannot bind applications to a point in time'],
  ['deployedAt', (v) => typeof v === 'string' && ISO.test(v), '`deployedAt` must be the ISO timestamp of the DEPLOYMENT EVENT (never a wall clock read at judgement time) — it is the anchor both windows are measured from'],
  ['surface', (v) => typeof v === 'string' && v.trim() !== '', '`surface` must name the deployed environment — a manifest that does not say WHAT was deployed binds nothing'],
  ['packageVersion', (v) => typeof v === 'string' && v.trim() !== '', '`packageVersion` must carry the deployed package.json version'],
  ['lockfileSha', (v) => typeof v === 'string' && SHA_HEX.test(v), '`lockfileSha` must be sha256 of the deployed pnpm-lock.yaml — the identity of the resolution set the patch-window judgement runs against'],
]

function hashedListProblems(m, key, what) {
  const list = m[key]
  if (!Array.isArray(list)) {
    return [`\`${key}\` must be an array of {name, sha256} — ${what} is one of the three asset classes the restore manifest exists to bind`]
  }
  const bad = (e) => typeof e?.name !== 'string' || typeof e?.sha256 !== 'string' || !SHA_HEX.test(e.sha256)
  return [...list.entries()]
    .filter(([, e]) => bad(e))
    .map(([i]) => `\`${key}[${i}]\` must be {name, sha256(hex64)} — an unhashed entry cannot prove what shipped`)
}

function resolutionProblems(m) {
  if (!Array.isArray(m.resolutions) || m.resolutions.length === 0) {
    return ['`resolutions` must be the non-empty [{name, version}] set resolved by the deployed lockfile — the patch-window judgement joins advisories against DEPLOYED versions, not against whatever main resolves today']
  }
  const i = m.resolutions.findIndex((r) => typeof r?.name !== 'string' || typeof r?.version !== 'string')
  return i === -1 ? [] : [`\`resolutions[${i}]\` must be {name, version}`]
}

/**
 * Shape problems for a deploy manifest. Every field is load-bearing for one of the
 * two downstream judgements, so a missing one is named with the judgement it starves.
 * @param {any} m
 * @returns {string[]}
 */
export function deployManifestProblems(m) {
  if (m === null || typeof m !== 'object') return ['the deploy manifest is not an object']
  const out = SCALARS.filter(([key, okay]) => !okay(m[key])).map(([, , message]) => message)
  out.push(...hashedListProblems(m, 'migrations', "the migration set (RB-02's settings class)"))
  out.push(...hashedListProblems(m, 'functions', "the deployed Edge Functions (RB-02's applications class)"))
  if (Array.isArray(m.migrations) && m.migrations.length === 0) {
    out.push('`migrations` is EMPTY — this stack always ships migrations, so an empty set means the emitter ran outside the deployed checkout (anti-vacuity)')
  }
  out.push(...resolutionProblems(m))
  return out
}

// ASD's verbatim windows, in milliseconds, and nothing else — see the header.
const WINDOWS = {
  'PA-06': { ms: 48 * 3_600_000, label: '48 hours' },
  'PA-07': { ms: 14 * 86_400_000, label: 'two weeks' },
  'PA-10': { ms: 30 * 86_400_000, label: 'one month' },
}

/**
 * Which register row's window governs a vulnerability in a DEPLOYED dependency.
 * The mapping is stated rather than clever: the deployed web service and its
 * dependency closure ARE the online service, so a vendor-assessed-critical (or
 * known-exploited) advisory takes PA-06's 48 hours and every other
 * online-service advisory takes PA-07's two weeks; PA-10's one month is the
 * ceiling for everything the deployment carries that is not the service itself
 * (build-time and tooling resolutions). Severity comes from the advisory
 * (`critical: true` when the ecosystem severity is CRITICAL or a known-exploited
 * flag is present); production membership from the manifest's own resolution set.
 * @param {{ critical: boolean, production: boolean }} vuln
 */
export function windowFor({ critical, production }) {
  if (production && critical) return 'PA-06'
  if (production) return 'PA-07'
  return 'PA-10'
}

/**
 * The patch-window judgement. `vulns` is the already-joined advisory set for the
 * DEPLOYED resolutions: [{ id, package, version, published (ISO), critical,
 * production, fixedIn? }]. `now` is a parameter for the same reason floor-review's
 * clock is — a red-proof must not wait for a calendar.
 * @param {{ manifest: any, vulns: any[], now: string }} input
 * @returns {{ findings: string[], judged: number }}
 */
export function judgePatchWindows({ manifest, vulns, now }) {
  const findings = []
  const nowMs = Date.parse(now)
  for (const v of vulns) {
    const published = Date.parse(v.published ?? '')
    if (Number.isNaN(published)) {
      findings.push(
        `${v.id} (${v.package}@${v.version}): the advisory carries no parseable published date — a window cannot be measured from nowhere, and treating that as fine would make undated advisories the evasion`,
      )
      continue
    }
    const row = windowFor(v)
    const { ms, label } = WINDOWS[row]
    // The deployment satisfies a window by being deployed AFTER the fix existed for
    // less than the window — i.e. the deployed resolution is still affected AND the
    // advisory has been public longer than the window.
    if (nowMs - published > ms) {
      findings.push(
        `${row}: ${v.id} affects DEPLOYED ${v.package}@${v.version} (surface ${manifest.surface}, deployed ${manifest.deployedAt}) and was published ${v.published} — outside ASD's ${label} window${v.fixedIn ? `; fixed in ${v.fixedIn}` : ''}. Deploy the remediation.`,
      )
    }
  }
  return { findings, judged: vulns.length }
}

/**
 * The RB-02 binding: one artefact naming data, applications and settings at a
 * common point in time — plus the honest exclusions, carried IN the artefact so a
 * restore drill six months later reads them before discovering them.
 * @param {{ manifest: any, backup: { mechanism: string, latestAt: string | null } }} input
 * @returns {{ problems: string[], record: any | null }}
 */
export function judgeRestoreBinding({ manifest, backup }) {
  const problems = []
  const manifestProblems = deployManifestProblems(manifest)
  if (manifestProblems.length > 0) {
    problems.push(...manifestProblems.map((p) => `deploy manifest: ${p}`))
  }
  if (backup === null || typeof backup !== 'object' || typeof backup.mechanism !== 'string') {
    problems.push(
      'no backup fact to bind — the recovery-mechanism judgement (tools/check-backup-posture.mjs) must have found PITR or a completed daily backup before a restore point can exist',
    )
  } else if (backup.mechanism !== 'pitr' && backup.latestAt === null) {
    problems.push(
      `the backup mechanism is '${backup.mechanism}' with no completed-backup timestamp — a restore manifest bound to a backup that has never completed is a promise, not a record`,
    )
  }
  if (problems.length > 0) return { problems, record: null }
  return {
    problems: [],
    record: {
      // The common point in time RB-02 asks for: the deployment event, with the
      // backup fact that covers it.
      boundAt: manifest.deployedAt,
      data: { mechanism: backup.mechanism, latestBackupAt: backup.latestAt },
      applications: {
        commit: manifest.commit,
        packageVersion: manifest.packageVersion,
        functions: manifest.functions,
      },
      settings: { migrations: manifest.migrations, lockfileSha: manifest.lockfileSha },
      // VERIFIED EXCLUSIONS, restated where the restorer will read them: the
      // platform backup holds none of these, and discovering that DURING a
      // recovery is the failure this field exists to prevent.
      knownExclusions: [
        'Edge Function code (redeploy from the commit above)',
        'Auth settings, API keys and project settings (reconfigure; not in the database backup)',
        'Storage API objects (the database holds only their metadata)',
        'custom-role LOGIN passwords (stripped from backups)',
        'the Vault/pgsodium root key (ciphertext restores; the key must be carried separately or nothing decrypts)',
      ],
    },
  }
}
