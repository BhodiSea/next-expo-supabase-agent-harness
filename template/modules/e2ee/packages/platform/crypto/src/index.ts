// @app/crypto — THE SERVER/WEB BARREL. Everything on ./client, plus the one
// shipped CryptoProvider implementation (WebCrypto — Node >= 22 and every
// evergreen browser). A mobile bundle must import `@app/crypto/client` and
// inject its host-built provider instead; Metro does not tree-shake, so this
// barrel's provider would ride the native binary reaching for a global Hermes
// does not have.
export * from './client.js'
export { createWebCryptoProvider } from './webcrypto-provider.js'
