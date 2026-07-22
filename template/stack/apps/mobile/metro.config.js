// metro.config.js — the unmodified expo/metro-config default. SDK 54+ has
// built-in monorepo support (workspace-root watching + isolated pnpm store
// resolution), so no node-linker=hoisted, no manual watchFolders, no custom
// resolver (design record: EXPO-FACTS). Extend this object if a future module
// needs to — never replace the default wholesale.
const { getDefaultConfig } = require('expo/metro-config')

module.exports = getDefaultConfig(__dirname)
