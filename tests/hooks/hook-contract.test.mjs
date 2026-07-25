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
// server-import ban, the expo-secure-store host seam, DAL withUserContext,
// append-only migrations) have no flat rule id and stay as direct tests.

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
  mkdirSync(join(proj, 'packages/schema/drizzle'), { recursive: true })
  writeFileSync(join(proj, 'packages/schema/drizzle/0000_init.sql'), '-- existing migration\n')
})

function runHook(name, input, { env = {}, cwd = proj } = {}) {
  const res = spawnSync('node', [join(proj, '.claude/hooks', name)], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, ...env },
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
      env: { ...process.env, CLAUDE_PROJECT_DIR: broken },
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
    // Patch application reconstructs arbitrary bytes at a protected path with no
    // redirect operator to match on.
    bashDeny('git apply /tmp/weaken-gate.patch tools/check-expo-policy.mjs'),
    bashDeny('echo "-- tweak" >> packages/schema/drizzle/0000_init.sql'),
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
  'drizzle-kit-push': [bashDeny('pnpm exec drizzle-kit push')],
  'drizzle-kit-drop': [bashDeny('pnpm exec drizzle-kit drop')],
  'knip-fix': [bashDeny('pnpm exec knip --fix')],
  'dependency-update': [bashDeny('pnpm update'), bashDeny('pnpm update --latest')],
  'migrator-dsn': [
    bashDeny('psql "$MIGRATOR_DATABASE_URL" -c "select 1"'),
    // Sanctioned contexts pass (the rule's allowWhen predicate).
    bashAllow('MIGRATOR_DATABASE_URL=$X pnpm --filter @app/schema exec drizzle-kit migrate'),
    bashAllow('MIGRATOR_DATABASE_URL=$X node tests/rls/run-rls.mjs'),
  ],
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
    pathDeny('tools/gen-theme.mjs'),
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
  'dto-bounds-allow': [pathDeny('tools/dto-bounds-allow.json')],
  'duplication-allow': [pathDeny('tools/duplication-allow.json')],
  'i18n-allow': [pathDeny('tools/i18n-allow.json')],
  'test-quality-allow': [pathDeny('tools/test-quality-allow.json')],
  'rls-runner': [pathDeny('tests/rls/run-rls.mjs')],
  'migration-apply-runner': [pathDeny('tests/migrations/migration-apply.mjs')],
  lefthook: [pathDeny('lefthook.yml')],
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
      'apps/server/src/dal/tests/helper.ts',
      "await sql`select set_config('app.user_id', ${id}, false)`\n",
    ),
  ],
  'set-session-app-guc': [
    contentDeny('apps/server/src/db/context.ts', 'await sql`SET SESSION app.user_id = ${id}`\n'),
    contentDeny('apps/server/src/db/context.ts', 'await sql`SET app.user_id = ${id}`\n'),
  ],
  'vitest-workspace-file': [
    contentDeny('vitest.workspace.mts', "import { defineWorkspace } from 'vitest/config'\n"),
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
  const { BASH_RULES, WRITE_PROTECTED, WRITE_GLOBAL_CHECKS } = await import(GUARD_RULES.href)
  const ids = [...BASH_RULES, ...WRITE_PROTECTED, ...WRITE_GLOBAL_CHECKS].map((r) => r.id)
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
  'MIGRATOR_DATABASE_URL=$X pnpm --filter @app/schema exec drizzle-kit migrate',
  'node tests/migrations/migration-apply.mjs # uses MIGRATOR_DATABASE_URL',
  // The RLS runner's own fail-closed hint tells the agent to do exactly this:
  'MIGRATOR_DATABASE_URL=$X node tests/rls/run-rls.mjs',
  'DATABASE_URL=$A MIGRATOR_DATABASE_URL=$B pnpm test:rls',
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
      file_path: 'packages/schema/drizzle/0000_init.sql',
      content: 'ALTER TABLE notes ...\n',
    },
  })
  assert.ok(denied(existing), 'existing migration must be append-only')
  const fresh = runHook('pretool-write-guard.mjs', {
    tool_input: {
      file_path: 'packages/schema/drizzle/0001_add_column.sql',
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
    'mobile importing drizzle',
    'apps/mobile/src/features/notes.ts',
    "import { eq } from 'drizzle-orm'\n",
  ],
  ['mobile importing postgres', 'apps/mobile/src/data/db.ts', "import postgres from 'postgres'\n"],
  [
    'mobile importing @hono/*',
    'apps/mobile/src/api/client.ts',
    "import { hc } from '@hono/zod-validator'\n",
  ],
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
    'server importing drizzle (the ban is mobile-only)',
    'apps/server/src/db/schema-glue.ts',
    "import { eq } from 'drizzle-orm'\n",
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

test('write-guard requires withUserContext in whole-file DAL writes', () => {
  const bare = runHook('pretool-write-guard.mjs', {
    tool_input: {
      file_path: 'apps/server/src/dal/notes.ts',
      content: 'export const list = () => db.select()\n',
    },
  })
  assert.ok(denied(bare), 'DAL without withUserContext must be denied')
  const wrapped = runHook('pretool-write-guard.mjs', {
    tool_input: {
      file_path: 'apps/server/src/dal/notes.ts',
      content:
        "import { withUserContext } from '../db/context'\nexport const list = (u: string) => withUserContext(u, (tx) => tx.select())\n",
    },
  })
  assert.ok(!denied(wrapped), wrapped.stdout)
  const fragment = runHook('pretool-write-guard.mjs', {
    tool_input: { file_path: 'apps/server/src/dal/notes.ts', new_string: 'const limit = 50\n' },
  })
  assert.ok(!denied(fragment), 'Edit fragments must not false-deny the DAL positive check')
})

test('write-guard exempts test bodies from content checks', () => {
  // Root test trees, the mobile __tests__ tree, and colocated *.test.* files
  // legitimately reference banned patterns (the RLS suite asserts on
  // set_config false behavior). A nested product dir named "tests" stays
  // checked — covered by the set-config-session-wide canary above.
  for (const f of [
    'tests/rls/probe.test.ts',
    'test/unit/context.ts',
    'e2e/a11y.spec.ts',
    'apps/server/src/dal/notes.test.ts',
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

  const uncitedSql = join(proj, 'packages/schema/drizzle/9999_x.sql')
  writeFileSync(uncitedSql, 'ALTER TABLE notes FORCE ROW LEVEL SECURITY;\n')
  assert.equal(
    runHook('posttool-source-check.mjs', { tool_input: { file_path: uncitedSql } }).code,
    2,
  )

  const citedSql = join(proj, 'packages/schema/drizzle/9998_y.sql')
  writeFileSync(
    citedSql,
    '-- SOURCE: postgres docs [corpus: postgres/rls-force]\nALTER TABLE notes FORCE ROW LEVEL SECURITY;\n',
  )
  assert.equal(
    runHook('posttool-source-check.mjs', { tool_input: { file_path: citedSql } }).code,
    0,
  )
})

test('source-check skips json, tests, and generated theme tokens', () => {
  // tokens.gen.ts is the generated-module skip for THIS stack (the token emitter's
  // output — the analogue of the old IPC bindings skip); drizzle/meta is drizzle's
  // own metadata tree.
  for (const f of [
    'x.config.json',
    'apps/server/src/auth.test.ts',
    'apps/mobile/src/theme/tokens.gen.ts',
    'packages/schema/drizzle/meta/snapshot.ts',
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
  mkdirSync(join(proj, 'apps/server/src/dal'), { recursive: true })
  writeFileSync(join(proj, 'apps/server/src/dal/notes.ts'), 'export const q = 1\n')
  // *.test.ts is content-check-exempt (test bodies legitimately reference banned
  // patterns) — but the bytes here land in a DAL module, which must carry withUserContext.
  if (!trySymlink('apps/server/src/dal/notes.ts', join(proj, 'sneaky.test.ts'))) {
    t.skip('symlinkSync needs privileges on this Windows runner')
    return
  }
  const r = runHook('pretool-write-guard.mjs', {
    tool_name: 'Write',
    tool_input: { file_path: 'sneaky.test.ts', content: 'export const all = () => db.select()\n' },
  })
  assert.ok(denied(r), 'an exempt name must not buy an exemption for bytes landing in the DAL')
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
