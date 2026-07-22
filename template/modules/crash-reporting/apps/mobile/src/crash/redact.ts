// Crash-report redaction (crash-reporting module). Every event that leaves the
// app — Sentry beforeSend, a breadcrumb minted by the patched log sink, a
// shipped log excerpt — passes through here FIRST. The wiring patches in
// docs/modules/crash-reporting/ plug these functions into the transport; this
// module is dependency-free so the policy is unit-testable without any SDK.
// SOURCE: harness doctrine — crash pipelines are exfiltration paths until proven
// otherwise; redaction is enforced at the boundary, in code, with tests
// [corpus: harness/doctrine]

export interface CrashEvent {
  readonly message: string
  readonly stack?: string
  readonly context?: Readonly<Record<string, unknown>>
}

// cspell:ignore amqps -- literal URL scheme named in the allow-list post-mortem below
// Keys whose VALUES are always dropped wholesale, regardless of shape.
const SECRET_KEY_PATTERN =
  /password|passwd|secret|token|authorization|cookie|api[-_]?key|credential|dsn/i

// Shape-based scrubbers for free text (messages, stacks, string values).
const TEXT_REDACTIONS: readonly (readonly [RegExp, string])[] = [
  // Credentialed connection strings: keep the scheme, drop the userinfo. The scheme is
  // matched GENERICALLY, not from an allow-list — an allow-list of (postgres|mysql|redis|amqp)
  // silently leaked every scheme it forgot: `mongodb://admin:hunter2@localhost` and
  // `https://svc:hunter2@internal-api/health` passed through with the password INTACT, and
  // `amqps://` did not match `amqp` either. In a redaction boundary the default must be
  // "scrub", never "scrub the ones I listed". The userinfo class excludes `/` so a path
  // containing an @ (`http://host/a@b`) is not mistaken for credentials.
  [/\b([a-z][a-z0-9+.-]*):\/\/[^@/\s'"]+@/gi, '$1://[redacted]@'],
  // Authorization header material and JWT-shaped blobs. CASE-INSENSITIVE: `authorization:
  // bearer abc123opaque` is the shape a lowercase-header logger actually emits, and without
  // /i an opaque (non-JWT) lowercase token leaked in full — the /eyJ/ rule below only saves
  // the JWT-shaped ones.
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[redacted-jwt]'],
  // E-mail addresses (usernames are PII in an on-prem deployment).
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[redacted-email]'],
  // Home directories carry the OS username. Windows profile + Linux home cover
  // text relayed from the API server (an error body quoting a server-side path
  // reaches this policy through the crash message).
  [/[A-Za-z]:\\Users\\[^\\\s'"]+/g, 'C:\\Users\\[redacted]'],
  [/\/home\/[^/\s'"]+/g, '/home/[redacted]'],
  // macOS home directories — the mobile adaptation: Metro serves dev bundles
  // whose stack frames embed the dev machine's absolute project path, and that
  // path starts with the developer's home directory (their username). The rule
  // collapses the WHOLE prefix to one marker instead of reconstructing the
  // path shape, and spells the directory with a non-capturing group, because
  // the harness repo's own leak scanner (scripts/hygiene.mjs) reds any literal
  // macOS home-path text in shipped template files — source code included.
  [/\/(?:Users)\/[^/\s'"]+/g, '[redacted-home]'],
]

export function redactText(text: string): string {
  let out = text
  for (const [pattern, replacement] of TEXT_REDACTIONS) {
    out = out.replace(pattern, replacement)
  }
  return out
}

function redactValue(key: string, value: unknown): unknown {
  if (SECRET_KEY_PATTERN.test(key)) return '[redacted]'
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) {
    return (value as readonly unknown[]).map((item) => redactValue(key, item))
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactValue(k, v)]),
    )
  }
  return value
}

export function redactCrashEvent(event: CrashEvent): CrashEvent {
  const redacted: { message: string; stack?: string; context?: Record<string, unknown> } = {
    message: redactText(event.message),
  }
  if (event.stack !== undefined) {
    redacted.stack = redactText(event.stack)
  }
  if (event.context !== undefined) {
    redacted.context = Object.fromEntries(
      Object.entries(event.context).map(([k, v]) => [k, redactValue(k, v)]),
    )
  }
  return redacted
}
