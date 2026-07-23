// The harness's four custom ESLint rules — plain ESLint rules (no @typescript-eslint/utils
// RuleCreator), keyed on syntax nodes that exist identically in JS and TS (ThrowStatement,
// CallExpression, Literal), so they lint the TS surface AND are testable with a bare
// `eslint` RuleTester on plain-JS cases. Wired, and SCOPED to their file globs, in
// eslint.config.mjs; the config text is hash-pinned by scripts/check-rule-integrity.mjs.
//
// Each rule is deliberately small: the file GLOB decides WHERE it fires (the enveloped
// surfaces, the supabase consumers, the i18n catalog, the schema modules), the rule decides
// WHAT. Widening a glob is a reviewed eslint.config.mjs edit (which reds rule-integrity);
// narrowing a rule body reds its RuleTester fixture.
// SOURCE: docs/harness/README.md (the four custom lint rules) [corpus: harness/doctrine]

/** True when `node` sits inside any function body (i.e. NOT at module scope). */
function insideFunction(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (/Function(Declaration|Expression)$|ArrowFunctionExpression/.test(p.type)) return true
  }
  return false
}

// A supabase client factory: the raw `createClient` from @supabase/supabase-js, or one of the
// stack's named factories (createBrowserSupabaseClient, createServiceRoleClient_BYPASSES_RLS, …).
const SUPABASE_FACTORY = /^create(Client$|[A-Za-z]*(Supabase|ServiceRole)[A-Za-z]*Client)/

/** A `z.<builder>(...)` call — a zod schema constructor (z.object, z.array, z.string, …). */
function isZodBuilder(node) {
  const c = node.callee
  return (
    c.type === 'MemberExpression' &&
    c.object.type === 'Identifier' &&
    c.object.name === 'z' &&
    c.property.type === 'Identifier'
  )
}

/** True when the nearest enclosing CallExpression (before any function boundary) is itself a
 * zod builder — i.e. this z.<builder> is nested inside another schema, so the OUTER one is the
 * one to report. */
function nestedInZodBuilder(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (/Function(Declaration|Expression)$|ArrowFunctionExpression/.test(p.type)) return false
    if (p.type === 'CallExpression' && isZodBuilder(p)) return true
  }
  return false
}

/** @type {Record<string, import('eslint').Rule.RuleModule>} */
const rules = {
  // The lint half of the single-error-channel doctrine. In enveloped code (vertical data +
  // action layers, tRPC procedures, web Server Actions) a domain failure is a RETURNED
  // outcomeErr(appError.X()), never a thrown error — throwing flattens the discriminated
  // AppError a screen switches on into an HTTP status. The two sanctioned transport throws
  // (UNAUTHORIZED, version-skew CONFLICT) live in packages/api/src/trpc.ts, which the glob
  // excludes; this rule bans the rest.
  'app-error-only': {
    meta: {
      type: 'problem',
      docs: { description: 'Return the ActionOutcome envelope; never throw for a domain failure.' },
      schema: [],
      messages: {
        noThrow:
          'Return outcomeErr(appError.X()) from @app/errors — never throw for a domain failure. Throwing flattens the discriminated AppError a screen switches on into an HTTP status. (The two sanctioned transport throws live in packages/api/src/trpc.ts.)',
      },
    },
    create(context) {
      return {
        ThrowStatement(node) {
          context.report({ node, messageId: 'noThrow' })
        },
      }
    },
  },

  // No supabase client instantiated at MODULE LOAD. A module-scope client binds one identity
  // (or the service role) for the process lifetime; the cookie/bearer identity a request
  // carries has to be resolved per request, so the factory is called inside the handler, never
  // at the top of the file.
  'no-module-scope-supabase': {
    meta: {
      type: 'problem',
      docs: { description: 'Create the Supabase client per request, not at module scope.' },
      schema: [],
      messages: {
        moduleScope:
          'Call the Supabase client factory inside the request handler, not at module scope. A module-scope client binds one identity for the process lifetime; per-request cookie/bearer identity cannot be resolved from a client built at import.',
      },
    },
    create(context) {
      return {
        CallExpression(node) {
          const callee = node.callee
          if (
            callee.type === 'Identifier' &&
            SUPABASE_FACTORY.test(callee.name) &&
            !insideFunction(node)
          ) {
            context.report({ node, messageId: 'moduleScope' })
          }
        },
      }
    },
  },

  // User-facing copy hygiene over the i18n catalog. Minimal + extensible: the string VALUE of a
  // message (a Property's value) must not be empty, must not carry leading/trailing whitespace,
  // and must not contain a double space. Add voice/tone checks here as the voice guide lands.
  'ui-copy-voice': {
    meta: {
      type: 'suggestion',
      docs: { description: 'User-facing copy is trimmed, single-spaced, and non-empty.' },
      schema: [],
      messages: {
        empty: 'User-facing copy must not be an empty string.',
        whitespace: 'User-facing copy must not have leading or trailing whitespace.',
        doubleSpace: 'User-facing copy must not contain a double space.',
      },
    },
    create(context) {
      return {
        'Property > Literal.value'(node) {
          if (typeof node.value !== 'string') return
          const v = node.value
          if (v.length === 0) context.report({ node, messageId: 'empty' })
          else if (v !== v.trim()) context.report({ node, messageId: 'whitespace' })
          else if (v.includes('  ')) context.report({ node, messageId: 'doubleSpace' })
        },
      }
    },
  },

  // A zod schema is built ONCE, at module scope — never rebuilt per call. `z.object({...})`
  // (or any z.<builder>) inside a function body recompiles the schema on every invocation, a
  // silent hot-path cost. Using a module-scope schema (schema.parse(x)) is fine — the object of
  // that call is the schema, not `z`.
  'zod-schema-module-scope': {
    meta: {
      type: 'problem',
      docs: { description: 'Hoist zod schemas to module scope; do not rebuild them per call.' },
      schema: [],
      messages: {
        perCall:
          'Hoist this zod schema to module scope. A z.<builder>() inside a function recompiles the schema on every call; define it once at the top of the module and reference it.',
      },
    },
    create(context) {
      return {
        CallExpression(node) {
          if (isZodBuilder(node) && insideFunction(node) && !nestedInZodBuilder(node)) {
            context.report({ node, messageId: 'perCall' })
          }
        },
      }
    },
  },
}

export default { rules }
