// The harness's six custom ESLint rules — plain ESLint rules (no @typescript-eslint/utils
// RuleCreator), keyed on syntax nodes that exist identically in JS and TS (ThrowStatement,
// CallExpression, Literal), so they lint the TS surface AND are testable with a bare
// `eslint` RuleTester on plain-JS cases. Wired, and SCOPED to their file globs, in
// eslint.config.mjs; the config text is hash-pinned by scripts/check-rule-integrity.mjs.
//
// Each rule is deliberately small: the file GLOB decides WHERE it fires (the enveloped
// surfaces, the supabase consumers, the i18n catalog, the schema modules), the rule decides
// WHAT. Widening a glob is a reviewed eslint.config.mjs edit (which reds rule-integrity);
// narrowing a rule body reds its RuleTester fixture.
// SOURCE: docs/harness/README.md (the custom lint rules) [corpus: harness/doctrine]

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

/** `readdir(…)` / `readdirSync(…)`, bare or as `fs.readdirSync(…)`. */
function isReaddirCall(node) {
  const c = node.callee
  const name =
    c.type === 'Identifier'
      ? c.name
      : c.type === 'MemberExpression' && c.property.type === 'Identifier'
        ? c.property.name
        : null
  return name === 'readdirSync' || name === 'readdir'
}

/**
 * True when a `.sort` rides the fluent chain this call starts. Anything that is not a
 * member access or a call on the value being carried ends the chain — a for-of head, an
 * assignment, an argument position — and the listing escapes unsorted.
 */
function chainSorts(node) {
  let cur = node
  for (let p = cur.parent; p; cur = p, p = p.parent) {
    if (p.type === 'AwaitExpression') continue
    if (p.type === 'MemberExpression' && p.object === cur) {
      if (p.property.type === 'Identifier' && p.property.name === 'sort') return true
      continue
    }
    if (p.type === 'CallExpression' && p.callee === cur) continue
    return false
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

  // THE ACTING ORG IS A TRANSPORT SELECTOR, NEVER A PAYLOAD FIELD.
  //
  // The rule has exactly two arms, and both were chosen because they are DECIDABLE from the
  // syntax tree. A third arm was designed and dropped: "no `.in('org_id', <derived>)`" needs
  // dataflow analysis ESLint cannot do, and a rule that fires on half its cases teaches
  // people to disable it. That gap is covered instead by the X-Org-Id ∅ assertion in
  // tests/rls/cross-tenant-isolation.test.ts, which an application-side filter provably
  // cannot fake — the database is indifferent to the header either way.
  //
  //   ARM 1 (schema glob): no `orgId` key inside a zod object. A tenant a request can NAME in
  //   its body is a tenant the first careless handler will TRUST. The header/route selector is
  //   resolved server-side against real memberships and can only narrow; a body field is
  //   parsed data that flows into handlers.
  //
  //   ARM 2 (data + action globs): no `org_id:` property whose value is an identifier that
  //   came from the request — a parameter or destructured binding named input, parsedInput,
  //   body, searchParams, params, formData, or a member read off one of those. That is the
  //   literal shape of "the caller told us which tenant to write into". Assigning from a
  //   resolved context (`context.orgId`, `gate.data.org.id`) is untouched, because those names
  //   are not in the request set.
  //
  // WHAT IT IS NOT. It is not the isolation boundary. RLS is, and it holds when this rule is
  // disabled, deleted, or never written. This rule keeps the MISTAKE VISIBLE in review.
  'org-id-from-session-only': {
    meta: {
      type: 'problem',
      docs: {
        description:
          'The acting org is a transport selector resolved server-side; never a payload field or a value read from request input.',
      },
      schema: [],
      messages: {
        contractField:
          "Remove `orgId` from this contract. The acting org is a TRANSPORT selector — the x-org-id header, or the /o/[orgSlug] route segment — resolved server-side against the caller's real memberships, so it can only ever narrow what they already reach. A payload field is parsed data flowing into handlers: the first one that passes it to a query has made the client the author of its own tenant boundary.",
        fromInput:
          "`org_id` here is assigned from request input (`{{source}}`). The tenant key must come from the RESOLVED acting org — the value orgProcedure or requireOrgContext produced by looking a selector up in the caller's real seats — never from a value the caller sent. The database would still refuse the write, but this is the layer where the mistake is supposed to be visible.",
      },
    },
    create(context) {
      // The names a request's own data arrives under. Deliberately a closed list rather than a
      // heuristic: a rule that guesses which identifiers are "untrusted" is a rule nobody can
      // predict, and an unpredictable rule gets an eslint-disable comment instead of a fix.
      const REQUEST_NAMES = new Set([
        'input',
        'parsedInput',
        'body',
        'searchParams',
        'params',
        'formData',
        'payload',
        'rawInput',
      ])

      /** The root identifier of `a`, `a.b`, or `a.b.c` — null for anything else. */
      function rootIdentifier(node) {
        let n = node
        while (n.type === 'MemberExpression') n = n.object
        return n.type === 'Identifier' ? n.name : null
      }

      return {
        // ARM 1 — a zod object literal carrying an org field.
        Property(node) {
          const key = node.key
          const name =
            key.type === 'Identifier' ? key.name : key.type === 'Literal' ? key.value : null
          if (name !== 'orgId' && name !== 'org_id') return

          // Inside a zod builder => this is a CONTRACT field.
          if (name === 'orgId' && nestedInZodBuilder(node)) {
            context.report({ node, messageId: 'contractField' })
            return
          }

          // ARM 2 — an object literal (a row being written) whose org_id comes from input.
          if (name !== 'org_id') return
          const source = rootIdentifier(node.value)
          if (source !== null && REQUEST_NAMES.has(source)) {
            context.report({ node, messageId: 'fromInput', data: { source } })
          }
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

  // Directory order is the filesystem's, not the alphabet's. `readdir` returns entries in
  // whatever order the OS hands back — inode order on ext4, roughly creation order on APFS,
  // arbitrary on a network mount — so anything derived from it (a manifest, a hash, an
  // error list, a "first match wins" lookup) is machine-dependent. The failure is
  // characteristically nasty: it is stable on the machine that wrote it and reorders on
  // somebody else's, which reads as flakiness rather than as a missing sort.
  //
  // The rule is DELIBERATELY SYNTACTIC: the sort must be in the same expression. Following
  // the value through a variable would need dataflow analysis ESLint cannot do soundly, and
  // a rule that guesses is a rule that misses the case it was written for. `.filter(…)` and
  // `.map(…)` between the read and the sort are fine — only the sort's presence is checked.
  // SOURCE: https://nodejs.org/api/fs.html#fsreaddirsyncpath-options (order is not guaranteed)
  'no-unsorted-readdir': {
    meta: {
      type: 'problem',
      docs: { description: 'Sort a directory listing in the same expression that reads it.' },
      schema: [],
      messages: {
        unsorted:
          "Sort this directory listing: readdir order is the filesystem's, so anything derived from it differs between machines. Chain `.sort()` in this expression (after any .filter()/.map()), or use the shared walker in tools/lib/fs-walk.mjs, which already sorts.",
      },
    },
    create(context) {
      return {
        CallExpression(node) {
          if (!isReaddirCall(node)) return
          if (chainSorts(node)) return
          context.report({ node, messageId: 'unsorted' })
        },
      }
    },
  },

  // THE SINGLE MOST CONSEQUENTIAL LINE IN THE CODEBASE, held with AST precision.
  //
  // `getSession()` decodes whatever JWT it finds in the stored session and returns it
  // WITHOUT verifying the signature. On a server that store is a cookie the CALLER sent,
  // so anyone can claim any `sub`. `getUser()` authenticates against the auth server;
  // `getClaims()` verifies locally against the project's published asymmetric key. Both
  // are verifications. `getSession()` is not one, and it is one autocomplete away.
  //
  // Until 0.3.0 the only mechanical guard was a write-guard regex scoped to `^apps/web/`
  // AND gated on whole-file writes: an Edit that inserted `.auth.getSession()` into
  // packages/api, a vertical's server barrel or an Edge Function passed every layer. A
  // rule on a MEMBER CALL cannot be fooled by an Edit fragment, so this is where the
  // property actually lives; the write-guard is the layer-3 tripwire beside it.
  //
  // `'use client'` exempts a file: a browser component reading its OWN session is a
  // different act entirely. apps/mobile is out of scope by construction for the same
  // reason — the mobile app is an untrusted bearer of its own scoped token, and it reads
  // that token out of LargeSecureStore to attach it (apps/mobile/src/lib/trpc/client.ts).
  // SOURCE: .claude/rules/security-invariants.md (getUser/getClaims, NEVER getSession)
  'no-unverified-session': {
    meta: {
      type: 'problem',
      docs: { description: 'Resolve the user with getUser()/getClaims(); never getSession().' },
      schema: [],
      messages: {
        unverified:
          "Server-side identity is getUser() / getClaims(), NEVER getSession(). getSession() returns the stored JWT WITHOUT verifying its signature, and on a server that store is an attacker-controlled cookie — a forged `sub` is accepted. Use `await supabase.auth.getUser()` (authenticates against the auth server) or `getClaims()` (verifies against the published key). If this is a browser component, mark the file 'use client'.",
      },
    },
    create(context) {
      const source = context.sourceCode ?? context.getSourceCode()
      // A file-level directive, judged as a DIRECTIVE and not as a substring: a
      // `'use client'` inside a comment or a string literal further down the file must
      // not exempt anything.
      const isClient = (source.ast.body ?? []).some(
        (n) =>
          n.type === 'ExpressionStatement' &&
          n.expression?.type === 'Literal' &&
          n.expression.value === 'use client',
      )
      if (isClient) return {}
      return {
        MemberExpression(node) {
          if (node.computed) return
          if (node.property.type !== 'Identifier' || node.property.name !== 'getSession') return
          // `x.auth.getSession` — the Supabase shape. A `getSession` member on anything
          // else (a session store, a test double) is not this rule's business, and a rule
          // that flagged every identifier named getSession would be turned off.
          const obj = node.object
          const onAuth =
            obj.type === 'MemberExpression' &&
            !obj.computed &&
            obj.property.type === 'Identifier' &&
            obj.property.name === 'auth'
          if (!onAuth) return
          context.report({ node, messageId: 'unverified' })
        },
      }
    },
  },

  // The service-role credential, confined to its ONE sanctioned home.
  //
  // `service_role` BYPASSES row-level security: no policy in the repo constrains it and
  // the RLS isolation suite cannot cover it. It is reachable only inside an ADR-governed
  // Edge Function via createServiceRoleClient_BYPASSES_RLS(warrant) — never a Server
  // Action, a tRPC procedure, a script or a screen. The write-guard's version of this rule
  // was scoped to `^apps/web/`, which left every other server surface open.
  //
  // Judged on the three SYMBOLS, because that is what "reaching for it" looks like: the
  // deliberately-shouty factory name, the credential accessor, and the env var. The
  // defining module and the env validators are the sanctioned homes for the symbols
  // themselves and are excluded by the eslint.config glob, not by a check here — a rule
  // that carried its own path exceptions would have two places to weaken it.
  // SOURCE: packages/platform/supabase/src/service-role.ts
  'service-role-edge-functions-only': {
    meta: {
      type: 'problem',
      docs: {
        description: 'The service-role credential lives only in an ADR-governed Edge Function.',
      },
      schema: [],
      messages: {
        misplaced:
          "The service-role credential BYPASSES row-level security — no policy in this repo constrains it and the RLS suite cannot cover it. Its ONE sanctioned home is an ADR-governed Edge Function (supabase/functions/<name>/index.ts), reached through createServiceRoleClient_BYPASSES_RLS(warrant); never a Server Action, a tRPC procedure, a script or a screen. Do the work through the caller's own RLS-scoped client, or move it into an Edge Function with an ADR.",
      },
    },
    create(context) {
      const SYMBOLS = new Set([
        'createServiceRoleClient_BYPASSES_RLS',
        'serviceRoleCredentials',
        'SUPABASE_SERVICE_ROLE_KEY',
      ])
      const report = (node) => {
        context.report({ node, messageId: 'misplaced' })
      }
      return {
        Identifier(node) {
          if (!SYMBOLS.has(node.name)) return
          // A property KEY named for the symbol (`{ SUPABASE_SERVICE_ROLE_KEY: … }` in a
          // type or a test env block) is a mention; a member ACCESS through it
          // (`process.env.SUPABASE_SERVICE_ROLE_KEY`) is a reach. Both matter here — the
          // point is that the symbol has no business in this file at all — so only a
          // shorthand-free property key on an object being TYPED is let through, which
          // this deliberately does not attempt to distinguish. Report either way.
          report(node)
        },
        Literal(node) {
          // The env var reached by string: process.env['SUPABASE_SERVICE_ROLE_KEY'].
          if (typeof node.value === 'string' && SYMBOLS.has(node.value)) report(node)
        },
      }
    },
  },
}

export default { rules }
