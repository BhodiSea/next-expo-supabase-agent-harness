// @app/crypto — THE SERVER/WEB BARREL. Everything on ./client, plus the two
// shipped provider implementations (WebCrypto — Node >= 22 and every evergreen
// browser): the AEAD/HKDF provider and the X25519 provider. A mobile bundle
// must import `@app/crypto/client` and inject its host-built providers
// instead; Metro does not tree-shake, so this barrel's factories would ride
// the native binary reaching for a global Hermes does not have.
export * from './client.js'
export { createWebCryptoProvider } from './webcrypto-provider.js'
export { createWebCryptoX25519Provider } from './webcrypto-x25519.js'
