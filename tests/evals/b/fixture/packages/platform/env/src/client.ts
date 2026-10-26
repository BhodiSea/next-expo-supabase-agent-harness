import { z } from 'zod'

// ---------------------------------------------------------------------------
// @app/env/client — THE METRO-SAFE HALF OF THE ENVIRONMENT.
//
// Everything reachable from this file is bundled into a browser bundle AND into
// a native binary, so everything reachable from this file is PUBLIC by
// construction. It parses the two build-time-inlined classes of variable and it
// structurally cannot reach the third: the server parser lives in ./index.ts,
// and nothing here imports it.
//
// ===========================================================================
//                      THE THREE CLASSES, AND WHY THREE
// ===========================================================================
//
// (a) SERVER-ONLY SECRETS — read only inside a process the operator runs.
//     Their VALUES are capabilities: the service-role key bypasses row security
//     altogether, so holding it is holding every row of every tenant, and the
//     database URL carries a password in its authority component. They live in
//     ./index.ts and are unreachable from here.
//
//     The wall is the IMPORT GRAPH, not a runtime branch. A bundler decides what
//     to ship by walking imports and inlining literals; it does not evaluate
//     your conditions. `if (typeof window === 'undefined') { read the secret }`
//     leaves the secret's value sitting in the artifact next to a branch that
//     never runs — the check reads as protection and protects nothing. Two
//     files, one of which cannot see the other, is a wall a bundler respects.
//     SOURCE: docs/security/sandbox-and-supply-chain.md (secrets never cross
//     into a shipped bundle) docs/harness/README.md
//
// (b) NEXT_PUBLIC_* — inlined by the WEB build into the JavaScript it serves to
//     browsers. The value is not "available to the client at runtime"; it is
//     substituted into the source text at build time, so it is in the deployed
//     bundle whether or not any code path reads it.
//
// (c) EXPO_PUBLIC_* — inlined by Metro into the JS bundle that ships INSIDE the
//     app binary, by exactly the same mechanism and with the same consequence.
//     SOURCE: EXPO_PUBLIC_ variables are substituted at bundle time and are
//     visible in plain text in the compiled application
//     https://docs.expo.dev/guides/environment-variables/
//
// WHY (b) AND (c) ARE TWO SCHEMAS RATHER THAN ONE "public" SCHEMA.
// Not tidiness — they are inlined by DIFFERENT build systems into DIFFERENT
// artifacts with DIFFERENT lifetimes, and a single schema would be wrong on
// both surfaces at once:
//
//   1. Neither surface has the other's variables. A web deploy has no
//      EXPO_PUBLIC_* set and a native build has no NEXT_PUBLIC_* set, so one
//      merged required schema fails on both, and one merged optional schema is
//      no schema at all — every variable becomes "maybe", which is precisely the
//      state this package exists to abolish.
//   2. The artifacts have different recall stories. A web bundle is replaced by
//      the next deploy; a native binary is on devices and in a store archive
//      forever. Keeping them apart keeps that asymmetry visible at the place
//      where somebody decides which channel a value goes into.
//
// WHY A PUBLIC-PREFIXED SECRET IS A PERMANENT LEAK.
// A secret behind a NEXT_PUBLIC_ / EXPO_PUBLIC_ name is not "exposed to users
// who look hard" — it is COMPILED INTO A SHIPPED ARTIFACT. There is no revert:
// the web bundle is in browser caches and CDN edges, and the native binary is
// installed on devices you cannot reach and archived in stores you cannot edit.
// Deleting the variable changes nothing about the copies already distributed.
// The only remedy is rotating the secret at its source — every app already
// running keeps working with the leaked value until you do, and the incident
// is dated from the first build, not from the day you noticed.
//
// That is why the naming rule has no exception and is enforced on the NAME
// rather than the value (the expo-policy gate reds any EXPO_PUBLIC_ name
// carrying KEY / SECRET / TOKEN / PASSWORD / PRIVATE): a gate cannot tell a
// publishable key from an elevated one by looking at the string, and a
// name-shape rule with an exception is not a rule. The publishable key below is
// genuinely public — row security is the access boundary and the key only
// identifies the project to the gateway — and it still carries a name with no
// secret-shaped substring, so nobody has to re-litigate the exception.
// ---------------------------------------------------------------------------

/**
 * The two build-time inlining prefixes. Anything else is a server-side name, and
 * `assertNoServerOnlyKeys` below refuses to let one through a client parser.
 */
export const PUBLIC_PREFIXES = ['NEXT_PUBLIC_', 'EXPO_PUBLIC_'] as const

/**
 * What a parser accepts: a flat record of raw strings.
 *
 * Deliberately NOT `typeof process.env`. A parser that reaches for a global is
 * a parser you cannot test without mutating the host, and every parse in this
 * package is a pure function of an explicit record. The `read*` functions below
 * are the ONLY places that touch the host, and they are three lines each.
 */
export type EnvSource = Readonly<Record<string, string | undefined>>

// Metro and the web build both rewrite the LITERAL member expression
// `process.env.SOME_NAME` at build time. A computed read (`process.env[name]`)
// is not a member expression they can see, so it stays a runtime lookup of an
// object the shipped bundle does not carry — it yields undefined on a device
// and reads as "the operator forgot to set it". DOT ACCESS IS LOAD-BEARING, and
// so is the fact that these names are spelled out one per line: there is no way
// to enumerate inlined variables, only to name them.
//
// The local declaration types exactly the six public names. It is not
// @types/node: this package compiles with an empty ambient type list, so a
// stray `process.exit`, `process.cwd()` or a read of an unlisted variable is a
// compile error here rather than a red screen inside Hermes.
// SOURCE: EXPO_PUBLIC_ variables are inlined at bundle time, so the read must be
// a literal member expression https://docs.expo.dev/guides/environment-variables/
declare const process: {
  readonly env: {
    readonly NEXT_PUBLIC_SUPABASE_URL?: string
    readonly NEXT_PUBLIC_SUPABASE_PUBLISHABLE?: string
    readonly NEXT_PUBLIC_WEB_ORIGIN?: string
    readonly EXPO_PUBLIC_SUPABASE_URL?: string
    readonly EXPO_PUBLIC_SUPABASE_PUBLISHABLE?: string
    readonly EXPO_PUBLIC_WEB_ORIGIN?: string
  }
}

/**
 * A bare origin: scheme, host, optional port. No path, no trailing slash — the
 * value is concatenated with paths by callers, and `https://host/` + `/api`
 * produces a double slash that some gateways route and some 404.
 *
 * Validated by pattern rather than by the `URL` constructor on purpose. This
 * module is bundled into Hermes, whose built-ins are React Native's own
 * polyfills rather than the browser objects Node and browsers ship; a validator
 * built on `URL` therefore accepts different strings on the two surfaces, and
 * the same environment would pass on web and fail on a phone with no way to
 * tell why. A regex is the same regex everywhere.
 * SOURCE: the React Native runtime supplies its own polyfilled built-ins, not a
 * browser's https://reactnative.dev/docs/javascript-environment
 *
 * A single-label host is accepted (`https://gateway:8000` is what a container
 * network looks like) — rejecting it would be a gate failing on correct input,
 * which is how gates get deleted. `@` is deliberately outside the character
 * class, so a URL carrying credentials in its authority is not an origin here:
 * that shape is a connection string, and connection strings are class (a).
 */
const ORIGIN_PATTERN = /^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/i

/**
 * The one sanctioned cleartext exception: a loopback host, which never leaves
 * the machine and is where `supabase start` serves the local stack. Any other
 * http:// origin is rejected — a cleartext origin baked into a shipped bundle is
 * a downgrade every user inherits.
 * SOURCE: loopback is treated as a secure context precisely because the traffic
 * cannot be observed on the network
 * https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts
 */
const LOOPBACK_ORIGIN_PATTERN = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/

const ORIGIN_MESSAGE =
  'must be a bare origin — scheme, host and optional port, with no path and no trailing slash ' +
  '(http:// is accepted only for localhost / 127.0.0.1)'

const Origin = z.string().refine((value) => {
  return ORIGIN_PATTERN.test(value) || LOOPBACK_ORIGIN_PATTERN.test(value)
}, ORIGIN_MESSAGE)

/**
 * The publishable key is checked for LENGTH and nothing else.
 *
 * A format check would be the tempting version and it is the wrong one: this
 * project has shipped more than one publishable-key spelling, so a pattern
 * pinned to today's shape rejects a valid key on the day the format moves —
 * a gate that fails on correct input teaches operators to delete gates. Length
 * catches the two mistakes that actually happen: the bare `NAME=` line copied
 * out of env.example, and the half-selected paste.
 */
const PublishableKey = z
  .string()
  .min(
    20,
    'is empty or truncated — copy the project publishable key in full (an unset variable and a ' +
      'partially-pasted one fail the same way at the gateway, hours later)',
  )

/**
 * (b) The NEXT_PUBLIC_ class: everything the WEB bundle carries in the open.
 *
 * All three are required. The web surface has no second source for any of them —
 * unlike the native surface, which commits defaults into its app config — so an
 * absent one is a deployment that must not start.
 */
export const WebPublicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: Origin,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE: PublishableKey,
  NEXT_PUBLIC_WEB_ORIGIN: Origin,
})

/** The parsed web-public environment. */
export type WebPublicEnv = z.infer<typeof WebPublicEnvSchema>

/**
 * (c) The EXPO_PUBLIC_ class: everything the NATIVE binary carries in the open.
 *
 * Two of the three are optional, and optional here means exactly one thing:
 * THIS SURFACE HAS A SECOND, COMMITTED SOURCE FOR THE VALUE (app.config.ts
 * `extra`, which is baked into the build and is public by design). It never
 * means "we will invent a default" — this package has no defaults at all,
 * because a default is a value nobody chose that behaves like a value somebody
 * chose, and it hides a misconfiguration until the first request fails.
 *
 * The publishable key has no second source: it is per project and per
 * environment, so its absence is a configuration error and is loud.
 */
export const NativePublicEnvSchema = z.object({
  EXPO_PUBLIC_SUPABASE_URL: Origin.optional(),
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE: PublishableKey,
  EXPO_PUBLIC_WEB_ORIGIN: Origin.optional(),
})

/** The parsed native-public environment. */
export type NativePublicEnv = z.infer<typeof NativePublicEnvSchema>

/**
 * The half of a zod issue this package reports on.
 *
 * Structural, not `z.ZodError`: the failure text is the contract an operator
 * reads, and pinning it to a library's error class would make a zod major
 * version a change to the boot experience. `path` is the variable name, because
 * every schema here is one flat object keyed by variable name.
 */
interface EnvIssue {
  readonly path: readonly PropertyKey[]
  readonly message: string
}

/**
 * Turn a parse failure into ONE loud, actionable error and throw it.
 *
 * Throwing — in a repo whose kernel doctrine is that failures ride the data
 * channel as an envelope — is deliberate and is the narrow exception. The
 * envelope exists so a SCREEN can branch on a domain failure; a missing
 * environment variable has no screen and no caller. It is a fault in the
 * process itself, discovered before the process is useful for anything, and the
 * only correct behaviour is to refuse to run.
 *
 * The message names every offending variable at once rather than the first:
 * an operator filling in a fresh deployment should get one list, not a
 * boot-fix-boot-fix loop. Sorted, so two runs of the same broken config produce
 * the same text (a log line that reorders itself defeats deduplication).
 */
function throwEnvError(surface: string, issues: readonly EnvIssue[]): never {
  const named = issues
    .map((issue) => {
      const path = issue.path.map((segment) => String(segment)).join('.')
      return `  ${path === '' ? '(whole record)' : path}: ${issue.message}`
    })
    .sort()
  throw new Error(
    `@app/env: the ${surface} environment is invalid — nothing has started.\n` +
      `${named.join('\n')}\n` +
      'Set every variable named above (env.example lists them) and start again. This package ' +
      'parses ONCE, at startup, and refuses to run on a partial environment: parsed lazily, the ' +
      'same mistake surfaces hours later inside whichever request first happened to read it.',
  )
}

/**
 * Parse `source` against `schema` or throw. Shared with ./index.ts so the server
 * parser produces byte-identical failure text — an operator should not have to
 * learn two error formats depending on which half of the environment is wrong.
 *
 * @internal consumed by ./index.ts.
 */
export function parseEnvOrThrow<Output>(
  schema: z.ZodType<Output>,
  source: EnvSource,
  surface: string,
): Output {
  const parsed = schema.safeParse(source)
  if (!parsed.success) throwEnvError(surface, parsed.error.issues)
  return parsed.data
}

/**
 * Refuse a source record carrying any name that is not build-time public.
 *
 * zod already STRIPS unknown keys, so this changes nothing about the parsed
 * value; it changes what happens to the mistake. Stripping is silent, and the
 * mistake it hides — wiring the process environment, or a hand-built record
 * carrying a secret, into a parser whose output a client component reads — is
 * one where the next edit ships the secret. A parser on the public side of the
 * wall should be unable to be handed a secret at all.
 *
 * Presence is the trigger, not the value: `{ SUPABASE_DB_URL: undefined }` is
 * rejected too. The shape of the call is the defect.
 *
 * The cost is stated plainly: `parseWebPublicEnv(process.env)` throws, because
 * the whole process environment is not a client input. Call it with no argument
 * (the reader performs the inlined literal reads) or pass the narrow record.
 */
function assertNoServerOnlyKeys(source: EnvSource, parser: string): void {
  const smuggled = Object.keys(source)
    .filter((key) => !PUBLIC_PREFIXES.some((prefix) => key.startsWith(prefix)))
    .sort()
  if (smuggled.length === 0) return
  throw new Error(
    `@app/env/client: ${parser} was handed non-public variable name(s): ${smuggled.join(', ')}. ` +
      'This parser is bundled into a browser bundle and a native binary; only ' +
      `${PUBLIC_PREFIXES.join(' and ')} names belong on this side of the wall. Server-side ` +
      'names are parsed by @app/env (the "." barrel), which apps/mobile may not import.',
  )
}

/** The inlined NEXT_PUBLIC_ reads — the only place the web surface touches the host. */
export function readWebPublicEnv(): EnvSource {
  return {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE,
    NEXT_PUBLIC_WEB_ORIGIN: process.env.NEXT_PUBLIC_WEB_ORIGIN,
  }
}

/** The inlined EXPO_PUBLIC_ reads — the only place the native surface touches the host. */
export function readNativePublicEnv(): EnvSource {
  return {
    EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE,
    EXPO_PUBLIC_WEB_ORIGIN: process.env.EXPO_PUBLIC_WEB_ORIGIN,
  }
}

/**
 * Parse (b). Call it ONCE, at module scope in the web surface's entry
 * (`instrumentation.ts`), so a bad environment reds the boot rather than a page.
 *
 * WHY THIS FILE HAS NO EAGER MODULE-SCOPE CONSTANT while ./index.ts does: one
 * file, two artifacts. A web bundle and a native binary both evaluate this
 * module, and neither carries the other's variables — an eager parse of both
 * classes here would fail on both surfaces, and an eager parse of "whichever
 * class looks present" would be the surface sniffing this package refuses to do
 * (guessing which environment you are in is how a native build silently accepts
 * a web deployment's half-filled config). Eagerness belongs to the entry module,
 * which is the one place that knows which artifact it is.
 */
export function parseWebPublicEnv(source: EnvSource = readWebPublicEnv()): WebPublicEnv {
  assertNoServerOnlyKeys(source, 'parseWebPublicEnv')
  return parseEnvOrThrow(WebPublicEnvSchema, source, 'web public (NEXT_PUBLIC_*)')
}

/**
 * Parse (c). Call it ONCE, at module scope in the native surface's entry
 * (`app/_layout.tsx`), for the same reason and with the same consequence.
 */
export function parseNativePublicEnv(source: EnvSource = readNativePublicEnv()): NativePublicEnv {
  assertNoServerOnlyKeys(source, 'parseNativePublicEnv')
  return parseEnvOrThrow(NativePublicEnvSchema, source, 'native public (EXPO_PUBLIC_*)')
}
