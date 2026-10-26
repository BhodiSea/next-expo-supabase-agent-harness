// Execution-environment probe — the one place the app asks WHERE it is
// running. expo-constants' executionEnvironment separates a store binary
// ('standalone') from Expo Go ('storeClient'); __DEV__ is the bundler's
// dev/release switch. Consumers branch on this probe, never on scattered
// Constants reads (a second copy is how dev-only surfaces leak into release).
import Constants, { ExecutionEnvironment } from 'expo-constants'

export interface HostEnvironment {
  readonly executionEnvironment: ExecutionEnvironment
  /** Metro dev bundle (true) vs release bundle (false). */
  readonly isDev: boolean
}

export function hostEnvironment(): HostEnvironment {
  return {
    executionEnvironment: Constants.executionEnvironment,
    isDev: __DEV__,
  }
}
