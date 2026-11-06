import fs from 'node:fs'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { resolveConnectionString } from './connection-string'

// Per-isolate migration state cache.
//
// Scope: module-level — survives across requests within a single CF isolate,
// resets on cold boot. That is intentional: a new isolate re-queries once,
// which is the cheapest source of truth after a deploy.

export type MigrationState = 'unknown' | 'bootstrap' | 'pending' | 'migrated' | 'unreachable'

interface StateSnapshot {
  state: MigrationState
  expected: number
  applied: number
  error?: string
}

let cache: StateSnapshot | null = null

export function getCachedState(): StateSnapshot | null {
  return cache
}

export function setCachedState(next: StateSnapshot | null): void {
  cache = next
}

function readJournalEntries(): number {
  try {
    const raw = fs.readFileSync('/bundle/db/migrations/meta/_journal.json', 'utf-8')
    const journal = JSON.parse(raw) as { entries?: Array<unknown> }
    return Array.isArray(journal.entries) ? journal.entries.length : 0
  } catch {
    return 0
  }
}

export async function probeDatabaseState(
  connectionString: string | undefined,
): Promise<StateSnapshot> {
  const expected = readJournalEntries()
  if (!connectionString) {
    return { state: 'unreachable', expected, applied: 0, error: 'Database connection not configured — Hyperdrive binding missing' }
  }
  const client = postgres(connectionString, { max: 1, prepare: true })
  const db = drizzle(client)
  try {
    // Hyperdrive caches SELECT queries keyed on the query text; right after
    // migrations run, the tracker count would be served stale and /setup
    // would loop. Wrap the probe in a transaction — Hyperdrive does not
    // cache queries inside transactions.
    const snapshot = await db.transaction(async (tx) => {
      const trackerRows = (await tx.execute(
        sql`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists`,
      )) as unknown as Array<{ exists: boolean }>
      const trackerExists = !!trackerRows[0]?.exists
      if (!trackerExists) return { trackerExists: false as const, applied: 0 }

      const countRows = (await tx.execute(
        sql`SELECT COUNT(*)::int AS n FROM drizzle.__drizzle_migrations`,
      )) as unknown as Array<{ n: number }>
      return { trackerExists: true as const, applied: countRows[0]?.n ?? 0 }
    })
    if (!snapshot.trackerExists) {
      return { state: 'bootstrap', expected, applied: 0 }
    }
    const applied = snapshot.applied

    if (applied === 0) return { state: 'bootstrap', expected, applied }
    if (applied < expected) return { state: 'pending', expected, applied }
    return { state: 'migrated', expected, applied }
  } catch (err) {
    return {
      state: 'unreachable',
      expected,
      applied: 0,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    }
  } finally {
    await client.end({ timeout: 5 })
  }
}

export async function resolveState(): Promise<StateSnapshot> {
  // Only 'migrated' is a stable terminal state — once we observe it, no
  // subsequent request in this isolate needs to re-probe. Bootstrap and
  // pending are transient: a different isolate (or this one via the
  // /api/_migrate/run endpoint) may have completed the work out from
  // under our cache, so we must re-probe on every request until we see
  // migrated ourselves.
  if (cache && cache.state === 'migrated') {
    return cache
  }
  const snapshot = await probeDatabaseState(resolveConnectionString())
  cache = snapshot
  return snapshot
}
