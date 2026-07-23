// Can-fail proofs for the four custom ESLint rules (template/base/tools/eslint-rules/index.mjs),
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
}
