// jest.setup.ts — RNTL configuration applied before every suite.
//
// asyncUtilTimeout bounds every findBy*/waitFor. The library default is 1000ms,
// calibrated for developer hardware; on a shared-core CI runner that may ALSO
// be hosting an Android emulator and a Metro server (the maestro-smoke canary
// runs the jest lane while both are alive), whole jest-expo suites run 12-16s,
// so a 1s per-assertion bound is contention headroom the runner does not have.
// 10s is headroom, not slack: a genuinely-missing element still fails (slower),
// a present one resolves the instant it appears. (An empty-tree dump showing
// only <RNCSafeAreaProvider /> is NOT this starvation — that is the ambient
// NODE_ENV leak jest.config.js documents and forecloses.)
// SOURCE: docs/harness/gates-catalog.md ("e2e") [corpus: harness/doctrine]
import { configure } from '@testing-library/react-native'

configure({ asyncUtilTimeout: 10_000 })
