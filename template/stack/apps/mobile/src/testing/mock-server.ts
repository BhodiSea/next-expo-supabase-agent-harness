// __DEV__-only fetch interceptor — the network seam for component tests and the
// future Maestro fast lane (route handlers instead of a live server). The
// api-client one-door is the ONLY caller of fetch in this app, so wrapping
// global fetch here mocks the entire network surface in one move while the real
// api-client code (origin resolution, bearer attachment, envelope decoding)
// still runs — the seam under test stays the shipped seam.
//
// Handlers are keyed "METHOD /path". An UNMATCHED request throws instead of
// falling through to the real network: a test that silently reached a live
// server would be nondeterministic exactly when it matters.

interface MockResponse {
  readonly status: number
  readonly body: unknown
}

export type MockRouteHandler = (request: {
  readonly url: string
  /** The request body as text, or null when absent/non-string. */
  readonly body: string | null
}) => MockResponse | Promise<MockResponse>

// `installed` is tracked separately from originalFetch: a jest environment may
// have NO global fetch at all (originalFetch legitimately undefined), and the
// install/uninstall discipline must still hold.
let installed = false
let originalFetch: typeof globalThis.fetch | undefined = undefined
let routes: ReadonlyMap<string, MockRouteHandler> | null = null

function toResponse(result: MockResponse): Response {
  const payload = JSON.stringify(result.body)
  if (typeof Response === 'function') {
    return new Response(payload, {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    })
  }
  // Older jsdom-era jest environments consume fetch results without shipping
  // the constructors — a minimal duck type covers what api-client touches.
  const duck = {
    ok: result.status >= 200 && result.status < 300,
    status: result.status,
    json: () => Promise.resolve(JSON.parse(payload) as unknown),
    text: () => Promise.resolve(payload),
  }
  return duck as unknown as Response
}

function requestKey(input: RequestInfo | URL, init?: RequestInit): { key: string; url: string } {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const method = (
    init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')
  ).toUpperCase()
  const path = url.replace(/^[a-z][\w+.-]*:\/\/[^/]*/i, '')
  return { key: `${method} ${path}`, url }
}

export function installMockServer(handlers: Readonly<Record<string, MockRouteHandler>>): void {
  if (!__DEV__) {
    // Shipping an interceptor that can rewrite every API response is a
    // man-in-the-middle primitive, not a test utility.
    throw new Error('mock server is a dev/test seam only')
  }
  if (installed) throw new Error('mock server already installed — uninstall first')
  installed = true
  originalFetch = globalThis.fetch
  routes = new Map(Object.entries(handlers))
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const { key, url } = requestKey(input, init)
    const handler = routes?.get(key)
    if (handler === undefined) {
      throw new Error(`mock server: unhandled ${key} (${url})`)
    }
    const body = typeof init?.body === 'string' ? init.body : null
    return toResponse(await handler({ url, body }))
  }
}

export function uninstallMockServer(): void {
  if (installed) {
    // Restore exactly what was there — including "nothing": jest environments
    // without a global fetch get their absence back, so the write goes through a
    // fetch-optional view of globalThis instead of a non-null assertion.
    const host = globalThis as { fetch?: typeof globalThis.fetch | undefined }
    host.fetch = originalFetch
    originalFetch = undefined
    installed = false
  }
  routes = null
}
