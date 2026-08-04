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
    ignores: ['node_modules/**', 'template/stack/**', 'template/presets/**', '.fixtures/**', 'coverage/**'],
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
    },
  },
]
