import { createLogger } from '@app/observability'
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

// The CSP violation sink.
//
// WHY IT EXISTS. The enforcing Content-Security-Policy tells the BROWSER what to block
// and tells you nothing. A directive that is one token too tight blanks the app for
// real users while every gate stays green and every local Playwright run passes the
// routes it happens to visit. The report-only twin (set alongside the enforcing header
// in proxy.ts) turns that silence into a signal.
//
// WHAT IT IS NOT. This is not an ingestion service and it stores nothing. It logs
// through the observability seam, where redactFields() already strips credential-shaped
// keys, and returns 204. Wiring it to a real collector is a deployment decision, not a
// scaffold one.
//
// TRUST POSTURE. The body is UNAUTHENTICATED and attacker-controlled: anyone on the
// internet can POST here. So it is bounded on every axis that matters — a size cap
// before parsing, a field allowlist after, no echo of the input in the response, and
// nothing written to a database. Treating a violation report as trusted input is how a
// security feature becomes a log-injection surface.
// SOURCE: https://www.w3.org/TR/CSP3/#deprecated-serialize-violation (the report-uri body shape)
// SOURCE: docs/harness/README.md (untrusted input is bounded at the seam it enters)

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// A violation report is a few hundred bytes. Anything larger is not a browser.
const MAX_BODY_BYTES = 8 * 1024

const log = createLogger({ base: { surface: 'csp-report' } })

interface CspReportBody {
  readonly 'csp-report'?: Record<string, unknown>
}

/** The only fields worth keeping — everything else is noise or caller-controlled bulk. */
const REPORTED_FIELDS = [
  'blocked-uri',
  'violated-directive',
  'effective-directive',
  'document-uri',
  'disposition',
  'status-code',
] as const

export async function POST(request: NextRequest): Promise<NextResponse> {
  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) return new NextResponse(null, { status: 413 })

  let parsed: CspReportBody
  try {
    parsed = JSON.parse(raw) as CspReportBody
  } catch {
    // A malformed report is not an error worth paging anyone about, and echoing the
    // parse failure back would make this endpoint a reflection oracle.
    return new NextResponse(null, { status: 204 })
  }

  const report = parsed['csp-report']
  if (report === undefined) return new NextResponse(null, { status: 204 })

  const fields: Record<string, unknown> = {}
  for (const key of REPORTED_FIELDS) {
    const value = report[key]
    // Bounded: a caller cannot use this endpoint to write an unbounded string into
    // the log pipeline.
    if (typeof value === 'string') fields[key] = value.slice(0, 512)
    else if (typeof value === 'number') fields[key] = value
  }

  log.warn('csp_violation', fields)
  return new NextResponse(null, { status: 204 })
}
