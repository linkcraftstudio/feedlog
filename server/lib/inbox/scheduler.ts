import { helpVectorsEnabled } from '../help-search/embedding'
import { Pool, type PoolClient } from 'pg'
import { uuidv7 } from 'uuidv7'
import { inboxTick } from './tick'
import type { InboxEvent } from './events'
import { sendEmail, resolveEmailProvider } from '../../utils/email'

export interface WakeMessage { id: string; sentAt: string }
export interface DelayTransport {
  maxDelaySeconds: number
  wakeResolutionMs?: number
  send(message: WakeMessage, delaySeconds: number): Promise<void>
}
export interface SchedulerRuntime { pool: Pool; publishInboxEvent?: (event: InboxEvent) => void }
export interface InboxTaskContext {
  cloudflare?: { env?: { POSTGRES?: { connectionString: string }; INBOX_QUEUE?: { send(body: unknown, options: { delaySeconds: number }): Promise<unknown> } } }
  inboxSchedule?: 'internal'
}
const SCHEDULE_LOCK = 71839001
export function schedulerFailure(error: unknown) {
  const code = (error as { code?: unknown })?.code
  return { code: typeof code === 'string' && (/^[0-9A-Z]{5}$/.test(code) || ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET', 'EHOSTUNREACH'].includes(code)) ? code : 'unknown' }
}
interface ScheduleResult { scheduled: boolean; expectAt: string | null; notifyOwners?: boolean }
const none = (): ScheduleResult => ({ scheduled: false, expectAt: null })

export function wakeAt(scheduleAt: Date, now: Date, maxDelaySeconds: number, resolutionMs = 300000) {
  if (+scheduleAt <= +now) return now
  return new Date(Math.min(Math.ceil(+scheduleAt / resolutionMs) * resolutionMs, +now + maxDelaySeconds * 1000))
}

// A rate limit is not necessarily an exhausted account quota. Keep the classification narrow.
export function isQuotaExhausted(error: unknown) {
  const e = error as { code?: string | number; status?: number; statusCode?: number; message?: string }
  return String(e?.code) === '10253' || e?.status === 402 || e?.statusCode === 402
    || /quota[_ -]?(exceeded|exhausted)|daily (message |operation )?limit|free[ _-]?tier[ _-]?limit[ _-]?exceeded|payment[ _-]?required|insufficient_quota/i.test(`${e?.code ?? ''} ${e?.message ?? ''}`)
}

async function pending(client: PoolClient) {
  const { rows: [row] } = await client.query(`SELECT clock_timestamp() AS now,
    min(CASE WHEN status='processing' AND kind<>'help_index'
      THEN greatest(schedule_at,updated_at+interval '10 minutes') ELSE schedule_at END) AS next_at,
    coalesce(bool_or((status='processing' AND CASE WHEN kind='help_index' THEN schedule_at<=clock_timestamp()
      ELSE updated_at<clock_timestamp()-interval '10 minutes' END)
      OR status NOT IN ('pending','processing','done','cancelled')),false) AS force
    FROM scheduled_task WHERE status NOT IN ('done','cancelled') AND (kind<>'help_index' OR $1)`, [helpVectorsEnabled()])
  return row as { now: Date; next_at: Date | null; force: boolean }
}

async function notifyQuota(client: Pool | PoolClient) {
  try {
    if (resolveEmailProvider().name === 'console') return
    const { rows } = await client.query(`SELECT DISTINCT m.organization_id,u.id,u.email FROM member m
      JOIN "user" u ON u.id=m.user_id WHERE 'owner'=ANY(string_to_array(m.role,','))
      AND u.email IS NOT NULL AND coalesce(u.is_anonymous,false)=false`)
    for (const owner of rows) {
      try {
        const text = 'Automatic conversation closing, snoozed conversation reminders and unread reply emails will be delayed because the scheduling queue quota has been exhausted. Your tasks are still saved and will resume after quota is restored. Check your Vercel or Cloudflare usage dashboard.'
        await sendEmail({ to: owner.email, subject: 'FeedLog: scheduling queue quota exhausted', text, html: `<p>${text}</p>` })
      } catch { console.warn('[inbox] Could not notify organization owner of queue quota', { orgId: owner.organization_id }) }
    }
  } catch { console.warn('[inbox] Queue quota notification unavailable') }
}

// The caller holds a transaction-scoped SCHEDULE_LOCK (also works with
// Hyperdrive transaction pooling). An early delivery retries until commit.
async function publish(client: PoolClient, transport: DelayTransport, id: string, expectAt: Date): Promise<ScheduleResult> {
  const { rows: [record] } = await client.query(`UPDATE delay_message SET expect_at=$2,status='scheduled',fired_at=NULL,
    sent_at=greatest(date_trunc('milliseconds',clock_timestamp()),date_trunc('milliseconds',sent_at)+interval '1 millisecond') WHERE id=$1 RETURNING sent_at`, [id, expectAt])
  const message = { id, sentAt: new Date(record.sent_at).toISOString() }
  try {
    await transport.send(message, Math.max(0, Math.min(transport.maxDelaySeconds, Math.ceil((+expectAt - Date.now()) / 1000))))
    await client.query("UPDATE delay_message SET status='cancelled' WHERE status='quota_exhausted'")
    return { scheduled: true, expectAt: expectAt.toISOString() }
  } catch (error) {
    const quota = isQuotaExhausted(error)
    const { rows: [old] } = await client.query("SELECT EXISTS(SELECT 1 FROM delay_message WHERE status='quota_exhausted') AS exhausted")
    await client.query('UPDATE delay_message SET status=$2 WHERE id=$1', [id, quota ? 'quota_exhausted' : 'cancelled'])
    console.warn('[inbox] Delay delivery failed', { quotaExhausted: quota, ...schedulerFailure(error) })
    return { ...none(), notifyOwners: quota && !old.exhausted }
  }
}

async function withScheduleLock<T>(runtime: SchedulerRuntime, fn: (client: PoolClient) => Promise<T>) {
  const client = await runtime.pool.connect()
  try {
    await client.query('BEGIN')
    // Only serialize wake bookkeeping, never business execution. Waiting here
    // ensures a worker's recovery wake is committed before its provider call.
    await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEDULE_LOCK])
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}

export async function scheduleInbox(runtime: SchedulerRuntime, transport: DelayTransport, access: 'internal' | 'external' = 'internal') {
  const result = await withScheduleLock(runtime, async client => {
    const state = await pending(client)
    if (!state.next_at) {
      await client.query("UPDATE delay_message SET status='cancelled' WHERE status='scheduled'")
      return none()
    }
    // Due does not mean lost: allow ten minutes for delivery/consumer recovery.
    // HTTP also preserves future wakes; in-app calls may advance those.
    const { rows: [waiting] } = await client.query(`SELECT id FROM delay_message
      WHERE status='scheduled' AND (
        ($2::boolean AND expect_at>$1) OR
        (expect_at<=$1 AND greatest(expect_at,sent_at)>$1::timestamptz-interval '10 minutes')
      ) LIMIT 1`, [state.now, access === 'external'])
    if (waiting) return none()
    const { rows: [cover] } = await client.query(`SELECT id FROM delay_message
      WHERE status='scheduled' AND expect_at>$1 AND expect_at<=$2 LIMIT 1`, [state.now, state.next_at])
    if (cover && !state.force) return none()
    const expectAt = wakeAt(new Date(state.next_at), new Date(state.now), transport.maxDelaySeconds, transport.wakeResolutionMs)
    // Rounding may put the wake after the raw task deadline. Reuse the same
    // rounded wake instead of replacing it on every public request.
    if (!state.force) {
      const { rows: [roundedCover] } = await client.query(`SELECT id FROM delay_message
        WHERE status='scheduled' AND expect_at>$1 AND expect_at<=$2 LIMIT 1`, [state.now, expectAt])
      if (roundedCover) return none()
    }
    const id = uuidv7()
    await client.query("UPDATE delay_message SET status='cancelled' WHERE status='scheduled'")
    await client.query('INSERT INTO delay_message(id,expect_at,sent_at) VALUES ($1,$2,clock_timestamp())', [id, expectAt])
    return publish(client, transport, id, expectAt)
  })
  // Reserve the quota episode durably before sending any owner notification.
  if (result.notifyOwners) await notifyQuota(runtime.pool)
  return { scheduled: result.scheduled, expectAt: result.expectAt }
}

export async function consumeInbox(runtime: SchedulerRuntime, transport: DelayTransport, message: WakeMessage) {
  if (!message || typeof message.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(message.id) || typeof message.sentAt !== 'string') throw new Error('Invalid wake message')
  const { rows: [record] } = await runtime.pool.query('SELECT * FROM delay_message WHERE id=$1', [message.id])
  if (!record) throw new Error('Wake record not committed; retry delivery')
  const storedGeneration = new Date(record.sent_at).toISOString()
  if (message.sentAt > storedGeneration) throw new Error('Wake generation not committed; retry delivery')
  if (storedGeneration !== message.sentAt || !['scheduled', 'cancelled'].includes(record.status)) return { busy: false }
  if (record.status === 'scheduled' && +new Date(record.expect_at) > Date.now() + 1000) throw new Error('Queue delivered before its due time')
  // Accept this delivery atomically, without holding a transaction/consumer lock
  // during business work. New tasks may schedule their own wake immediately.
  const accepted = await runtime.pool.query(`UPDATE delay_message SET status='fired',fired_at=clock_timestamp()
    WHERE id=$1 AND date_trunc('milliseconds',sent_at)=$2::timestamptz AND status IN ('scheduled','cancelled') RETURNING id`, [message.id, message.sentAt])
  if (!accepted.rows.length) return { busy: false }

  const reschedule = () => scheduleInbox(runtime, transport)
  let releaseClaim = () => {}
  const claimSettled = new Promise<void>(resolve => { releaseClaim = resolve })
  const work: Promise<unknown>[] = []
  if (helpVectorsEnabled()) {
    work.push((async () => {
      try {
        const { indexNextHelpArticle } = await import('../help-search/indexer')
        // Each article owns its lease. Reserve its recovery wake after claiming,
        // before waiting for the provider, and let Inbox execute independently.
        return await indexNextHelpArticle(runtime.pool, undefined, async () => {
          await reschedule()
          releaseClaim()
        })
      } finally { releaseClaim() }
    })().finally(reschedule))
  } else releaseClaim()
  work.push(inboxTick(runtime).finally(async () => {
    // Wait only for the short claim step, not embedding. Otherwise an empty
    // Inbox tick could requeue the same still-unclaimed Help task immediately.
    await claimSettled
    await reschedule()
  }))
  // Await every branch even on failure: the platform owns this invocation's
  // lifetime and its DB pool must stay open until all work has settled.
  const results = await Promise.allSettled(work)
  const failed = results.find(result => result.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
  return { busy: false }
}

// Each background invocation owns its pool; Workers cannot reuse request sockets.
export async function withScheduledRuntime<T>(context: InboxTaskContext, publishInboxEvent: ((event: InboxEvent) => void) | undefined, action: (runtime: SchedulerRuntime) => Promise<T>, options?: { max?: number }) {
  const worker = import.meta.preset?.startsWith('cloudflare') || !!context.cloudflare
  const connectionString = worker ? context.cloudflare?.env?.POSTGRES?.connectionString : process.env.DATABASE_URL
  if (!connectionString) throw new Error('Inbox scheduler database is not configured')
  const pool = new Pool({ connectionString, max: options?.max ?? 4, application_name: 'feedlog-inbox-task', connectionTimeoutMillis: 10000, statement_timeout: 20000 })
  try { return await action({ pool, publishInboxEvent }) }
  finally { await pool.end() }
}

export async function runScheduledInbox(context: InboxTaskContext = {}, publishInboxEvent?: (event: InboxEvent) => void) {
  return withScheduledRuntime(context, publishInboxEvent, inboxTick)
}
