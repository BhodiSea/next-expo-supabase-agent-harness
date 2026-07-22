import postgres from 'postgres'

// The ONLY module that touches the `postgres` driver package (depcruise rule
// postgres-driver-db-layer-only). Everything else reaches the database through
// withUserContext in ./context.ts.
let client: postgres.Sql | undefined

// Lazy so that importing the app (tests, OpenAPI emission) never requires a
// database. The connection string must be the app_api role — NOT the migrator:
// app_api is subject to FORCE ROW LEVEL SECURITY on every table.
export function getClient(): postgres.Sql {
  if (client === undefined) {
    const url = process.env['DATABASE_URL']
    if (url === undefined || url === '') {
      throw new Error(
        'DATABASE_URL is not set — run `pnpm db:up`, apply migrations, and export the app_api connection string',
      )
    }
    client = postgres(url)
  }
  return client
}

/** Graceful-shutdown hook used by src/index.ts. Safe to call when never connected. */
export async function closeDb(): Promise<void> {
  if (client !== undefined) {
    const closing = client
    client = undefined
    await closing.end({ timeout: 5 })
  }
}
