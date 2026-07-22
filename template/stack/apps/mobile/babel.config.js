// babel.config.js — babel-preset-expo, unmodified. Metro (app bundles) and
// jest-expo (component tests) both read this file. The React Compiler is
// enabled via app.config.ts `experiments.reactCompiler`, which the preset picks
// up through the Expo CLI — no extra plugin wiring belongs here.
module.exports = (api) => {
  api.cache(true)
  return { presets: ['babel-preset-expo'] }
}
