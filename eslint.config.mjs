// eslint.config.mjs — the machinery under its own bar (v0.1.5).
// The harness enforces strictTypeChecked + sonarjs/cognitive-complexity <= 15 +
// knip --strict on every consumer; this config holds the enforcement machinery
// itself (installer/, scripts/, tests/, and the shipped gate scripts + hooks —
// linted AS REPO SOURCE, zero consumer surface) to the same complexity bar.
// Ratchet discipline. A NEW over-budget function reds CI here (no directive, so the
// rule fires), and reportUnusedDisableDirectives reds a directive whose function has
// dropped back under the bar. What ESLint ALONE cannot do is bound a function that is
// already disabled: the directive suppresses the rule outright, so a ratcheted function
// could grow without limit and this config stayed green. That ceiling is enforced by
// `scripts/check-complexity-ratchet.mjs` (G16, blocking in machinery-lint), which re-lints
// with --no-inline-config to read every real score and compares it against the committed
// `scripts/complexity-ratchet.json`. The two controls are complementary; neither is enough.
import js from '@eslint/js'
import sonarjs from 'eslint-plugin-sonarjs'
import globals from 'globals'

export default [
  {
    // template/stack/** is consumer app surface (TS app code) — the CONSUMER
    // eslint config (template/base/eslint.config.mjs, strictTypeChecked) owns
    // that tree. Everything else that parses as JS in this repo is machinery.
    // '.selftest/**' is the upgrade lane's workdir: a rendered scaffold whose tools/ is the
    // template's own code, already linted at its source. Without it, running the lane makes
    // `eslint .` — and so the complexity ratchet — report the SCAFFOLD's functions as new
    // factory findings, which is a red that depends on whether you happened to run a lane.
    ignores: ['node_modules/**', 'template/stack/**', 'template/presets/**', '.fixtures/**', '.selftest/**', 'coverage/**'],
  },
  {
    files: ['**/*.mjs', '**/*.js', '**/*.cjs'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error', // a stale ratchet comment is itself red
    },
    plugins: { sonarjs },
    rules: {
      ...js.configs.recommended.rules,
      // Same budget the consumer config enforces (BUILD-SPEC §Lint).
      'sonarjs/cognitive-complexity': ['error', 15],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // 0.8.0: no RAW-PATH specifier inside import() in the machinery. On Windows,
      // `import(fileURLToPath(...))` / `import(join(...))` hands the ESM loader a bare
      // `D:\…` path, whose drive letter reads as a protocol — ERR_UNSUPPORTED_ESM_URL_SCHEME
      // — and it broke a red-proof on windows-latest once (the check-query-shapes.test.mjs
      // header records the incident). The rule bans exactly the broken shape (the DIRECT
      // argument), not the safe one: `import(pathToFileURL(...).href)` is the correct form
      // for the imports that are GENUINELY runtime-computed (a fixture dir minted by
      // mkdtemp, a consumer tree a shipped gate walks) and stays legal. Where the target is
      // statically known, prefer a static relative specifier — `knip --strict` can see it —
      // which the 0.8.0 sweep applied to the last five convertible test files.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "ImportExpression > CallExpression[callee.name='fileURLToPath'], ImportExpression > CallExpression[callee.name='join'], ImportExpression > CallExpression[callee.name='resolve']",
          message:
            'import() of a raw filesystem path is ERR_UNSUPPORTED_ESM_URL_SCHEME on a Windows drive path — wrap it (`pathToFileURL(p).href`), or use a static relative specifier when the target is fixed.',
        },
      ],
    },
  },
]
