// RFC 9116 security.txt — parsing shared by two gates SPLIT ON THE CLOCK, the
// cc-floor/eol pattern one file over: the chain's `security-headers` step judges the
// SHAPE (clockless — present ⇒ parses, Contact is a proper URI, Expires is a proper
// timestamp appearing exactly once), and the scheduled `floor-review` job judges the
// CALENDAR (expired, or a bound further out than the RFC's one-year recommendation).
// `pnpm validate` must give the same verdict on the same tree forever, so no date
// comparison lives in the chain half.
//
// The file itself is seedOnInitOnly (apps/web/public/.well-known/security.txt): its
// mandatory `Expires` is a reviewer-supplied bound — {{SECURITY_TXT_EXPIRES}}, an init
// answer defaulting to init+180d — and planting a bound nobody reviewed into an
// existing install would be the off-switch shape 0.6.0 removed from
// framework-floor.json. An install without the file simply has no machine-readable
// disclosure channel to judge, and both gates say so without redding.
// SOURCE: RFC 9116 (Contact and Expires are MANDATORY; Expires SHOULD be < 1 year)
const FIELD_LINE = /^([A-Za-z][A-Za-z-]*):[ \t]*(.*)$/
// RFC 9116 Expires is an Internet profile RFC 3339 date-time.
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
// An https/mailto/tel URI — RFC 9116 forbids cleartext http for web contacts.
const CONTACT_URI = /^(https:\/\/|mailto:|tel:)\S+$/

/**
 * Parse a security.txt body against the RFC 9116 line grammar and field rules.
 * @param {string} text
 * @returns {{ expires: string | null, problems: string[] }}
 */
export function parseSecurityTxt(text) {
  const problems = []
  const fields = []
  const lines = text.split(/\r?\n/)
  for (const [i, line] of lines.entries()) {
    if (line.trim() === '' || line.startsWith('#')) continue
    const m = line.match(FIELD_LINE)
    if (m === null) {
      problems.push(
        `line ${i + 1} is neither a comment, a blank line, nor a "Field-Name: value" line — RFC 9116 has no other line kind, and a file that half-parses serves researchers a half-statement`,
      )
      continue
    }
    fields.push({ name: m[1].toLowerCase(), value: m[2].trim() })
  }

  const contacts = fields.filter((f) => f.name === 'contact')
  if (contacts.length === 0) {
    problems.push(
      'no Contact field — RFC 9116 makes it MANDATORY; a disclosure file with no channel points researchers nowhere',
    )
  }
  for (const c of contacts) {
    if (!CONTACT_URI.test(c.value)) {
      problems.push(
        `Contact "${c.value}" is not an https://, mailto: or tel: URI — RFC 9116 requires a URI and forbids cleartext http for web contacts`,
      )
    }
  }

  const expires = fields.filter((f) => f.name === 'expires')
  if (expires.length === 0) {
    problems.push(
      'no Expires field — RFC 9116 makes it MANDATORY, and it is the entire reason this file ships with a reviewed bound rather than as a permanent claim',
    )
  } else if (expires.length > 1) {
    problems.push('Expires appears more than once — RFC 9116 says it MUST NOT')
  } else if (!RFC3339.test(expires[0].value) || Number.isNaN(Date.parse(expires[0].value))) {
    problems.push(
      `Expires "${expires[0].value}" is not an RFC 3339 date-time (e.g. 2027-02-11T23:59:59.000Z)`,
    )
  }

  const okExpires = expires.length === 1 && RFC3339.test(expires[0].value) ? expires[0].value : null
  return { expires: okExpires, problems }
}

const DAY_MS = 86_400_000

/**
 * The clockful half, for the scheduled floor-review job only.
 * @param {{ text: string, today: string, path: string }} input
 * @returns {string[]} problems, empty when the bound is live and near enough
 */
export function staleSecurityTxt({ text, today, path }) {
  const { expires, problems } = parseSecurityTxt(text)
  if (problems.length > 0 || expires === null) {
    // Shape faults red in the chain too; here they mean the bound cannot be judged.
    return problems.map((p) => `${path} cannot be judged fresh — ${p}`)
  }
  const expiresAt = Date.parse(expires)
  const todayAt = Date.parse(`${today}T00:00:00Z`)
  if (expiresAt < todayAt) {
    return [
      `${path} EXPIRED at ${expires} — RFC 9116 says an expired file should not be trusted, so the published disclosure channel is now a stale statement; re-review the channel and move the bound in the same commit`,
    ]
  }
  if (expiresAt > todayAt + 366 * DAY_MS) {
    return [
      `${path} carries an Expires bound more than 366 days out (${expires}) — RFC 9116 recommends under a year, and a longer bound is a review nobody scheduled`,
    ]
  }
  return []
}
