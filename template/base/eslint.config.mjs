// eslint.config.mjs — the single lint owner (Biome is formatter/organizer only).
// typescript-eslint strictTypeChecked + stylisticTypeChecked via projectService,
// react-hooks (including the merged React Compiler rule set) scoped to the Expo
// app, eslint-plugin-react-native + eslint-plugin-react-native-a11y with EVERY
// rule at error (the a11y floor is lint + component tests on this host — there is
// no browser axe sweep in the chain), sonarjs cognitive-complexity <= 15, plus
// the boundary bans: global fetch outside the api-client one-door,
// expo-secure-store outside the host/auth keychain seam, chart libraries in the
// dense features. Runs as `eslint . --max-warnings 0`.
import reactHooks from 'eslint-plugin-react-hooks'
import reactNative from 'eslint-plugin-react-native'
import reactNativeA11y from 'eslint-plugin-react-native-a11y'
import sonarjs from 'eslint-plugin-sonarjs'
import tseslint from 'typescript-eslint'
// The harness's four custom rules (tools/eslint-rules/index.mjs) — plain rules keyed on
// JS/TS-shared syntax nodes, scoped by the blocks at the bottom of this config.
import localRules from './tools/eslint-rules/index.mjs'

// Every rule the plugin ships, at error severity. Derived from the plugin's own
// rule table ON PURPOSE: a plugin upgrade that adds a rule arms it here
// automatically — the floor grows with the plugin instead of freezing at the
// rule list somebody once copied. Deliberate exceptions are declared explicitly
// AFTER the spread, where the override is visible and reviewable.
const allRulesError = (prefix, plugin) =>
  Object.fromEntries(Object.keys(plugin.rules).map((name) => [`${prefix}/${name}`, 'error']))

export default tseslint.config(
  {
    // Build outputs, generated code, and non-app surfaces owned by other gates.
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      '**/.expo/**',
      'apps/mobile/android/**', // CNG prebuild output — generated, never committed
      'apps/mobile/ios/**', // CNG prebuild output — generated, never committed
      'apps/mobile/src/theme/tokens.gen.ts', // emitted by tools/gen-theme.mjs; regen-diff-gated, not linted
      'packages/platform/supabase/src/database.types.ts', // `supabase gen types` output; types-drift-gated
      'tools/**', // gate scripts (incl. the custom-rules plugin): plain node, guarded by the harness itself
      'tests/**', // root-level RLS runner surface (gates wave)
      'supabase/**', // SQL migrations/schemas/seed — owned by the schema-rls + migrations gates
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        // projectService discovers each workspace tsconfig; root-level config files
        // (vitest.config.ts) belong to no project and use the default project.
        projectService: {
          allowDefaultProject: ['*.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error', // a stale suppression is itself a lint error
    },
    plugins: { sonarjs },
    rules: {
      // SOURCE: docs/harness/README.md (cognitive-complexity 15 error, replaces blanket max-lines) [corpus: harness/doctrine]
      'sonarjs/cognitive-complexity': ['error', 15],
      // The underscore convention: a `_`-prefixed binding is a DECLARED unused
      // (a positional arg a callback must accept, a destructure hole). Anything
      // unprefixed stays an error — this narrows the rule, it does not disable it.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // Expo app: hooks + React Compiler rules, react-native + react-native-a11y —
    // every rule fatal. The a11y rules are the static half of the accessibility
    // floor; the RNTL role/label assertions in __tests__/ are the behavioral half.
    files: ['apps/mobile/**/*.ts', 'apps/mobile/**/*.tsx'],
    extends: [reactHooks.configs.flat.recommended],
    plugins: { 'react-native': reactNative, 'react-native-a11y': reactNativeA11y },
    rules: {
      ...allRulesError('react-native', reactNative),
      ...allRulesError('react-native-a11y', reactNativeA11y),
      // recommended ships this as a warning; --max-warnings 0 makes warns fatal anyway,
      // so declare the real severity instead of tripping the warning budget.
      'react-hooks/exhaustive-deps': 'error',
      // Raw text renders through the AppText primitive (which wraps RN Text with
      // the token type scale) — so AppText children are the sanctioned raw-text home.
      'react-native/no-raw-text': ['error', { skip: ['AppText'] }],
      // Logging goes through the src/lib/log.ts seam (level-gated, sink-swappable
      // for crash reporting) — a bare console call bypasses both.
      'no-console': 'error',
    },
  },
  {
    // The log seam itself: the one module that may touch the console sink.
    files: ['apps/mobile/src/lib/log.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // THE one door to the API (src/lib/api-client.ts): apiFetch/apiPost attach the
    // bearer token and decode the error envelope. A direct global fetch() call is a
    // request that 401s against the real server while every unit test mocks the
    // network — nothing local would tell you. The door module itself is the only
    // carve-out; injected transports (expo/fetch in src/lib/sse.ts) are imported
    // bindings, not the restricted global, and still route through apiFetch.
    // SOURCE: docs/harness/README.md (api-client one-door) [corpus: harness/doctrine]
    files: ['apps/mobile/**/*.ts', 'apps/mobile/**/*.tsx'],
    ignores: ['apps/mobile/src/lib/api-client.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message:
            'Call the API through src/lib/api-client.ts (apiFetch/apiPost) — it attaches the bearer token and decodes the error envelope. A bare fetch() ships unauthenticated.',
        },
      ],
    },
  },
  {
    // The platform keychain has ONE door: src/host/** (the SecureStore seam).
    // The auth providers own the credential LIFECYCLE but store through the
    // host seam's AccessTokenProvider — they never import expo-secure-store
    // themselves (a W8 audit found this exemption listed src/auth/** too while
    // every doctrine surface and the write-guard hook said host-only; the code
    // agreed with the doctrine, so the exemption tightened to match). depcruise
    // enforces the same wall on the resolved module graph — lint catches it at
    // the write, architecture at validate.
    // The haptics engine has ONE door too: src/lib/haptics.ts (the closed
    // selection/success/warning vocabulary), and svg primitives a third:
    // src/components/icons (the closed glyph set) — the seams share this
    // block, so each seam file is exempt from the others' bans only through
    // the module-graph rules depcruise owns.
    files: ['apps/mobile/**/*.ts', 'apps/mobile/**/*.tsx'],
    // haptics.test.ts sits beside the seam: proving the engine mapping requires
    // mocking the engine, which requires importing it.
    ignores: [
      'apps/mobile/src/host/**',
      'apps/mobile/src/lib/haptics.ts',
      'apps/mobile/src/lib/haptics.test.ts',
      'apps/mobile/src/components/icons/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['expo-secure-store', 'expo-secure-store/*'],
              message:
                'The keychain has one door: import the secure* helpers from src/host (or go through src/auth providers). Direct expo-secure-store use bypasses the corrupt-safe seam.',
            },
            {
              group: ['expo-haptics', 'expo-haptics/*'],
              message:
                'Haptics have one door: call haptic() from src/lib/haptics.ts — the closed selection/success/warning vocabulary keeps tactile feedback consistent app-wide.',
            },
            {
              group: ['react-native-svg', 'react-native-svg/*'],
              message:
                'Svg primitives have one door: render a named glyph through src/components/icons/Icon.tsx — the closed set keeps iconography one idiom; new glyphs are added there in review.',
            },
          ],
        },
      ],
    },
  },
  {
    // The dense matrix feature draws its own cells (FlatList + token styles) for
    // performance and accessibility-tree control; charting libraries are banned
    // there. This block is LAST so it also restates the secure-store ban — later
    // flat-config blocks replace rule entries wholesale.
    files: ['apps/mobile/src/features/matrix/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'victory-native',
                'react-native-chart-kit',
                'react-native-svg-charts',
                'recharts',
                'recharts/*',
                'd3-*',
                '@nivo/*',
              ],
              message:
                'matrix draws its own rows/cells (FlatList + token styles); chart libraries are banned here.',
            },
            {
              group: ['expo-secure-store', 'expo-secure-store/*'],
              message:
                'The keychain has one door: import the secure* helpers from src/host (or go through src/auth providers). Direct expo-secure-store use bypasses the corrupt-safe seam.',
            },
            {
              group: ['expo-haptics', 'expo-haptics/*'],
              message:
                'Haptics have one door: call haptic() from src/lib/haptics.ts — the closed selection/success/warning vocabulary keeps tactile feedback consistent app-wide.',
            },
            {
              group: ['react-native-svg', 'react-native-svg/*'],
              message:
                'Svg primitives have one door: render a named glyph through src/components/icons/Icon.tsx — the closed set keeps iconography one idiom; new glyphs are added there in review.',
            },
          ],
        },
      ],
    },
  },
  {
    // app-error-only — the lint half of the single-error-channel doctrine. Scoped to the
    // enveloped surfaces (web Server Actions, tRPC procedures, the vertical DAL) where a domain
    // failure MUST be a returned outcomeErr, never a thrown error. trpc.ts (the two sanctioned
    // transport throws) and tests (which throw by design) are outside these globs.
    files: [
      'apps/web/app/actions/**/*.ts',
      'packages/api/src/routers/**/*.ts',
      'packages/verticals/**/src/data/**/*.ts',
    ],
    ignores: ['**/*.test.ts'],
    plugins: { local: localRules },
    rules: { 'local/app-error-only': 'error' },
  },
  {
    // no-module-scope-supabase — a Supabase client is created per request inside the handler,
    // never at module load. Scoped to the CONSUMER surfaces (the factory package itself builds
    // clients inside factory functions, which the rule does not flag).
    files: ['apps/**/*.ts', 'apps/**/*.tsx', 'packages/verticals/**/*.ts'],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    plugins: { local: localRules },
    rules: { 'local/no-module-scope-supabase': 'error' },
  },
  {
    // ui-copy-voice — user-facing copy hygiene over the i18n catalog (the message sources).
    // Logic modules (index, i18n, polyfills) and the pseudo-locale generator carry no copy.
    files: ['apps/*/src/i18n/**/*.ts'],
    ignores: [
      'apps/*/src/i18n/index.ts',
      'apps/*/src/i18n/i18n.ts',
      'apps/*/src/i18n/polyfills.ts',
      'apps/*/src/i18n/pseudo.ts',
      '**/*.test.ts',
    ],
    plugins: { local: localRules },
    rules: { 'local/ui-copy-voice': 'error' },
  },
  {
    // zod-schema-module-scope — schemas are built once at module scope, never rebuilt per call.
    // The module-scope `export const X = z.object(...)` shape does not fire; only a z.<builder>
    // inside a function does.
    files: ['packages/contracts/**/*.ts', 'packages/verticals/**/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    plugins: { local: localRules },
    rules: { 'local/zod-schema-module-scope': 'error' },
  },
)
