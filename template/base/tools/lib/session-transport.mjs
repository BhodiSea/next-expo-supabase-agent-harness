// tools/lib/session-transport.mjs — does the session the BROWSER writes land where the
// SERVER reads it, and are the cookie attributes at every writer the reviewed ones?
//
// WHAT WENT WRONG, because this file exists for one specific defect. The seeded web app
// signed in browser-side and persisted the session to `localStorage` — the supabase-js
// default when no `storage` is supplied — while `proxy.ts`, `lib/supabase/server.ts` and the
// tRPC route's cookie branch all read the session out of the COOKIE JAR. Two disjoint stores.
// Sign-in succeeded, the protected layout's getVerifiedUser() saw nothing, and it redirected
// straight back to /sign-in: a sign-in LOOP in the scaffold's primary flow.
//
// It survived two releases because every control that could have seen it was aimed elsewhere.
// The type-checker was happy — `storage` is legitimately optional, since a pure SPA that
// never server-renders an identity needs none. The unit suite was happy — it tested the cookie
// CODEC with options passed in, never the WIRING that passes them. `knip` was happy, because
// the one dependency whose absence-of-import would have shouted was listed in
// `ignoreDependencies`. And the browser lane was happy because every spec in it is anonymous:
// no test in the repository ever completed a successful sign-in, so nothing ever asked the
// server what the browser had just written.
//
// The lesson generalises, and it is why this is a gate rather than a fix: an OPTIONAL seam
// between two halves that must agree is a seam that will eventually be left unwired, and the
// failure is silent on both sides. Mobile is structurally immune — `createNativeClient`
// takes its storage as a REQUIRED positional — so this closes the same hole on the surface
// where the parameter has to stay optional.
//
// PURE — no fs, no process. Callers read the files and own every exit.
// SOURCE: docs/harness/gates-catalog.md (auth-posture) · apps/web/lib/supabase/client.ts

/** Strip line and block comments so a claim in PROSE is never read as CODE. */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

/**
 * The argument text of the first `name(` CALL in `text`, brace-balanced, or null.
 *
 * `from` lets the caller resume past a match, and the `function`/`declare` skip is what keeps
 * a factory's own DEFINITION out of its census of call sites — `export function
 * createServerSupabaseClient(cookies, options)` is a signature, not a caller that forgot to
 * pass a posture, and reporting it would make the gate fire inside the package it protects.
 */
function callArgs(text, name, from = 0) {
  let at = text.indexOf(`${name}(`, from)
  while (at >= 0 && /\b(?:function|declare)\s+$/.test(text.slice(Math.max(0, at - 24), at))) {
    at = text.indexOf(`${name}(`, at + name.length)
  }
  if (at < 0) return null
  let depth = 0
  for (let i = at + name.length; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return { args: text.slice(at + name.length + 1, i), end: i }
    }
  }
  return null
}

/** Every `name(` call's argument text in `text`, definitions excluded. */
function allCallArgs(text, name) {
  const out = []
  let from = 0
  for (let guard = 0; guard < 50; guard += 1) {
    const hit = callArgs(text, name, from)
    if (hit === null) break
    out.push(hit.args)
    from = hit.end
  }
  return out
}

const SERVER_READER = /createServerSupabaseClient\s*\(|cookieSessionStorage\s*\(/
const BROWSER_FACTORY = 'createBrowserSupabaseClient'
const SERVER_FACTORY = 'createServerSupabaseClient'

/**
 * §1 TRANSPORT AGREEMENT. An app whose SERVER reads sessions from the cookie jar must have a
 * browser client that WRITES to the cookie jar.
 *
 * Stated as one rule about the app rather than two about two files, because that is the shape
 * of the bug: neither half is wrong alone. A browser client defaulting to localStorage is
 * correct for an SPA; a server reading cookies is correct for an SSR host. Only the pairing is
 * the defect, and only a rule that can see both halves at once can say so.
 */
function transportProblems({ app, files }) {
  const readers = files.filter((f) => SERVER_READER.test(code(f.text)))
  if (readers.length === 0) return []
  const constructions = files.flatMap((f) =>
    allCallArgs(code(f.text), BROWSER_FACTORY).map((args) => ({ path: f.path, args })),
  )
  // A cookie-reading server with no browser client at all is legitimate (a server-rendered
  // app with no client-side auth), so silence here is not a finding.
  return constructions
    .filter(({ args }) => !/\bstorage\s*:/.test(args))
    .map(
      ({ path }) =>
        `${path}: ${BROWSER_FACTORY}() is constructed without a \`storage\`, but ${app} reads sessions from the COOKIE JAR (${readers[0]?.path ?? 'a server reader'}). @supabase/supabase-js persists to localStorage when no storage is supplied, and localStorage is never sent with a request — so sign-in succeeds, the server sees no session, and the protected route redirects back to sign-in. That is a sign-in LOOP, and no test that stops short of a successful sign-in can see it. Pass the cookie-backed adapter: \`${BROWSER_FACTORY}({ storage: cookieSessionStorage(jar, { secure }) })\`.`,
    )
}

/**
 * §2 COOKIE ATTRIBUTES ARE NEVER IMPLICIT, at any writer.
 *
 * Every `createServerSupabaseClient` REWRITES the session cookie, so an attribute one writer
 * omits is an attribute it STRIPS from the value another writer set. That is why this asks
 * every call site and not merely one: a posture held at two of three writers is not a posture,
 * it is a race whose loser silently downgrades the cookie on the next request.
 */
function attributeProblems({ files, required }) {
  const problems = []
  for (const f of files) {
    for (const args of allCallArgs(code(f.text), SERVER_FACTORY)) {
      if (!/\bcookieOptions\s*:/.test(args)) {
        problems.push(
          `${f.path}: ${SERVER_FACTORY}() is called without \`cookieOptions\`. This client REWRITES the session cookie, so the attributes it omits are attributes it strips off the value another writer set — a silent downgrade, on every request, for the rest of the session. Pass the reviewed posture (${required.join(', ')}).`,
        )
        continue
      }
      for (const attr of required) {
        if (!new RegExp(String.raw`\b${attr}\s*:`).test(args)) {
          problems.push(
            `${f.path}: ${SERVER_FACTORY}()'s \`cookieOptions\` names no \`${attr}\`, which tools/auth-posture.json requires of every session-cookie writer.`,
          )
        }
      }
    }
  }
  return problems
}

/**
 * §3 A HARDENING CLAIM IN PROSE MUST BE BACKED BY CODE.
 *
 * The anti-vacuity direction, and the one that would have caught this earliest. Four separate
 * comments asserted that apps/web "sets" `httpOnly` — one of them naming the very file that
 * does not — and a comment is exactly the artifact no gate reads. This reads them: a claim
 * that some host SETS an attribute must be matched by a literal `<attr>:` somewhere in the
 * committed source of that same surface. Unavailable-by-construction is a legitimate answer
 * and is declared in the policy, not argued in a comment.
 */
function claimProblems({ files, unavailable }) {
  const problems = []
  const named = new RegExp(String.raw`\b(${unavailable.join('|')})\b`, 'i')
  // NAME IT ONLY TO DISCLAIM IT. Trying to detect the false CLAIM directly does not work —
  // the worst of the four read "apps/web sets both", where "both" is the subject and the
  // attribute is a sentence away, and another was the bare noun phrase "the httpOnly Supabase
  // session cookie" with no verb at all. Any pattern loose enough to catch those is loose
  // enough to catch the honest sentences too. So the rule is inverted and made cheap to
  // satisfy: mentioning an unavailable attribute is fine, and mentioning it WITHOUT saying it
  // is unavailable is the finding. Every truthful comment about it already carries one of
  // these words, because there is no way to describe an attribute you cannot set without
  // saying so.
  const disclaimer =
    /\b(?:unavailable|cannot|can not|never|not available|impossible|ignore[sd]?|absent|unachievable|must move)\b/i
  for (const f of files) {
    for (const c of f.text.match(/(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*)/g) ?? []) {
      const m = named.exec(c)
      if (m === null || disclaimer.test(c)) continue
      problems.push(
        `${f.path}: a comment names \`${m[1]}\` without recording that it is UNAVAILABLE here — "${c
          .replace(/\s+/g, ' ')
          .replace(/^[/*\s]+/, '')
          .slice(
            0,
            140,
          )}…". tools/auth-posture.json lists it under unavailableCookieAttributes: this architecture signs in browser-side, and a user agent IGNORES that attribute on a document.cookie write, so it cannot be set at all. A false hardening claim is worse than a missing one — it is read as a control by everyone who reviews the file, which is exactly how four separate comments asserted this one while every executable check stayed green. Say what the trade is and what mitigates it instead.`,
      )
    }
  }
  return problems
}

/**
 * Judge one surface's session transport.
 *
 * @param {{ app: string, files: {path: string, text: string}[], policy: {requiredCookieAttributes?: string[], unavailableCookieAttributes?: string[]} }} input
 * @returns {string[]}
 */
export function sessionTransportProblems({ app, files, policy }) {
  const required = policy.requiredCookieAttributes ?? []
  const unavailable = policy.unavailableCookieAttributes ?? []
  return [
    ...transportProblems({ app, files }),
    ...attributeProblems({ files, required }),
    ...(unavailable.length === 0 ? [] : claimProblems({ files, unavailable })),
  ]
}
