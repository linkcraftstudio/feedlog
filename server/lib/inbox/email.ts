import { sendEmail, resolveEmailProvider, isUndeliverableEmail } from '../../utils/email'
import { renderInboxReplyEmail } from '../../utils/email-templates'
import { agentError } from '../agent/runtime'
import type { Content } from '../../../shared/agent/content'
import type { InboxRuntime } from './service'
import { sourcePageUrl, summarizeEmailQuestion } from './email-context'

export const automaticRetryDelayMs = 5000

export async function sendInboxEmail(
  runtime: InboxRuntime,
  orgId: string,
  conversationId: string,
  itemId: string,
) {
  const {
    rows: [row],
  } = await runtime.pool.query(
    `SELECT i.content,i.seq,u.email,u.is_anonymous,o.name AS product_name FROM conversation_item i JOIN conversation c ON c.id=i.conversation_id JOIN "user" u ON u.id=c.user_id JOIN organization o ON o.id=c.org_id WHERE i.id=$1 AND c.id=$2 AND c.org_id=$3 AND i.author_type='staff'`,
    [itemId, conversationId, orgId],
  )
  if (!row) agentError(404, 'item_not_found', 'Staff reply not found')
  try {
    if (!row.email || row.is_anonymous || isUndeliverableEmail(row.email) || resolveEmailProvider().name === 'console')
      return { status: 'unavailable' as const }
  } catch {
    return { status: 'unavailable' as const }
  }
  const { rows: customerMessages } = await runtime.pool.query(`SELECT author_type,content,context FROM conversation_item
    WHERE conversation_id=$1 AND author_type='customer' AND seq<$2 ORDER BY seq DESC LIMIT 8`, [conversationId, row.seq])
  const url = customerMessages.map(message => sourcePageUrl(message.context)).find(Boolean)
  const topic = await summarizeEmailQuestion([...customerMessages].reverse())
  const text = (row.content as Content).parts
    .map((part) =>
      part.type === 'text'
        ? part.text
        : part.type === 'image'
          ? '[Image attached. Open the conversation to view it.]'
          : '',
    )
    .join('\n')
  try {
    await sendEmail({
      to: row.email,
      idempotencyKey: `inbox-reply/${itemId}`,
      subject: topic ? `${row.product_name}: A reply about ${topic}` : `${row.product_name}: A reply to your question`,
      ...renderInboxReplyEmail({ reply: text, productName: row.product_name, topic, url }),
    })
    return { status: 'accepted' as const }
  } catch {
    console.warn('[inbox] Email failed', { conversationId, itemId })
    return { status: 'failed' as const }
  }
}

export interface ReplyEmailTask { id: string; ref_id: string; item_id: string; updated_at: Date }

// Called after the reply transaction commits. Claim the saved record directly,
// without waiting for a scheduler wake; the lease also excludes background recovery.
export async function deliverReplyNow(runtime: InboxRuntime, orgId: string, conversationId: string, itemId: string) {
  const { rows: [task] } = await runtime.pool.query(`UPDATE scheduled_task t
    SET status='processing',updated_at=date_trunc('milliseconds',clock_timestamp())
    FROM conversation c WHERE t.ref_id=c.id AND c.id=$1 AND c.org_id=$2
      AND t.item_id=$3 AND t.kind='inbox_email' AND t.status='pending'
      AND t.schedule_at<=clock_timestamp() RETURNING t.*`, [conversationId, orgId, itemId])
  if (task) await deliverReplyTask(runtime, task)
  const { rows: [record] } = await runtime.pool.query(`SELECT t.status,t.result,t.manual_retry,t.delivery_mode
    FROM scheduled_task t JOIN conversation c ON c.id=t.ref_id
    WHERE c.id=$1 AND c.org_id=$2 AND t.item_id=$3 AND t.kind='inbox_email'`, [conversationId, orgId, itemId])
  return record ? {
    status: record.result ?? 'pending', deliveryMode: record.delivery_mode,
    canRetry: record.status === 'done' && record.result === 'failed' && !record.manual_retry,
  } : null
}

// The task is already claimed. Reserve each attempt before the network call so
// restarts cannot reset the automatic/manual retry budget.
export async function deliverReplyTask(runtime: InboxRuntime, task: ReplyEmailTask) {
  const finish = async (result: string) => {
    await runtime.pool.query(`UPDATE scheduled_task SET status='done',result=$3,updated_at=clock_timestamp()
      WHERE id=$1 AND status='processing' AND updated_at=$2`, [task.id, task.updated_at, result])
  }
  for (;;) {
    const { rows: [row] } = await runtime.pool.query(`SELECT t.attempts,t.manual_retry,t.delivery_mode,c.customer_read_seq,i.seq,c.org_id
      FROM scheduled_task t JOIN conversation c ON c.id=t.ref_id JOIN conversation_item i ON i.id=t.item_id AND i.conversation_id=c.id
      WHERE t.id=$1 AND t.status='processing' AND t.updated_at=$2`, [task.id, task.updated_at])
    if (!row) { await finish('skipped'); return }
    if (row.delivery_mode !== 'immediate' && BigInt(row.customer_read_seq) >= BigInt(row.seq)) { await finish('skipped'); return }
    if (row.attempts >= (row.manual_retry ? 3 : 2)) { await finish('failed'); return }
    const { rowCount } = await runtime.pool.query(`UPDATE scheduled_task SET attempts=attempts+1
      WHERE id=$1 AND status='processing' AND updated_at=$2 AND attempts=$3`, [task.id, task.updated_at, row.attempts])
    if (!rowCount) return
    const email = await sendInboxEmail(runtime, row.org_id, task.ref_id, task.item_id)
    if (email.status !== 'failed') { await finish(email.status); return }
    if (row.attempts + 1 < (row.manual_retry ? 3 : 2)) await new Promise(resolve => setTimeout(resolve, automaticRetryDelayMs))
  }
}

export async function retryReplyEmail(runtime: InboxRuntime, orgId: string, conversationId: string, itemId: string) {
  const { rows: [task] } = await runtime.pool.query(`UPDATE scheduled_task t SET status='pending',result=NULL,manual_retry=true,
    schedule_at=clock_timestamp(),updated_at=clock_timestamp() FROM conversation c
    WHERE t.kind='inbox_email' AND t.item_id=$1 AND t.ref_id=c.id AND c.id=$2 AND c.org_id=$3
      AND t.status='done' AND t.result='failed' AND t.manual_retry=false
    RETURNING t.id,t.delivery_mode`, [itemId, conversationId, orgId])
  if (!task) agentError(409, 'retry_not_allowed', 'This email cannot be retried')
  return { status: 'pending' as const, canRetry: false, deliveryMode: task.delivery_mode as 'auto' | 'immediate' }
}
