// Unit tests for installer/lib/prompts.mjs — the answer-collection surface:
//   parseSets()     : --set VAR=value parsing, first-'=' split, unknown-key /
//                     missing-'=' rejection.
//   collectAnswers(): --set overrides, --yes default chaining, up-front
//                     validation of ALL placeholders (loud throw before any
//                     write), and the interactive re-prompt loop.
// Non-interactive branches run in-process (no readline is ever created when
// every placeholder is already answered). The interactive branches need a
// live readline over a stream, so they run in a child process with a
// prompt-DRIVEN feeder: the next reply is pushed only when readline writes its
// next prompt. That causality (prompt -> feed) is race-free and deterministic
// — bulk-piping the whole reply script up front does NOT work, because
// readline (flowing, non-TTY) drains every line at once and drops every reply
// after the first, then EOFs the interface. That is the flakiness this file
// deliberately designs around.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectAnswers, parseSets } from '../../installer/lib/prompts.mjs'

const MOD = fileURLToPath(new URL('../../installer/lib/prompts.mjs', import.meta.url))

// A minimal ctx: collectAnswers only reads ctx.dirName / ctx.gitOwner and sets
// ctx.answers itself.
/** @returns {{ dirName: string, gitOwner: string, answers?: any }} */
const ctx = (over = {}) => ({ dirName: 'demo-app', gitOwner: 'acme-co', ...over })

// ---------------------------------------------------------------------------
// Prompt-driven child-process driver (see file header for why).
// The driver injects a fake stdin/stdout, then feeds one reply per prompt.
// No backticks / ${} appear inside so it embeds cleanly as a template literal.
// ---------------------------------------------------------------------------
const DRIVER_SRC = `
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { PassThrough, Writable } from 'node:stream'
const [, , modPath, resultPath] = process.argv
const spec = JSON.parse(process.env.SPEC)
const lines = JSON.parse(process.env.LINES)
let i = 0
const input = new PassThrough()
input.isTTY = false
const prompts = []
const feed = () => {
  if (i < lines.length) input.write(lines[i++] + '\\n')
  else input.end()
}
const output = new Writable({
  write(chunk, enc, cb) {
    const s = String(chunk)
    prompts.push(s)
    // Every prompt ends with ': ' — only then is readline waiting for a reply.
    if (s.endsWith(': ')) process.nextTick(feed)
    cb()
  },
})
output.isTTY = false
Object.defineProperty(process, 'stdin', { value: input, configurable: true })
Object.defineProperty(process, 'stdout', { value: output, configurable: true })
const errors = []
console.error = (...args) => errors.push(args.map(String).join(' '))
const { collectAnswers } = await import(pathToFileURL(modPath).href)
try {
  const answers = await collectAnswers(spec)
  writeFileSync(resultPath, JSON.stringify({ ok: true, answers, errors, prompts }))
} catch (err) {
  writeFileSync(resultPath, JSON.stringify({ ok: false, error: err.message, errors, prompts }))
}
process.exit(0)
`

// Drive collectAnswers interactively: `lines` are the replies, one consumed per
// prompt (a re-prompt consumes an extra line). Returns the driver's captured
// result plus the raw child streams for diagnostics.
function drive({ spec, lines }) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-prompts-'))
  const driver = join(dir, 'driver.mjs')
  const resultPath = join(dir, 'result.json')
  writeFileSync(driver, DRIVER_SRC)
  const res = spawnSync('node', [driver, MOD, resultPath], {
    encoding: 'utf8',
    env: { ...process.env, SPEC: JSON.stringify(spec), LINES: JSON.stringify(lines) },
  })
  let result
  try {
    result = JSON.parse(readFileSync(resultPath, 'utf8'))
  } catch {
    assert.fail(`driver wrote no result — exit ${res.status}\nstdout:${res.stdout}\nstderr:${res.stderr}`)
  }
  return result
}

// The full set of default answers --yes derives from ctx(): identity chains from
// PROJECT_NAME -> PROJECT_SLUG -> {APP_IDENTIFIER, APP_SCHEME}, owner chains from
// gitOwner -> GITHUB_OWNER -> SECURITY_OWNERS; WEB_ORIGIN defaults to the Next dev
// port (apps/web is both the web client AND the API host); the project-ref and the
// EAS/store trio default to TBD (doctor warns while they remain).
// Key ORDER here mirrors the registry's declaration order, which IS the prompt
// order — the interactive reply scripts below are positional.
const DEFAULT_ANSWERS = {
  PROJECT_NAME: 'demo-app',
  PROJECT_SLUG: 'demo-app',
  APP_IDENTIFIER: 'com.example.demoapp',
  APP_SCHEME: 'demoapp',
  WEB_ORIGIN: 'http://127.0.0.1:3000',
  DESIGN_TOKENS: 'default',
  SUPABASE_PROJECT_REF: 'TBD',
  GITHUB_OWNER: 'acme-co',
  SECURITY_OWNERS: '@acme-co',
  DEFAULT_BRANCH: 'main',
  EAS_PROJECT_ID: 'TBD',
  ASC_APP_ID: 'TBD',
  APPLE_TEAM_ID: 'TBD',
}
const PLACEHOLDER_COUNT = Object.keys(DEFAULT_ANSWERS).length

// ---------------------------------------------------------------------------
// parseSets()
// ---------------------------------------------------------------------------

test('parseSets: nullish and empty input both yield an empty object', () => {
  assert.deepEqual(parseSets(undefined), {})
  assert.deepEqual(parseSets([]), {})
})

test('parseSets: parses VAR=value for known placeholders', () => {
  assert.deepEqual(
    parseSets(['PROJECT_NAME=Acme Portal', 'GITHUB_OWNER=acme-co']),
    { PROJECT_NAME: 'Acme Portal', GITHUB_OWNER: 'acme-co' },
  )
})

test('parseSets: only the FIRST "=" splits — values may contain "="', () => {
  assert.deepEqual(
    parseSets(['WEB_ORIGIN=http://h:1?a=b=c']),
    { WEB_ORIGIN: 'http://h:1?a=b=c' },
  )
})

test('parseSets: an empty value (VAR=) is preserved as an empty string', () => {
  assert.deepEqual(parseSets(['PROJECT_NAME=']), { PROJECT_NAME: '' })
})

test('parseSets: duplicate keys — last one wins', () => {
  assert.deepEqual(
    parseSets(['PROJECT_NAME=first', 'PROJECT_NAME=second']),
    { PROJECT_NAME: 'second' },
  )
})

test('parseSets: a token without "=" throws the VAR=value usage', () => {
  assert.throws(
    () => parseSets(['PROJECT_NAME']),
    (/** @type {Error} */ err) => {
      assert.match(err.message, /--set expects VAR=value/)
      assert.ok(err.message.includes('PROJECT_NAME'), err.message)
      return true
    },
  )
})

test('parseSets: an unknown key throws and lists the known placeholders', () => {
  assert.throws(
    () => parseSets(['TYPO_VAR=x']),
    (/** @type {Error} */ err) => {
      assert.match(err.message, /unknown placeholder/)
      assert.ok(err.message.includes('TYPO_VAR'), err.message)
      assert.ok(err.message.includes('PROJECT_NAME'), 'known list must be shown')
      return true
    },
  )
})

test('parseSets: a leading "=" (empty key) is rejected as an unknown placeholder', () => {
  assert.throws(() => parseSets(['=value']), /unknown placeholder/)
})

// ---------------------------------------------------------------------------
// collectAnswers() — non-interactive (--yes / fully --set): no readline
// ---------------------------------------------------------------------------

test('--yes fills every placeholder from defaults, chaining derived values', async () => {
  const c = ctx()
  const answers = await collectAnswers({ yes: true, sets: {}, ctx: c })
  assert.deepEqual(answers, DEFAULT_ANSWERS)
  // ctx.answers is the very object returned (defaults read through it).
  assert.equal(c.answers, answers)
})

test('--set overrides a default AND feeds downstream default derivation', async () => {
  const answers = await collectAnswers({
    yes: true,
    sets: { PROJECT_NAME: 'Acme Portal', WEB_ORIGIN: 'https://app.acme.example' },
    ctx: ctx({ dirName: 'ignored-dir' }),
  })
  assert.equal(answers.PROJECT_NAME, 'Acme Portal')
  assert.equal(answers.WEB_ORIGIN, 'https://app.acme.example')
  // PROJECT_SLUG / APP_SCHEME / APP_IDENTIFIER derive from the --set name, not ctx.dirName.
  assert.equal(answers.PROJECT_SLUG, 'acme-portal')
  assert.equal(answers.APP_SCHEME, 'acmeportal')
  assert.equal(answers.APP_IDENTIFIER, 'com.example.acmeportal')
})

test('fully --set answers resolve with NO readline even when yes is false', async () => {
  // Every placeholder present in `sets` means the prompt loop is skipped
  // entirely — this MUST NOT touch stdin, so it is safe to run in-process.
  const sets = {
    PROJECT_NAME: 'Full Set App',
    PROJECT_SLUG: 'full-set-app',
    APP_IDENTIFIER: 'com.acme.fullset',
    APP_SCHEME: 'fullsetapp',
    WEB_ORIGIN: 'http://127.0.0.1:3000',
    DESIGN_TOKENS: 'metal',
    SUPABASE_PROJECT_REF: 'TBD',
    GITHUB_OWNER: 'acme-co',
    SECURITY_OWNERS: '@acme-co',
    DEFAULT_BRANCH: 'main',
    EAS_PROJECT_ID: 'TBD',
    ASC_APP_ID: 'TBD',
    APPLE_TEAM_ID: 'TBD',
  }
  const answers = await collectAnswers({ yes: false, sets: { ...sets }, ctx: ctx() })
  assert.deepEqual(answers, sets)
})

test('an invalid --set value is rejected up front with name, reason, and the offending value', async () => {
  await assert.rejects(
    collectAnswers({
      yes: true,
      sets: { APP_IDENTIFIER: 'com.acme.bad-segment' },
      ctx: ctx(),
    }),
    (/** @type {Error} */ err) => {
      assert.match(err.message, /invalid placeholder value/)
      assert.ok(err.message.includes('APP_IDENTIFIER'), err.message)
      assert.ok(err.message.includes('Android forbids'), err.message)
      assert.ok(err.message.includes('got:'), 'must echo the offending value')
      return true
    },
  )
})

test('an empty --set value trips validation, echoing "" via JSON.stringify', async () => {
  await assert.rejects(
    collectAnswers({ yes: true, sets: { PROJECT_NAME: '' }, ctx: ctx() }),
    (/** @type {Error} */ err) => {
      assert.match(err.message, /invalid placeholder value/)
      assert.ok(err.message.includes('PROJECT_NAME must not be empty (got: "")'), err.message)
      return true
    },
  )
})

test('collectAnswers does NOT guard unknown --set keys — they pass through unvalidated', async () => {
  // parseSets is the unknown-key gate; collectAnswers copies sets verbatim and
  // only validates the registered placeholders. Pinning this division of labor.
  const answers = await collectAnswers({
    yes: true,
    sets: { PROJECT_NAME: 'X App', FUTURE_TOKEN: 'whatever' },
    ctx: ctx(),
  })
  assert.equal(answers.FUTURE_TOKEN, 'whatever')
  assert.equal(answers.PROJECT_NAME, 'X App')
})

// ---------------------------------------------------------------------------
// collectAnswers() — interactive (child process, prompt-driven feeder)
// ---------------------------------------------------------------------------

test('interactive: empty replies accept the default for every placeholder', () => {
  const r = drive({
    spec: { yes: false, sets: {}, ctx: ctx() },
    lines: Array(PLACEHOLDER_COUNT).fill(''),
  })
  assert.ok(r.ok, JSON.stringify(r))
  assert.deepEqual(r.answers, DEFAULT_ANSWERS)
  assert.equal(r.prompts.length, PLACEHOLDER_COUNT, 'exactly one prompt per placeholder')
})

test('interactive: typed replies are stored, trimmed of surrounding whitespace', () => {
  const r = drive({
    spec: { yes: false, sets: {}, ctx: ctx({ dirName: 'demo', gitOwner: 'x' }) },
    lines: [
      '  Padded Name  ', // PROJECT_NAME
      'padded-name', // PROJECT_SLUG
      'com.acme.padded', // APP_IDENTIFIER
      'paddedname', // APP_SCHEME
      'https://app.padded.example', // WEB_ORIGIN
      'metal', // DESIGN_TOKENS
      '', // SUPABASE_PROJECT_REF (default TBD)
      'acme-co', // GITHUB_OWNER
      '@acme-co @acme-co/security', // SECURITY_OWNERS
      '  develop  ', // DEFAULT_BRANCH
      '', // EAS_PROJECT_ID (default TBD)
      '', // ASC_APP_ID
      '', // APPLE_TEAM_ID
    ],
  })
  assert.ok(r.ok, JSON.stringify(r))
  assert.equal(r.answers.PROJECT_NAME, 'Padded Name', 'leading/trailing whitespace trimmed')
  assert.equal(r.answers.DEFAULT_BRANCH, 'develop')
  assert.equal(r.answers.WEB_ORIGIN, 'https://app.padded.example')
  assert.equal(r.answers.SUPABASE_PROJECT_REF, 'TBD')
  assert.equal(r.answers.SECURITY_OWNERS, '@acme-co @acme-co/security')
  assert.equal(r.answers.DESIGN_TOKENS, 'metal')
  assert.equal(r.answers.EAS_PROJECT_ID, 'TBD')
})

test('interactive: an invalid reply re-prompts, then accepts a valid one', () => {
  // PROJECT_SLUG gets an invalid reply first; the loop must re-ask (not bake the
  // bad value in) and accept the valid retry. The full script is queued up
  // front — the feeder releases each line only when a prompt is written.
  const r = drive({
    spec: { yes: false, sets: {}, ctx: ctx() },
    lines: [
      'My Portal', // PROJECT_NAME
      'Bad Slug!!', // PROJECT_SLUG — invalid
      'my-portal', // PROJECT_SLUG — valid retry
      'com.acme.portal', // APP_IDENTIFIER
      'myportal', // APP_SCHEME
      'https://app.acme.example', // WEB_ORIGIN
      '', // DESIGN_TOKENS (default)
      '', // SUPABASE_PROJECT_REF
      'acme-co', // GITHUB_OWNER
      '@acme-co', // SECURITY_OWNERS
      'develop', // DEFAULT_BRANCH
      '', // EAS_PROJECT_ID
      '', // ASC_APP_ID
      '', // APPLE_TEAM_ID
    ],
  })
  assert.ok(r.ok, JSON.stringify(r))
  assert.equal(r.answers.PROJECT_SLUG, 'my-portal', 'valid retry wins; invalid value never stored')
  // The rejection is reported and the same placeholder is prompted twice.
  assert.ok(
    r.errors.some((e) => e.includes('PROJECT_SLUG') && e.includes('kebab-case')),
    JSON.stringify(r.errors),
  )
  const slugPrompts = r.prompts.filter((p) => p.includes('Package/machine name'))
  assert.equal(slugPrompts.length, 2, 'PROJECT_SLUG must be re-prompted exactly once')
})

test('--set DESIGN_TOKENS=metal passes validation and lands in answers', async () => {
  const answers = await collectAnswers({
    yes: true,
    sets: { DESIGN_TOKENS: 'metal' },
    ctx: ctx(),
  })
  assert.equal(answers.DESIGN_TOKENS, 'metal')
})

test('an invalid DESIGN_TOKENS --set is rejected up front, naming both presets', async () => {
  await assert.rejects(
    collectAnswers({ yes: true, sets: { DESIGN_TOKENS: 'chrome' }, ctx: ctx() }),
    (/** @type {Error} */ err) => {
      assert.match(err.message, /invalid placeholder value/)
      assert.ok(err.message.includes('DESIGN_TOKENS'), err.message)
      assert.ok(err.message.includes('default, metal'), err.message)
      assert.ok(err.message.includes('got: "chrome"'), err.message)
      return true
    },
  )
})

test('interactive: an invalid DESIGN_TOKENS reply re-prompts, then accepts metal', () => {
  const r = drive({
    spec: { yes: false, sets: {}, ctx: ctx() },
    lines: [
      '', // PROJECT_NAME
      '', // PROJECT_SLUG
      '', // APP_IDENTIFIER
      '', // APP_SCHEME
      '', // WEB_ORIGIN
      'chrome', // DESIGN_TOKENS — invalid
      'metal', // DESIGN_TOKENS — valid retry
      '', // SUPABASE_PROJECT_REF
      '', // GITHUB_OWNER
      '', // SECURITY_OWNERS
      '', // DEFAULT_BRANCH
      '', // EAS_PROJECT_ID
      '', // ASC_APP_ID
      '', // APPLE_TEAM_ID
    ],
  })
  assert.ok(r.ok, JSON.stringify(r))
  assert.equal(r.answers.DESIGN_TOKENS, 'metal', 'valid retry wins; invalid value never stored')
  assert.ok(
    r.errors.some((e) => e.includes('DESIGN_TOKENS') && e.includes('default, metal')),
    JSON.stringify(r.errors),
  )
  const presetPrompts = r.prompts.filter((p) => p.includes('Design-token preset'))
  assert.equal(presetPrompts.length, 2, 'DESIGN_TOKENS must be re-prompted exactly once')
})

test('interactive: already-answered (--set) placeholders are NOT prompted', () => {
  // Mix of --set and interactive: only the unset placeholders are asked, and the
  // set value seeds downstream defaults.
  const r = drive({
    spec: { yes: false, sets: { PROJECT_NAME: 'Preset Name' }, ctx: ctx() },
    lines: Array(PLACEHOLDER_COUNT - 1).fill(''),
  })
  assert.ok(r.ok, JSON.stringify(r))
  assert.equal(r.answers.PROJECT_NAME, 'Preset Name')
  assert.equal(r.answers.PROJECT_SLUG, 'preset-name', 'downstream default derives from the --set value')
  assert.equal(r.prompts.length, PLACEHOLDER_COUNT - 1, 'the --set placeholder must not be prompted')
  assert.ok(
    !r.prompts.some((p) => p.includes('Human-readable project name')),
    'PROJECT_NAME prompt must be skipped',
  )
})
