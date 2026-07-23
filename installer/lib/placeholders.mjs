// Placeholder registry. Every {{TOKEN}} used anywhere under template/ MUST be
// declared here (scripts/hygiene.mjs enforces closure in both directions).
// Declaration order is prompt order — identity first, deployment last.
// NOTE: Entra tenant/client IDs are deliberately NOT placeholders — they are
// per-environment deployment config and live in .env (see env.example).
// Baking placeholder GUIDs into committed files invites real IDs into git.
// Each entry may carry `validate(value) -> string | null` (an error message,
// or null when acceptable). Invalid answers are rejected up front: the
// APP_IDENTIFIER is store identity on BOTH stores (iOS bundleIdentifier and
// android.package) and immutable after first release (identity.lock.json pins
// it), and a malformed API_ORIGIN is baked into the committed transport policy.
export const PLACEHOLDERS = {
  PROJECT_NAME: {
    prompt: 'Human-readable project name (e.g. "Acme Curriculum")',
    default: (ctx) => ctx.dirName ?? 'My Project',
    validate: (v) => (v.trim() === '' ? 'must not be empty' : null),
  },
  PROJECT_SLUG: {
    prompt: 'Package/machine name (kebab-case)',
    default: (ctx) =>
      (ctx.answers.PROJECT_NAME ?? ctx.dirName ?? 'my-project')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, ''),
    validate: (v) =>
      /^[a-z0-9]+(-[a-z0-9]+)*$/.test(v) ? null : 'must be kebab-case ([a-z0-9-], no leading/trailing dash)',
  },
  // Store identity for BOTH stores: app.config.ts uses it as ios.bundleIdentifier
  // AND android.package, so it must satisfy the intersection of both rule sets —
  // Android forbids hyphens and requires letter-first segments; iOS forbids
  // underscores. Intersection: segments of [a-z][a-z0-9]*, dot-separated, >= 2
  // segments. Immutable after first release (tools/identity.lock.json pins it).
  APP_IDENTIFIER: {
    prompt: 'Reverse-DNS app identifier (e.g. com.acme.curriculum — iOS bundle id AND Android package, immutable after release)',
    default: (ctx) => {
      const slug = (ctx.answers.PROJECT_SLUG ?? ctx.dirName ?? 'my-project')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '')
      return `com.example.${slug}`
    },
    validate: (v) => {
      if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(v)) {
        return 'must be reverse-DNS with [a-z][a-z0-9]* segments (no hyphens — Android forbids them; no underscores — iOS forbids them)'
      }
      return null
    },
  },
  // Deep-link scheme: expo-router linking + the expo-auth-session redirect URI.
  // A scheme is registered OS-wide, so collisions hijack redirects — derive it
  // from the slug and keep it plain lowercase alphanumerics.
  APP_SCHEME: {
    prompt: 'Deep-link URL scheme (lowercase alphanumerics, e.g. acmecurriculum)',
    default: (ctx) =>
      (ctx.answers.PROJECT_SLUG ?? ctx.dirName ?? 'myapp').toLowerCase().replace(/[^a-z0-9]+/g, ''),
    validate: (v) => (/^[a-z][a-z0-9]*$/.test(v) ? null : 'must be a lowercase alphanumeric scheme starting with a letter'),
  },
  // The web app's origin. In this lineage apps/web is BOTH the web client and
  // the API host (it mounts the tRPC router at /api/trpc), so one origin serves
  // three roles at once: the mobile client's transport target, the cookie/CORS
  // origin, and the committed app.config.ts extra. It is a placeholder rather
  // than env because it lands in the committed transport-security policy the
  // expo-policy gate asserts (https-or-loopback).
  WEB_ORIGIN: {
    prompt: 'Web app origin — also the API host and cookie origin (e.g. https://app.example.com)',
    default: (_ctx) => 'http://127.0.0.1:3000',
    validate: (v) =>
      /^https?:\/\/[a-zA-Z0-9.-]+(:\d+)?$/.test(v)
        ? null
        : 'must be a bare origin — http(s)://host[:port], no path or trailing slash (it lands in the committed transport policy)',
  },
  // Supabase project ref — the subdomain of the project URL. NOT a secret: it
  // appears in every client-side request URL. It is a placeholder because
  // supabase/config.toml commits it and the CI generated-types lane keys off it.
  // 'TBD' is accepted so init never blocks on project creation; doctor warns
  // while it remains (same doctrine as the EAS/store ids below).
  SUPABASE_PROJECT_REF: {
    prompt: 'Supabase project ref (20-char id from the project URL, or TBD)',
    default: () => 'TBD',
    validate: (v) =>
      v === 'TBD' || /^[a-z]{20}$/.test(v)
        ? null
        : 'must be the 20-character lowercase project ref from the Supabase project URL, or TBD',
  },
  GITHUB_OWNER: {
    prompt: 'GitHub org/user that owns the repo',
    default: (ctx) => ctx.gitOwner ?? 'your-github-owner',
    validate: (v) => (/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(v) ? null : 'must be a GitHub org/user name'),
  },
  SECURITY_OWNERS: {
    prompt: 'GitHub handle/team for auth+data sign-off (CODEOWNERS)',
    default: (ctx) => `@${ctx.answers.GITHUB_OWNER ?? ctx.gitOwner ?? 'your-github-owner'}`,
    validate: (v) =>
      /^@[\w./-]+( @[\w./-]+)*$/.test(v) ? null : 'must be one or more @handles/@org/team entries (space-separated)',
  },
  DEFAULT_BRANCH: {
    prompt: 'Default git branch',
    default: () => 'main',
    validate: (v) => (/^[\w./-]+$/.test(v) ? null : 'must be a valid branch name'),
  },
  // EAS/store identity — NOT secrets (ASC app ids and team ids appear in every
  // App Store URL; the EAS project id is printed by `eas init`). They are
  // placeholders because eas.json/app.config.ts commit them; 'TBD' is accepted
  // so init never blocks on store onboarding — doctor warns while it remains.
  EAS_PROJECT_ID: {
    prompt: 'EAS project id (UUID from `eas init`, or TBD)',
    default: () => 'TBD',
    validate: (v) =>
      v === 'TBD' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
        ? null
        : 'must be the EAS project UUID (from `eas init`) or TBD',
  },
  ASC_APP_ID: {
    prompt: 'App Store Connect app id (numeric, or TBD)',
    default: () => 'TBD',
    validate: (v) => (v === 'TBD' || /^\d+$/.test(v) ? null : 'must be the numeric ASC app id or TBD'),
  },
  APPLE_TEAM_ID: {
    prompt: 'Apple Developer team id (10 chars, or TBD)',
    default: () => 'TBD',
    validate: (v) => (v === 'TBD' || /^[A-Z0-9]{10}$/.test(v) ? null : 'must be the 10-character Apple team id or TBD'),
  },
}

const TOKEN_RE = /\{\{([A-Z0-9_]+)\}\}/g

export function render(text, answers) {
  return text.replace(TOKEN_RE, (whole, name) => {
    if (name in answers) return answers[name]
    return whole // unknown tokens are left intact and flagged by doctor/hygiene
  })
}

export function tokensIn(text) {
  const found = new Set()
  for (const m of text.matchAll(TOKEN_RE)) found.add(m[1])
  return found
}
