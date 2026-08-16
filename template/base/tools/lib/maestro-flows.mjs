// tools/lib/maestro-flows.mjs — the ONE builder for generated Maestro YAML. The device
// lane's flow-shaped surfaces that are pure functions of committed data (ROUTES ×
// identity × budgets) are GENERATED at run time by tools/check-e2e-device.mjs /
// tools/gen-maestro-flows.mjs through these builders, never hand-copied N times: a
// route added to src/routes.ts is swept on the next lane run with zero YAML edits, and
// there is no committed copy to drift. Hand-AUTHORED journeys (maestro/journeys/) stay
// files, because their content is judgement (nav paths, seeded-state assumptions), not
// derivation.
//
// Selector doctrine (design record: CI-LANE-FACTS): assertions target the route's
// STYLED Screen-container testID `<id>-screen` — the convention every shipped screen
// follows and the New Architecture does not flatten away. A route whose screen forgot
// the container testID fails its sweep step loudly, which is the correct pressure.
import { deepLink } from './mobile-app-meta.mjs'

/** YAML-quote a scalar defensively (ids/schemes are shell-safe, but never trust). */
const q = (s) => JSON.stringify(String(s))

/**
 * THE ROUTER MUST BE LIVE BEFORE THE FIRST DEEP LINK FIRES. `launchApp` returns when
 * the activity is resumed, not when the JS navigator has mounted, and a VIEW intent
 * delivered in that gap is dropped on the floor — proven twice on the emulator lane
 * (the first mutation-journey dispatch on sign-in; the 1.0.0 release-branch dispatch
 * on the hand-authored security flow, whose openLink reported COMPLETED while the
 * hierarchy showed Home for the whole wait). The sentinel is the INITIAL route's own
 * container testID (path '/', falling back to the first ROUTES entry): it appearing IS
 * "the router is live", in every data state, signed-out included. The sweep was green
 * by accident before this — its first link happened to be the initial route, so a
 * dropped intent was invisible — which is why the guard is emitted, not left to luck.
 * @param {{ id: string, path: string }[]} routes
 * @returns {string[]} the YAML lines of the guard
 */
function routerLiveGuard(routes) {
  const initial = routes.find((route) => route.path === '/') ?? routes[0]
  if (initial === undefined) return []
  return [
    '# the router must be live before a deep link can be delivered (a VIEW intent that',
    '# lands while the navigator is still mounting is dropped — proven on the device lane)',
    '- extendedWaitUntil:',
    '    visible:',
    `        id: ${q(`${initial.id}-screen`)}`,
    '    timeout: 90000',
  ]
}

/**
 * The route sweep: one launch, the router-live guard, then every ROUTES entry opened by
 * deep link and its container asserted. Deliberately does NOT clearState — the
 * i18n/theme phases re-run this sweep over PRE-SEEDED app state, and a clear here would
 * silently undo the seed.
 * @param {{ id: string, path: string }[]} routes
 * @param {{ appId: string, scheme: string }} identity
 * @returns {string}
 */
export function buildSweepYaml(routes, { appId, scheme }) {
  const steps = routes
    .map((route) =>
      [
        `# route '${route.id}' (${route.path})`,
        `- openLink: ${q(deepLink(scheme, route.path))}`,
        '- extendedWaitUntil:',
        '    visible:',
        `        id: ${q(`${route.id}-screen`)}`,
        '    timeout: 30000',
      ].join('\n'),
    )
    .join('\n')
  return [
    '# GENERATED route sweep — do not edit, do not commit (tools/lib/maestro-flows.mjs',
    '# derives it from apps/mobile/src/routes.ts + tools/identity.lock.json on every run).',
    `appId: ${q(appId)}`,
    '---',
    '- launchApp',
    ...routerLiveGuard(routes),
    steps,
    '',
  ].join('\n')
}

/**
 * A per-route flow scaffold for maestro/flows/<id>.yaml — the committed file the
 * mobile-perf closure demands for every ROUTES id. Launch, the router-live guard (see
 * routerLiveGuard — a deep link fired before the navigator mounts is dropped), deep
 * link + container assert; the comment invites replacing the deep link with the real
 * user path. `initialRoute` is the guard's sentinel — the route at path '/' (id 'home'
 * in the shipped ROUTES); the caller passes the real one when it has the table.
 * @param {{ id: string, path: string }} route
 * @param {{ appId: string, scheme: string }} identity
 * @param {{ initialRoute?: { id: string, path: string } }} [options]
 * @returns {string}
 */
export function buildRouteFlowYaml(
  route,
  { appId, scheme },
  { initialRoute = { id: 'home', path: '/' } } = {},
) {
  return [
    `# maestro/flows/${route.id}.yaml — device flow for ROUTES id '${route.id}' (path '${route.path}').`,
    '#',
    '# GENERATED SCAFFOLD (tools/gen-maestro-flows.mjs): opens the route by deep link and',
    '# asserts its styled container testID. Prefer replacing the openLink with the real',
    "# user path (tab tap, header button) once one exists — a flow that walks the app's",
    '# own chrome proves navigation, not just routing. One flow per ROUTES id; the',
    '# mobile-perf --closure gate reds a route without one.',
    `appId: ${q(appId)}`,
    '---',
    '- launchApp',
    ...routerLiveGuard([initialRoute]),
    `- openLink: ${q(deepLink(scheme, route.path))}`,
    '- extendedWaitUntil:',
    '    visible:',
    `        id: ${q(`${route.id}-screen`)}`,
    '    timeout: 30000',
    '',
  ].join('\n')
}

/**
 * The perf-harness journey: deep-link into the dev measurement screen with the caps
 * from tools/interaction-budget.json riding the query string, then wait for the
 * self-measured `perf-pass` leaf marker. The timeout is generous — the screen runs
 * `runs` iterations of two latency probes plus a frame window before it verdicts.
 * @param {{ appId: string, scheme: string }} identity
 * @param {{ tabSwitchMs: number, actionsOpenMs: number, frameDropMax: number, runs: number }} budgets
 * @returns {string}
 */
export function buildPerfHarnessYaml({ appId }, budgets) {
  void budgets // budgets travel in the URL (perfHarnessUrl); the YAML only asserts
  return [
    '# GENERATED perf-harness journey — do not edit, do not commit',
    '# (tools/lib/maestro-flows.mjs derives it from tools/interaction-budget.json).',
    '# NO openLink here: this is the one deep link that carries a QUERY STRING, and',
    "# Maestro's openLink passes the URL through the device shell unquoted — it splits",
    "# at the first '&' and the intent never fires (proven live: the link reported",
    '# COMPLETED while the hierarchy showed Home, zero navigation). The RUNNER',
    '# (check-e2e-device --phase perf-harness) delivers the link via `adb shell am',
    '# start` with device-shell single quotes BEFORE this journey runs; plain-path',
    '# links elsewhere stay on openLink, which handles them fine.',
    `appId: ${q(appId)}`,
    '---',
    '- extendedWaitUntil:',
    '    visible:',
    '        id: "perf-harness-screen"',
    '    timeout: 30000',
    '# The marker IS the verdict: the screen self-measures against the budgets above and',
    '# renders perf-pass only when every cap held (perf-fail + per-metric lines otherwise).',
    '- extendedWaitUntil:',
    '    visible:',
    '        id: "perf-pass"',
    '    timeout: 120000',
    '',
  ].join('\n')
}

/**
 * The perf-harness deep link, budgets as query params. Delivered by the RUNNER
 * via `adb shell am start` (never Maestro openLink — see buildPerfHarnessYaml).
 * @param {{ scheme: string }} identity
 * @param {{ tabSwitchMs: number, actionsOpenMs: number, frameDropMax: number, runs: number }} budgets
 * @returns {string}
 */
export function perfHarnessUrl({ scheme }, budgets) {
  const params = [
    `tabSwitchMs=${String(budgets.tabSwitchMs)}`,
    `actionsOpenMs=${String(budgets.actionsOpenMs)}`,
    `frameDropMax=${String(budgets.frameDropMax)}`,
    `runs=${String(budgets.runs)}`,
  ].join('&')
  return `${deepLink(scheme, '/perf-harness')}?${params}`
}

/**
 * Interaction budgets from tools/interaction-budget.json, validated fail-closed: a
 * malformed budget file must red the lane, never relax it (the file is the reviewed
 * cap surface — see its own doctrine comment).
 * @param {unknown} raw parsed JSON of tools/interaction-budget.json
 * @returns {{ tabSwitchMs: number, actionsOpenMs: number, frameDropMax: number, runs: number }}
 */
export function budgetsFromInteractionFile(raw) {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('tools/interaction-budget.json is not an object')
  }
  const data = /** @type {Record<string, unknown>} */ (raw)
  const medianOf = (key) => {
    const entry = data[key]
    const value =
      entry !== null && typeof entry === 'object'
        ? /** @type {Record<string, unknown>} */ (entry)['median']
        : undefined
    if (typeof value !== 'number' || !(value > 0)) {
      throw new Error(`tools/interaction-budget.json ${key}.median must be a positive number`)
    }
    return value
  }
  const plain = (key) => {
    const value = data[key]
    if (typeof value !== 'number' || !(value > 0)) {
      throw new Error(`tools/interaction-budget.json ${key} must be a positive number`)
    }
    return value
  }
  return {
    tabSwitchMs: medianOf('tabSwitchMs'),
    actionsOpenMs: medianOf('actionsOpenMs'),
    frameDropMax: plain('listScrollFrameDropMax'),
    runs: plain('runs'),
  }
}
