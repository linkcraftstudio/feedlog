import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { consola } from 'consola'
import * as schema from '#layers/feedlog/server/db/schemas/index'

const logger = consola.withTag('db')

type DB = ReturnType<typeof drizzle>

let _db: DB | null = null

function getDb(): DB {
  const isCF = import.meta.preset === 'cloudflare-module' || import.meta.preset === 'cloudflare-pages'

  // Map undefined bind params to NULL. Without this, an undefined param (e.g. a
  // missing orgId on a non-tenant host) makes postgres-js throw UNDEFINED_VALUE
  // mid-pipeline, which corrupts the connection (left stuck active/ClientRead)
  // and, under concurrency, exhausts the whole pool — a full outage that only a
  // restart clears. Turning undefined into NULL keeps the query harmless.
  const transform = { undefined: null }

  // CF Workers: create fresh connection per request — Hyperdrive manages pooling server-side,
  // cached postgres-js connections may go stale between Worker invocations
  if (isCF) {
    const binding = (globalThis as any).__env__?.POSTGRES || (globalThis as any).POSTGRES
    if (!binding) throw new Error('POSTGRES Hyperdrive binding not found')
    return drizzle(postgres(binding.connectionString, { prepare: false, transform }), { schema })
  }

  // Node.js (Docker/Vercel): singleton — persistent process, connection pool is long-lived
  if (!_db) {
    _db = drizzle(postgres(process.env.DATABASE_URL!, {
      transform,
      onnotice: notice => logger.info(`[DB Notice] ${notice.message}`),
    }), { schema })
  }
  return _db
}

export const db = new Proxy({} as DB, {
  get(_, prop) { return getDb()[prop as keyof DB] },
})
