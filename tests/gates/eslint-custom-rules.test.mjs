// Can-fail proofs for the custom ESLint rules (template/base/tools/eslint-rules/index.mjs),
// exercised through ESLint's own RuleTester. The harness repo has no node_modules, so this
// self-skips when `eslint` cannot be imported — it runs wherever ESLint is installed (a rendered
// scaffold, CI) and stays green under a bare `node --test`. Each rule's INVALID case is the W4
// verify-bar fixture: a narrowed rule body stops firing and reds here.
import { test } from 'node:test'

let RuleTester
try {
  ;({ RuleTester } = await import('eslint'))
} catch {
  RuleTester = null
}

const plugin = (await import('../../template/base/tools/eslint-rules/index.mjs')).default
const { rules } = plugin

if (RuleTester === null) {
  test('SKIP: eslint not installed (runs in a rendered scaffold / CI)', () => {})
} else {
  const rt = new RuleTester({ languageOptions: { ecmaVersion: 'latest', sourceType: 'module' } })

  test('app-error-only: a throw reds; an outcome return is clean', () => {
    rt.run('app-error-only', rules['app-error-only'], {
      valid: ['const e = outcomeErr(appError.conflict({ code: "x" }))', 'const x = 1'],
      invalid: [
        { code: 'throw new Error("boom")', errors: [{ messageId: 'noThrow' }] },
        { code: 'function f() { throw new TypeError("x") }', errors: [{ messageId: 'noThrow' }] },
      ],
    })
  })

  test('no-module-scope-supabase: a module-scope factory call reds; inside a function is clean', () => {
    rt.run('no-module-scope-supabase', rules['no-module-scope-supabase'], {
      valid: [
        'function handler() { const c = createClient(url, key); return c }',
        'const notAClient = createWidget()',
        'export function make() { return createBrowserSupabaseClient() }',
      ],
      invalid: [
        { code: 'const c = createClient(url, key)', errors: [{ messageId: 'moduleScope' }] },
        {
          code: 'const svc = createServiceRoleClient_BYPASSES_RLS(url, key)',
          errors: [{ messageId: 'moduleScope' }],
        },
      ],
    })
  })

  test('ui-copy-voice: empty / padded / double-spaced copy reds; clean copy passes', () => {
    rt.run('ui-copy-voice', rules['ui-copy-voice'], {
      valid: ['const m = { greeting: "Welcome back" }', 'const m = { count: 3 }'],
      invalid: [
        { code: 'const m = { a: "" }', errors: [{ messageId: 'empty' }] },
        { code: 'const m = { a: " hi " }', errors: [{ messageId: 'whitespace' }] },
        { code: 'const m = { a: "too  wide" }', errors: [{ messageId: 'doubleSpace' }] },
      ],
    })
  })

  test('org-id-from-session-only: a contract orgId field reds; the selector shapes are clean', () => {
    rt.run('org-id-from-session-only', rules['org-id-from-session-only'], {
      valid: [
        // The contract carries the NOTE's fields and nothing about tenancy.
        'export const CreateNote = z.object({ title: z.string(), body: z.string() })',
        // A slug/role field is not a tenant key the caller can assert into a query.
        'export const OrgSummary = z.object({ id: z.uuid(), slug: z.string(), role: OrgRole })',
        // The row's org comes from the RESOLVED context, which is the whole point.
        'const row = { org_id: context.orgId, title: input.title }',
        'const row = { org_id: gate.data.org.id, owner_id: ctx.actor.userId }',
        'const row = { org_id: scope.orgId }',
        // A plain object with an orgId key that is NOT a zod schema is untouched — this rule
        // is about contracts and rows, not about every variable in the codebase.
        'const view = { orgId: activeOrg.id }',
      ],
      invalid: [
        {
          code: 'export const CreateNote = z.object({ orgId: z.uuid(), title: z.string() })',
          errors: [{ messageId: 'contractField' }],
        },
        {
          code: 'const Q = z.object({ filter: z.object({ orgId: z.string() }) })',
          errors: [{ messageId: 'contractField' }],
        },
        {
          code: 'const row = { org_id: input.orgId, title: input.title }',
          errors: [{ messageId: 'fromInput' }],
        },
        {
          code: 'const row = { org_id: parsedInput.org_id }',
          errors: [{ messageId: 'fromInput' }],
        },
        {
          code: 'const row = { org_id: searchParams.org }',
          errors: [{ messageId: 'fromInput' }],
        },
        {
          code: 'const row = { org_id: body }',
          errors: [{ messageId: 'fromInput' }],
        },
      ],
    })
  })

  test('zod-schema-module-scope: building a schema inside a function reds; module scope is clean', () => {
    rt.run('zod-schema-module-scope', rules['zod-schema-module-scope'], {
      valid: [
        'const S = z.object({ a: z.string() })',
        'const S = z.object({}); function f(x) { return S.parse(x) }',
        'function f(x) { return existing.parse(x) }',
      ],
      invalid: [
        {
          code: 'function f() { return z.object({ a: z.string() }) }',
          errors: [{ messageId: 'perCall' }],
        },
        { code: 'const build = () => z.array(z.number())', errors: [{ messageId: 'perCall' }] },
      ],
    })
  })

  test('no-unsorted-readdir: an unsorted listing reds; a sorted chain is clean', () => {
    rt.run('no-unsorted-readdir', rules['no-unsorted-readdir'], {
      valid: [
        // The sort is in the same expression — with or without intermediate steps.
        'const files = readdirSync(dir).sort()',
        'const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()',
        'const files = readdirSync(dir, { withFileTypes: true }).map((d) => d.name).sort(byName)',
        'const files = fs.readdirSync(dir).sort()',
        'const files = (await readdir(dir)).sort()',
        'for (const f of readdirSync(dir).sort()) { use(f) }',
        // A different `readdir`-shaped name is not this rule's business.
        'const x = readdirSorted(dir)',
        // The shared walker already sorts; the rule keys on the reader, not the caller.
        'const files = walkFiles(root)',
      ],
      invalid: [
        // The exact shape that shipped in six harness gate scripts.
        { code: 'for (const d of readdirSync(scope)) { use(d) }', errors: [{ messageId: 'unsorted' }] },
        { code: 'const files = readdirSync(dir)', errors: [{ messageId: 'unsorted' }] },
        // A filter with no sort is the seductive one: it LOOKS processed.
        {
          code: 'const files = readdirSync(dir).filter((f) => f.endsWith(".md"))',
          errors: [{ messageId: 'unsorted' }],
        },
        { code: 'const files = fs.readdirSync(dir)', errors: [{ messageId: 'unsorted' }] },
        { code: 'const files = await readdir(dir)', errors: [{ messageId: 'unsorted' }] },
        // Sorting AFTER the value escapes the expression is not seen, and is not enough:
        // the rule is syntactic on purpose, and the intermediate binding is exactly where
        // a second consumer picks the value up unsorted.
        { code: 'const files = readdirSync(dir); files.sort()', errors: [{ messageId: 'unsorted' }] },
        // Passing the listing straight into a call — the sort never happens at all.
        { code: 'hash(readdirSync(dir))', errors: [{ messageId: 'unsorted' }] },
      ],
    })
  })

  // ── the two 0.3.0 security rules ──────────────────────────────────────────
  // Both properties existed only as write-guard regexes scoped to `^apps/web/`, and the
  // getSession one fired only on WHOLE-FILE writes — so an Edit into packages/api, a
  // vertical's server barrel or an Edge Function passed every layer. A rule on a member
  // call cannot be fooled by an Edit fragment, which is why the property moved here.

  test('no-unverified-session: a server-side getSession reds; use client and non-auth members are clean', () => {
    rt.run('no-unverified-session', rules['no-unverified-session'], {
      valid: [
        // The two verifications.
        'const { data } = await supabase.auth.getUser()',
        'const claims = await supabase.auth.getClaims()',
        // A browser component reading its OWN session is a different act entirely — and
        // the directive is judged AS a directive, so this is the only spelling that exempts.
        "'use client'\nconst { data } = await supabase.auth.getSession()",
        // A `getSession` that is not on `.auth` is not this rule's business; a rule that
        // flagged every identifier of that name would be turned off.
        'const s = sessionStore.getSession()',
        'const s = myThing.session.getSession()',
      ],
      invalid: [
        { code: 'const { data } = await supabase.auth.getSession()', errors: [{ messageId: 'unverified' }] },
        // The Edit-fragment shape: no imports, no directive, just the call. The old
        // whole-file-gated regex could not see this at all.
        { code: 'await client.auth.getSession()', errors: [{ messageId: 'unverified' }] },
        // A 'use client' that is NOT a directive (a comment, a string mid-file) must not
        // exempt anything — that would be the cheapest bypass in the release.
        {
          code: "// 'use client'\nconst x = 1\nawait supabase.auth.getSession()",
          errors: [{ messageId: 'unverified' }],
        },
        {
          code: "const label = 'use client'\nawait supabase.auth.getSession()",
          errors: [{ messageId: 'unverified' }],
        },
      ],
    })
  })

  test('service-role-edge-functions-only: every spelling of the credential reds outside its home', () => {
    rt.run('service-role-edge-functions-only', rules['service-role-edge-functions-only'], {
      valid: [
        'const c = createRequestScopedClient()',
        'const k = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE',
        // A different service role concept entirely — the rule names three exact symbols.
        'const role = user.serviceRole',
      ],
      invalid: [
        {
          code: 'const c = createServiceRoleClient_BYPASSES_RLS(warrant)',
          errors: [{ messageId: 'misplaced' }],
        },
        {
          code: 'const k = process.env.SUPABASE_SERVICE_ROLE_KEY',
          errors: [{ messageId: 'misplaced' }],
        },
        // Reached by STRING, which an identifier-only rule would miss.
        {
          code: "const k = process.env['SUPABASE_SERVICE_ROLE_KEY']",
          errors: [{ messageId: 'misplaced' }],
        },
        { code: 'const { url, key } = serviceRoleCredentials()', errors: [{ messageId: 'misplaced' }] },
      ],
    })
  })

  test('crypto-primitives-one-door: reaching a primitive engine outside the sanctioned homes reds', () => {
    rt.run('crypto-primitives-one-door', rules['crypto-primitives-one-door'], {
      valid: [
        // The sanctioned shape: primitives arrive through the injected port.
        'export async function seal(provider, k) { return provider.aeadSeal({ key: k }) }',
        // A CSPRNG for a NONCE-shaped non-secret (a CSP nonce, a request id) is not
        // a primitive engine reach — this rule is about cipher/KDF surfaces.
        'const id = crypto.randomUUID()',
        'const n = crypto.getRandomValues(new Uint8Array(16))',
        // An unrelated `subtle` member on some other object.
        'const s = theme.subtle',
        "import { createHash } from 'node:crypto'",
      ],
      invalid: [
        { code: 'const k = await crypto.subtle.importKey("raw", b, a, false, [])', errors: [{ messageId: 'subtleReach' }] },
        { code: 'const k = await globalThis.crypto.subtle.encrypt(a, k2, d)', errors: [{ messageId: 'subtleReach' }] },
        { code: 'const k = window.crypto.subtle', errors: [{ messageId: 'subtleReach' }] },
        {
          code: "import { createCipheriv } from 'node:crypto'",
          errors: [{ messageId: 'cipherImport' }],
        },
        {
          code: "const { createDecipheriv } = require('crypto')",
          errors: [{ messageId: 'cipherImport' }],
        },
      ],
    })
  })

  test('no-insecure-random-in-crypto-scope: Math.random near key material reds', () => {
    rt.run('no-insecure-random-in-crypto-scope', rules['no-insecure-random-in-crypto-scope'], {
      valid: [
        'const k = provider.randomBytes(32)',
        'const jitter = backoffJitter()',
        // A different random entirely.
        'const r = rng.random()',
      ],
      invalid: [
        { code: 'const k = Math.random()', errors: [{ messageId: 'insecureRandom' }] },
        {
          code: 'function makeIv() { return Math.random().toString(36) }',
          errors: [{ messageId: 'insecureRandom' }],
        },
      ],
    })
  })

  test('no-suppressed-complexity: disabling the complexity ceiling is itself a lint error', () => {
    rt.run('no-suppressed-complexity', rules['no-suppressed-complexity'], {
      valid: [
        // Ordinary code and ordinary comments are untouched.
        'function f() { return 1 }',
        '// the cognitive-complexity ceiling is 15',
        // Disabling an UNRELATED rule is not this rule’s business.
        '// eslint-disable-next-line no-console\nconsole.log(1)',
      ],
      invalid: [
        // RuleTester runs with only the rule under test registered, so ESLint itself
        // also reports the directive's target as an unknown rule — two errors per case,
        // and OURS is the one with the messageId.
        {
          code: '// eslint-disable-next-line sonarjs/cognitive-complexity\nfunction f() { return 1 }',
          errors: [
            { message: "Definition for rule 'sonarjs/cognitive-complexity' was not found." },
            { messageId: 'suppressed' },
          ],
        },
        {
          code: '/* eslint-disable sonarjs/cognitive-complexity */\nfunction f() { return 1 }',
          errors: [
            { message: "Definition for rule 'sonarjs/cognitive-complexity' was not found." },
            { messageId: 'suppressed' },
          ],
        },
        // Naming THIS rule in a directive is the stacking evasion — reported too.
        {
          code: '// eslint-disable-next-line local/no-suppressed-complexity\nconst x = 1',
          errors: [
            { message: "Definition for rule 'local/no-suppressed-complexity' was not found." },
            { messageId: 'stacked' },
          ],
        },
        // NOTE: a rule-LESS `/* eslint-disable */` is deliberately absent from
        // this list. ESLint applies it to every rule id including this one, so
        // the report never surfaces — verified against the real Linter. The rule
        // header says so, and the backstop is the 0.10.0 suppressions census.
      ],
    })
  })

  test('env-through-register: a raw server env read reds; public inlined reads stay literal', () => {
    rt.run('env-through-register', rules['env-through-register'], {
      valid: [
        // The two public channels are inlined at BUILD time — the literal member text IS the
        // mechanism, so routing them through a register would break the inlining they exist for.
        'const url = process.env.NEXT_PUBLIC_SUPABASE_URL',
        'const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE ?? ""',
        'if (process.env.NODE_ENV === "test") setup()',
        // Reads through the register are the sanctioned shape.
        'const t = optionalServerEnv.UPSTASH_REDIS_REST_TOKEN',
        // Another object's env property is not the process environment.
        'const e = config.env.MODE',
        'const url = globalThis.process.env.NEXT_PUBLIC_SUPABASE_URL',
      ],
      invalid: [
        // The exact defect the obligations row recorded: a server secret read off
        // process.env, invisible to the one seam whose job is to see it.
        {
          code: 'const t = process.env["UPSTASH_REDIS_REST_TOKEN"]',
          errors: [{ messageId: 'rawRead' }],
        },
        { code: 'const v = process.env.APP_VERSION ?? pkg.version', errors: [{ messageId: 'rawRead' }] },
        // A computed read cannot be reviewed — the name is chosen at runtime.
        { code: 'const n = process.env[name]', errors: [{ messageId: 'dynamicRead' }] },
        // Bare process.env smuggles every unnamed variable at once.
        { code: 'const all = { ...process.env }', errors: [{ messageId: 'bareEnv' }] },
        { code: 'const keys = Object.keys(process.env)', errors: [{ messageId: 'bareEnv' }] },
        // The bracket spelling of `env` itself is the same read, not an escape.
        { code: 'const t = process["env"].APP_VERSION', errors: [{ messageId: 'rawRead' }] },
        // …and neither is reaching it through globalThis.
        { code: 'const t = globalThis.process.env.APP_VERSION', errors: [{ messageId: 'rawRead' }] },
        { code: 'const all = { ...globalThis.process.env }', errors: [{ messageId: 'bareEnv' }] },
      ],
    })
  })
}
