// tools/lib/citation-domains.mjs — the ONE allowlist of external documentation
// hosts a bare-URL `SOURCE:` citation may ground on. Shared by the `provenance`
// gate (tools/check-sources.mjs via payloadResolves) and referenced as the
// single source of truth by .claude/agents/citation-verifier.md — there is
// deliberately no second copy of this list anywhere. A URL on any other host is
// NOT provenance by itself: pin the authority in tools/mcp/corpus/index.json
// (version + hashed excerpt) and cite `[corpus: <id>]` instead, or widen this
// list via a reviewed human edit (the file is write-guard-protected; widening
// the allowlist weakens the gate).
// SOURCE: docs/harness/README.md (provenance; one heuristic, two enforcement
// layers) [corpus: harness/doctrine]

// Entries are registrable parent domains: a host matches when it equals the
// entry or is a subdomain of it (www.postgresql.org matches postgresql.org).
// Only domains whose entire content is first-party authoritative documentation
// belong here — github.com stays OFF the list (anyone can host anything there;
// GitHub-hosted authorities are pinned in the corpus instead), and so does
// expo.dev at the apex (docs.expo.dev is the documentation host; the apex
// carries marketing and user-generated project pages).
/** @public exported for the harness repo's gate suite (tests/gates/provenance-rules.test.mjs) */
export const CITATION_DOMAINS = [
  // Named authoritative by .claude/agents/citation-verifier.md since v0.1.0.
  'code.claude.com',
  'react.dev',
  'hono.dev',
  'orm.drizzle.team',
  'postgresql.org',
  'developer.mozilla.org',
  // This stack's platform documentation hosts.
  'docs.expo.dev', // Expo SDK / EAS / config reference — NOT the expo.dev apex
  'reactnative.dev', // React Native docs
  'developer.android.com', // Android platform docs (permissions, network security)
  'developer.apple.com', // Apple developer docs (HIG, App Review Guidelines, Info.plist keys)
  'learn.microsoft.com', // Microsoft Learn (Entra ID, API guidelines) — not microsoft.com at large
  // Genuine authorities the template tree itself cites by bare URL.
  'w3.org', // WCAG / WAI-ARIA / CSS specifications
  'rfc-editor.org', // IETF RFCs (e.g. RFC 4180 CSV grammar)
  'aip.dev', // Google API Improvement Proposals (e.g. AIP-158 pagination)
  'use-the-index-luke.com', // the canonical keyset-pagination / index reference
  'docs.github.com', // GitHub's OWN product docs — not github.com user content
]

// Case-insensitive exact-or-subdomain match against the allowlist. A trailing
// dot (rare but valid FQDN spelling) is normalized away so `hono.dev.` cannot
// dodge — nor spoof — the match.
export function isAllowedCitationHost(host) {
  const h = String(host).toLowerCase().replace(/\.$/, '')
  return CITATION_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`))
}
