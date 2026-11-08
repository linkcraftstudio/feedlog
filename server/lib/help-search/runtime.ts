import { Pool } from 'pg'
import type { H3Event } from 'h3'
import { helpVectorsEnabled } from './embedding'

// Own the pool per invocation so Cloudflare does not retain request-bound sockets.
export async function withHelpPool<T>(event: H3Event | undefined, run: (pool: Pool) => Promise<T>) {
  const cf = event?.context.cloudflare ?? event?.context._platform?.cloudflare
  const binding = (globalThis as typeof globalThis & { __env__?: { POSTGRES?: { connectionString: string } } }).__env__?.POSTGRES
  const connectionString = cf?.env?.POSTGRES?.connectionString ?? binding?.connectionString ?? process.env.DATABASE_URL
  if (!connectionString) throw new Error('Database is not configured')
  const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 3000, statement_timeout: 10000 })
  try { return await run(pool) } finally { await pool.end() }
}
export async function runHelpIndex(event?: H3Event, articleId?: string) {
  if (!helpVectorsEnabled()) return { processed: false, disabled: true }
  const { indexNextHelpArticle } = await import('./indexer')
  return withHelpPool(event, pool => indexNextHelpArticle(pool, undefined, undefined, articleId))
}
export function kickHelpIndex(event: H3Event, articleId: string) {
  if (!helpVectorsEnabled()) return
  event.waitUntil((async () => {
    // Reuse the existing platform adapter, without adding a queue, timer or cron.
    const { requestSchedule, schedulerContext } = await import('../inbox/platform')
    const context = schedulerContext(event)
    // Reserve a durable wake before the first attempt, so termination during the
    // model request cannot strand a processing lease until another write.
    await requestSchedule(event, context, true)
    // waitUntil still uses the HTTP invocation's CPU budget on Workers.
    // Only the existing queue consumer runs the shared indexer there.
    // Use the scheduler's detection, including forwarded context/preset fallback.
    if (context.cloudflare) return
    try { await runHelpIndex(event, articleId) }
    catch { console.warn('[help-index] Worker unavailable; durable job retained') }
    finally { await requestSchedule(event) }
  })().catch(() => { console.warn('[help-index] Wake unavailable; existing scheduler recovery will retry') }))
}
