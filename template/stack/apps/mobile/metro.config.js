// metro.config.js — the expo/metro-config default plus ONE resolver shim. SDK
// 54+ has built-in monorepo support (workspace-root watching + isolated pnpm
// store resolution), so no node-linker=hoisted, no manual watchFolders (design
// record: EXPO-FACTS).
//
// The shim: the workspace packages this app consumes are `moduleResolution:
// "NodeNext"` (they also run server-side under Node and build with `tsc -b`),
// so their relative imports carry explicit `.js` extensions that map to a `.ts`
// source on disk. Metro does NOT rewrite `.js`→`.ts`, so a barrel like
// `@app/supabase/client` (`export … from './access-token.js'`) is unresolvable
// under the bare default and `expo export` fails. The resolver below tries the
// specifier as written FIRST (a genuine `.js` on disk still wins), and only on
// failure retries without the extension so Metro's sourceExts find the `.ts`.
// Scoped to relative specifiers — bare/package specifiers are untouched.
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if ((moduleName.startsWith('./') || moduleName.startsWith('../')) && moduleName.endsWith('.js')) {
    try {
      return context.resolveRequest(context, moduleName, platform)
    } catch {
      return context.resolveRequest(context, moduleName.slice(0, -3), platform)
    }
  }
  return context.resolveRequest(context, moduleName, platform)
}

module.exports = config
