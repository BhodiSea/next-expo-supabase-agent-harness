// Tailwind v4 is a PostCSS plugin and nothing else: there is no tailwind.config.js in a
// v4 CSS-first setup — the theme is declared in CSS (app/globals.css `@theme`, fed by the
// generated token sheet from @app/design-tokens). Do not add a config file back; the
// tokens gate regen-diffs the generated sheet, and a second theme source would let the two
// drift silently.
//
// Web is Tailwind v4; apps/mobile is pinned to Tailwind v3 because NativeWind 4 requires
// it. That split is deliberate and permanent — a shared tailwind config or a shared CSS
// token file CANNOT work across the two majors, which is exactly why the SINGLE source of
// truth is the framework-neutral TypeScript module in @app/design-tokens rather than any
// CSS artifact.
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
}

export default config
