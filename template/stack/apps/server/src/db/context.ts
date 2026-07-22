import { sql } from 'drizzle-orm'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { getClient } from './client.js'

// The drizzle handle wraps the ONE postgres.js client (see ./client.ts) and is
// itself created lazily for the same reason: importing the app must never
// require a database.
let db: PostgresJsDatabase | undefined

function getDb(): PostgresJsDatabase {
  db ??= drizzle(getClient())
  return db
}

/**
 * The transaction-scoped, RLS-identity-bound drizzle handle DAL functions
 * receive. Typed queries only — the raw driver never crosses this boundary.
 */
export type UserTx = Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0]

/**
 * Every DAL function runs inside this wrapper (BUILD-SPEC DAL law): it opens a
 * transaction and binds the caller's identity to it, which is what the RLS
 * policies key on. There is deliberately no code path that talks to the
 * database outside a user context.
 */
export async function withUserContext<T>(
  userId: string,
  fn: (tx: UserTx) => Promise<T>,
): Promise<T> {
  return getDb().transaction(async (tx) => {
    // set_config(..., true) is transaction-local (SET LOCAL) — the RLS identity
    // GUC can never leak across pooled connections; policies read
    // (select current_setting('app.user_id', true)::uuid) once per statement.
    // SOURCE: postgres GUC discipline [corpus: postgres/guc-set-local]
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
    return fn(tx)
  })
}
