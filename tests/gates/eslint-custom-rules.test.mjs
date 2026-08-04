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
}
