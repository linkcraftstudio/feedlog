// Runtime migration runner for Cloudflare Workers.
//
// Relies on:
//   - wrangler.toml: find_additional_modules=true + [[rules]] for _journal.json
//   - build step: `cp -r server/db/migrations .output/server/db/migrations`
//   - nuxt.config.ts: nitro.unenv.external includes 'node:fs' so CF's native
//     node:fs serves the /bundle/... paths instead of unenv's stub.
//
// Accepts a connection string directly (rather than reading from the db proxy)
// so the runner can target any Postgres without mandating a Hyperdrive
// binding for the Worker.

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

const MIGRATIONS_FOLDER = '/bundle/db/migrations'
const LOCK_KEY = 42

export interface MigrationResult {
  ok: boolean
  error?: string
  applied?: Array<{ id: number; hash: string; created_at: number | null }>
  tables?: Array<{ schemaname: string; tablename: string }>
  durationMs: number
}

export async function runRuntimeMigration(
  connectionString: string,
): Promise<MigrationResult> {
  const start = Date.now()
  const client = postgres(connectionString, { max: 1, prepare: true })
  const db = drizzle(client) as PostgresJsDatabase<Record<string, unknown>>
  try {
    await db.execute(sql`SELECT pg_advisory_lock(${LOCK_KEY})`)
    try {
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
    } finally {
      await db.execute(sql`SELECT pg_advisory_unlock(${LOCK_KEY})`)
    }

    // Report what's now in the tracking table + what user-facing tables exist
    const applied = (await db.execute<{
      id: number
      hash: string
      created_at: number | null
    }>(sql`
      SELECT id, hash, created_at
      FROM drizzle.__drizzle_migrations
      ORDER BY id
    `)) as unknown as Array<{ id: number; hash: string; created_at: number | null }>

    const tables = (await db.execute<{
      schemaname: string
      tablename: string
    }>(sql`
      SELECT schemaname, tablename
      FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY schemaname, tablename
    `)) as unknown as Array<{ schemaname: string; tablename: string }>

    return {
      ok: true,
      applied,
      tables,
      durationMs: Date.now() - start,
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      durationMs: Date.now() - start,
    }
  } finally {
    await client.end({ timeout: 5 })
  }
}
