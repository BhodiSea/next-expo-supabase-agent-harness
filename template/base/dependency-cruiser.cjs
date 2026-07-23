// .dependency-cruiser.cjs (stored dotless; the installer renames it) — the architecture
// law, run as `depcruise apps packages --config .dependency-cruiser.cjs`. The import-GRAPH
// half of the boundary triad; the package.json-DEPENDENCY half (the census consumers) is the
// earlier `boundaries` gate, and the tsc `exports` maps are the third. All three derive their
// list of Metro-safe packages from the ONE census, tools/exports-walls.json.
//
// Path regexes match RESOLVED paths, so `node_modules/<pkg>/` also matches pnpm's
// `.pnpm/<pkg>@<v>/node_modules/<pkg>/` store layout. Rules that must exempt a package's own
// internal (relative) imports use dependency-cruiser's `$1` backreference: a group captured in
// `from.path` is substituted into `to.pathNot`, so "package X may not import a sibling package"
// is expressed without listing every package.

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'Dependency cycles make builds, tests, and reasoning order-dependent.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'verticals-not-into-verticals',
      comment:
        'A feature domain never imports another. Cross-feature code goes through the API; ' +
        'genuinely shared code is lifted into packages/shared. Two verticals importing each ' +
        "other is a distributed monolith with none of a monolith's guarantees.",
      severity: 'error',
      from: { path: '^packages/verticals/([^/]+)/' },
      to: { path: '^packages/verticals/([^/]+)/', pathNot: '^packages/verticals/$1/' },
    },
    {
      name: 'shared-not-into-verticals',
      comment:
        'packages/shared is importable BY verticals, never the reverse — shared code that ' +
        'reaches back into a feature is no longer shared, it is a hidden coupling.',
      severity: 'error',
      from: { path: '^packages/shared/' },
      to: { path: '^packages/verticals/' },
    },
    {
      name: 'platform-imports-kernel-only',
      comment:
        'A platform leaf imports ONLY the foundational kernel — @app/errors, @app/events, ' +
        '@app/env (all import nothing and are needed everywhere) — plus external deps and its ' +
        'own files. A platform package reaching into another (supabase into observability) ' +
        'grows a second dependency spine no layering law can see.',
      severity: 'error',
      from: { path: '^packages/platform/([^/]+)/' },
      to: {
        path: '^packages/',
        pathNot: '^packages/platform/(?:errors|events|env)/|^packages/platform/$1/',
      },
    },
    {
      name: 'api-not-into-next',
      comment:
        'The reversibility wall: packages/api is a framework-neutral tRPC router so it can be ' +
        'promoted to its own apps/api by moving one route.ts. A next/* import welds it to the ' +
        'web app and closes that exit.',
      severity: 'error',
      from: { path: '^packages/api/' },
      to: { path: 'node_modules/next/' },
    },
    {
      name: 'mobile-not-into-web-only',
      comment:
        'apps/mobile paints RN views: it must not import the web design system (@app/design-system, ' +
        'DOM/Radix) or the web renderer (react-dom, next). Metro would resolve a <div> that ' +
        'typechecks and renders nothing on a device.',
      severity: 'error',
      from: { path: '^apps/mobile/' },
      to: { path: '^packages/design-system/|node_modules/(react-dom|next)/' },
    },
    {
      name: 'web-not-into-react-native',
      comment:
        'apps/web paints a DOM tree: it must not import the mobile design system ' +
        '(@app/design-system-native) or react-native. An RN view in a browser typechecks and ' +
        'renders nothing.',
      severity: 'error',
      from: { path: '^apps/web/' },
      to: { path: '^packages/design-system-native/|node_modules/react-native/' },
    },
    {
      name: 'design-system-native-not-into-web',
      comment:
        'The mobile design system shares TOKENS and API SHAPE with the web one, never CODE — ' +
        'Tailwind v3 (NativeWind) and v4 (web) do not share a class vocabulary, and a DOM box ' +
        'model is not an RN one. An import here would drag DOM element types into a Metro bundle.',
      severity: 'error',
      from: { path: '^packages/design-system-native/' },
      to: { path: '^packages/design-system/' },
    },
    {
      name: 'secure-store-host-seam-only',
      comment:
        'expo-secure-store is the credential seam: only apps/mobile/src/host/** may touch it. ' +
        'The auth providers own the credential lifecycle but store through the host seam — a ' +
        'module reading the keychain directly bypasses the single, corrupt-safe door. ESLint ' +
        'catches this at the write; this catches it on the resolved module graph.',
      severity: 'error',
      from: { path: '^apps/mobile', pathNot: '^apps/mobile/src/host/' },
      to: { path: 'node_modules/expo-secure-store/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: {
      path: ['\\.d\\.ts$', '(^|/)dist/', '^apps/mobile/(android|ios)/', '(^|/)\\.expo/'],
    },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
}
