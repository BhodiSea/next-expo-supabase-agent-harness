// The `.` barrel. For every other dual-surface package this is where the
// server-only surface is added on top of `./client`; @app/design-tokens has no
// server-only surface — numbers are numbers on both sides of the wire — so this
// file is a pure re-export and MUST stay one.
//
// The key still exists because the export-wall census keys off the pair: a package
// exposing only `.` is one the mobile side may not import at all, and this one it
// certainly may. Collapsing to a single key would make the wall reject the mobile
// design system's own dependency.
//
// The two generated adapters are deliberately NOT re-exported here. They are
// reached at their own subpaths:
//
//   @app/design-tokens/native    the resolved hex theme (React Native)
//   @app/design-tokens/web.css   the Tailwind v4 @theme block (Next)
//
// Keeping them out of the barrel is not tidiness: the adapters re-use the source
// names (`ramps`, `radius`, `typeScale`) with PLATFORM-RESOLVED values — hex
// instead of OKLCH, strings instead of numbers. Flattening both into one barrel
// would give two different things the same name and let a web component import the
// mobile hex by accident, which typechecks perfectly and paints an unthemed color.
export * from './client'
