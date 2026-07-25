# W1 — the stack tree contract

The design record for replacing `template/stack/**` (inherited: Expo + Hono +
Drizzle/Postgres) with this lineage's own tree: **Next.js 16 web + Expo mobile
over one shared Supabase backend**.

This file is the contract every W1 change is written against. Package names,
export shapes, dependency directions, and catalog pins are fixed HERE so that
independently-authored subtrees compose without reconciliation.

## 1. Workspace topology

```
apps/
  web/                    Next 16 · App Router · Vercel · SERVES the API
  mobile/                 Expo 57 · expo-router · EAS
packages/
  api/                    @app/api          tRPC v11 router — NO next/* imports
  contracts/              @app/contracts    pure zod DTOs + generated inventories
  verticals/
    notes/                @app/notes        the seeded reference vertical
  shared/                 (empty at seed — cross-vertical domains land here)
  platform/
    errors/               @app/errors       AppError · ActionOutcome · toOutcome  ── kernel
    events/               @app/events       event registry                        ── kernel
    env/                  @app/env          parsed, typed environment
    supabase/             @app/supabase     the five client factories
    observability/        @app/observability
  design-tokens/          @app/design-tokens        framework-neutral TS tokens (SINGLE SOURCE)
  design-system/          @app/design-system        web · Tailwind v4 + Radix
  design-system-native/   @app/design-system-native mobile · NativeWind
  config/
    tsconfig/             @app/tsconfig
    eslint-plugin/        @app/eslint-plugin
supabase/                 config.toml · schemas · migrations · seed.sql · tests · functions
```

Apps are bare names (`web`, `mobile`); every package is `@app/*`. Both
conventions are inherited and MUST NOT change — `knip.json`, the tsconfig
solution references, and the dependency-cruiser rules all key off them.

## 2. Layering law

Import direction, enforced three times (`exports` walls → workspace manifests →
dependency-cruiser). Higher may import lower; never the reverse.

```
apps  →  api  →  verticals  →  shared  →  platform  →  { errors, events }
                                                          (the kernel: imports nothing)
design-system / design-system-native  →  design-tokens   (tokens only, never each other)
```

Additional walls:

- `packages/api` MUST NOT import `next/*`. This is the **reversibility wall**:
  it is what keeps promoting the router to a standalone `apps/api` a routing
  change rather than a rewrite.
- `apps/mobile` MUST NOT import `react-dom`, `next/*`, or any package's `.`
  barrel that is not on the `./client` census (§4).
- `apps/web` MUST NOT import `react-native*`.
- `design-system-native` MUST NOT import `design-system` (no shared component
  layer — see §5).

## 3. The backend seam

`@app/api` is a framework-neutral tRPC v11 router:

- **`apps/web`** takes it as a **production dependency** and mounts it at
  `app/api/trpc/[trpc]/route.ts`. Web's own mutations use Server Actions that
  call the same package barrels — one implementation per operation, two callers.
- **`apps/mobile`** takes it as a **devDependency**, imported **`import type`
  only**. Metro does not tree-shake: a value import or a prod dep drags the
  server graph (service-role clients, Next-coupled leaves) into the native
  binary. `apps/mobile/src/lib/trpc/client.ts` carries the `IsAny<AppRouter>`
  compile-time assertion so a silent `any` degradation of the router type — the
  standard monorepo tRPC failure — reds at typecheck.

Procedure ladder: `publicProcedure` → `authedProcedure` → `memberProcedure`.
No transformer; every payload is JSON-safe by construction.

**The envelope rule.** Procedures return the serializable `ActionOutcome` from
`@app/errors` on the **data** channel. A domain failure is NEVER a thrown
`TRPCError` — throwing flattens the `AppError` discriminant the screens switch
on. Only the auth middleware throws (transport-level `UNAUTHORIZED`), which the
mobile normalize layer folds back into `appError.unauthorized()`.

## 4. The dual-barrel `exports` contract

The single mechanism that lets a Next surface and an Expo surface share a
package with **no build step** (Next `transpilePackages`, Metro's Expo-SDK
monorepo resolution):

```jsonc
"exports": {
  ".":        "./src/index.ts",   // server barrel: "use server", service-role, Next-coupled leaves
  "./client": "./src/client.ts"   // Metro-safe: pure domain + zod + direct reads
}
```

`index.ts` re-exports `client.ts` and adds the server-only surface. Not every
package gets `./client`; packages handling elevated writes are hardened to the
single `"."` key.

**The census lives in exactly one place: `tools/exports-walls.json`.** In
`saltriders_v2` this list is copy-pasted three times (the exports-walls script
and two dependency-cruiser regexes); they will drift and the weakest wins. All
three consumers here derive from the one file. It is classified **`owned`**, not
`seeded` — it can *disable* a check, so `fileMode()` must hash-pin it.

## 5. Design tokens

`@app/design-tokens` is a framework-neutral TypeScript module and is the single
source. It generates the web theme and the native theme; both generated outputs
are committed and regen-diffed.

Two structural constraints, both verified against `saltriders_v2`:

- **The Tailwind split is real.** Web is Tailwind v4 (CSS-first `@theme`, no
  config file); mobile is pinned to Tailwind v3 because NativeWind 4 requires
  it. A shared `tailwind.config` or shared CSS token file CANNOT work.
- **No shared React component layer.** `design-system` (DOM/Radix) and
  `design-system-native` (RN views) share tokens and icon paths only. Do not
  scaffold a "universal component" package.

Token flow is **TS → both** (inverted from `saltriders_v2`, where `tokens.ts` is
derived from `app.css` and the test asserts the mirror). The drift test is
therefore rewritten, not copied.

## 6. Catalog policy — one React

`react`/`react-dom` stay at a **single catalog pin, `19.2.3`, for both
surfaces**. Verified: Expo 57's `bundledNativeModules` requires exactly 19.2.3
(`expo install --check` reds drift), and Next 16 requires `^19.2.0`, which
19.2.3 satisfies. `saltriders_v2` runs 19.2.7 on web only because that was
latest at install time, not because Next needs it.

This keeps `pnpm-workspace.yaml`'s stated doctrine — *"version drift between
workspaces is structurally impossible"* — literally true, rather than carving
out an exemption that makes the header a lie.

**Accepted cost, stated explicitly:** Next's React floor now gates the Expo SDK
upgrade cadence in both directions. A future Next major that demands a React
version Expo has not yet bundled forces a real decision (hold the upgrade, or
split the pin and amend the doctrine) rather than a silent divergence.

`version-sync` **now carries** a single-React-instance assertion (W8), modelled on
the existing single-zod check but **scoped per surface**: it reds only when one
workspace project's own graph resolves more than one `react`. That scoping is
deliberate — it verifies the single pin *today* (every project resolves 19.2.3, so
it is trivially green) while leaving the escape hatch above genuinely open: should a
future Next major ever outgrow Expo's bundled React, splitting the pin becomes a
catalog-only change, because two Reacts *across* independent bundles is already
tolerated and only two *within* one bundle red. Two React copies in one bundle break
the hooks dispatcher for any package rendering on that surface; before W8, nothing
noticed. (This closes landmine 2's real concern — an undetected dual React — without
the gratuitous divergence a pin split would have introduced under the current facts.)

## 7. Catalog changes

**Removed** (the self-hosted server half leaves with `apps/server`):
`hono`, `@hono/node-server`, `@hono/zod-openapi`, `pino`, `pino-pretty`,
`postgres`, `drizzle-orm`, `drizzle-zod`, `drizzle-kit`, `expo-auth-session`,
`expo-sqlite`.

**Added** (web + shared backend):
`next`, `@supabase/supabase-js`, `@supabase/ssr`, `@trpc/server`,
`@trpc/client`, `@tanstack/react-query`, `next-safe-action`, `tailwindcss` (v4,
web) and `tailwindcss` v3 + `nativewind` + `react-native-css-interop` (mobile,
per-app pins — this is the ONE place two majors legitimately coexist, §5),
`@radix-ui/*`, `class-variance-authority`, `clsx`, `tailwind-merge`,
`@react-native-async-storage/async-storage`, `aes-js`, `supabase` (CLI).

**Retained unchanged:** the whole toolchain block, the test block, and the
Expo 57 line.

## 8. Placeholders

Registry closure is **bidirectional** (`scripts/hygiene.mjs`): every declared
token must be used somewhere under `template/`, and vice versa. Changes:

| token | change | why |
|---|---|---|
| `API_ORIGIN` | **renamed** → `WEB_ORIGIN` | mobile now talks to the web app's origin, which is also the cookie/CORS origin |
| `DB_NAME` | **removed** | no self-hosted Postgres; the local stack is `supabase start` |
| `SUPABASE_PROJECT_REF` | **added** | committed in `supabase/config.toml` and the CI type-drift lane |

Retained: `PROJECT_NAME`, `PROJECT_SLUG`, `APP_IDENTIFIER`, `APP_SCHEME`,
`GITHUB_OWNER`, `SECURITY_OWNERS`, `DEFAULT_BRANCH`, `EAS_PROJECT_ID`,
`ASC_APP_ID`, `APPLE_TEAM_ID`.

## 9. What W1 does NOT deliver

W1 lands the tree and the installer's knowledge of it. The base gates that read
stack *internals* are rewritten in their own waves, and until then they self-skip
loudly against the missing surface — which is the designed behaviour
(`skipOrFail`: loud local skip, fail-closed in CI), never a silent pass:

- `schema-rls`, `migrations`, `types-drift` → **W3**
- `boundaries` (exports walls, workspace-deps, depcruise layering) → **W4**
- `contracts`, `parity` → **W5**
- `tokens`, `styleguide` → **W6**

A scaffold produced at the end of W1 must `pnpm install` and `tsc -b` cleanly.
It is NOT expected to pass the full 21-gate chain until W6.

## 10. Hygiene — arming is sequenced LAST, not here

The original plan armed `/\bhono\b/i` and `/drizzle/i` in this wave. **Measured
during W1, that is not possible.** 65 files under `template/` still carry that
vocabulary:

- **54 under `base/`** — the subagent roster (`dal-author`,
  `migration-rls-author`, `security-reviewer`, `torvalds-reviewer`), the
  `.claude` rules and the vertical-slice skill, `dependency-cruiser.cjs`,
  `eslint.config.mjs`, `knip.json`, the `schema-rls` / `migrations` /
  `contracts` / `build` / `version-sync` gates, the `tests/rls` harness, the
  provenance corpus index, and three CI workflows.
- **11 under `modules/`** — `observability`, `push-notifications`,
  `crash-reporting`.

Each is retargeted by a later wave (W3 schema, W4 boundaries, W5 contracts,
W8 CI, W9 agent layer). Arming the detectors now would either red the repo for
the entire build-out or force all 65 rewrites into one unreviewable change.

**Therefore:** arming moves to the final closure wave, once every consumer has
been retargeted. The deferral is recorded at the call site in
`scripts/hygiene.mjs` with this same reasoning.

**Accepted risk, stated plainly:** during the build-out window nothing
mechanically prevents sibling vocabulary from re-entering `template/`. The
closure wave both arms the detectors and, by arming them, retroactively proves
the window stayed clean.
