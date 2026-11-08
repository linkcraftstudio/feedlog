import { summarizeHandoffQuestion } from './email-context'
import type { Content } from '../../../shared/agent/content'
import type { PoolClient } from 'pg'
import { uuidv7 } from 'uuidv7'
import type { InboxRuntime } from './service'
import { resolveEmailProvider, sendEmail } from '../../utils/email'
import { renderInboxHandoffEmail, type HandoffEmailContext } from '../../utils/email-templates'
import { buildPostLink } from '../../utils/post-link-builder'

export async function hasHumanSupport(client: Pick<PoolClient, 'query'>, orgId: string) {
  const { rows: [row] } = await client.query(`SELECT EXISTS(SELECT 1 FROM member m JOIN "user" u ON u.id=m.user_id
    WHERE m.organization_id=$1 AND string_to_array(m.role,',') && ARRAY['owner','manager','contributor']
    AND NOT coalesce(u.is_anonymous,false)) AS available`, [orgId])
  return row.available === true
}

// One durable notification per successful handoff/run. Created in the handoff transaction.
export async function scheduleHandoffEmail(client: PoolClient, runId: string, requestOrigin?: string) {
  await client.query(`INSERT INTO scheduled_task(id,kind,ref_id,schedule_at,result)
    VALUES ($1,'inbox_handoff_email',$2,clock_timestamp(),
      (coalesce((SELECT result::jsonb FROM scheduled_task WHERE kind='agent_deadline' AND ref_id=$2 AND item_id IS NULL),'{}'::jsonb) || $3::jsonb)::text)
    ON CONFLICT (kind,ref_id) WHERE item_id IS NULL DO NOTHING`, [uuidv7(), runId, JSON.stringify({ delivered: [], requestOrigin })])
}

interface HandoffEmailTask { id: string; ref_id: string; updated_at: Date }
export async function deliverHandoffEmail(runtime: InboxRuntime, task: HandoffEmailTask) {
  const { rows: [owned] } = await runtime.pool.query(`UPDATE scheduled_task SET attempts=attempts+1
    WHERE id=$1 AND status='processing' AND updated_at=$2 RETURNING attempts,result`, [task.id, task.updated_at])
  if (!owned) return
  const saved = owned.result ? JSON.parse(owned.result) : {}
  let context: HandoffEmailContext | undefined = saved.context
  const delivered: string[] = saved.delivered ?? []
  const requestOrigin: string | undefined = saved.requestOrigin
  const finish = async (status: string, outcome: 'accepted' | 'failed' | 'skipped' = 'accepted') => {
    await runtime.pool.query(`UPDATE scheduled_task SET status=$3,result=$4,
      schedule_at=CASE WHEN $3='pending' THEN clock_timestamp()+interval '1 minute' ELSE schedule_at END,
      updated_at=clock_timestamp() WHERE id=$1 AND status='processing' AND updated_at=$2`,
    [task.id, task.updated_at, status, JSON.stringify({ delivered, requestOrigin, outcome, context })])
  }
  if (owned.attempts > 3) { await finish('done', 'failed'); return }
  try {
    if (resolveEmailProvider().name === 'console') throw new Error('Email provider unavailable')
    const { rows: [conversation] } = await runtime.pool.query(`SELECT c.id,c.org_id,o.name,o.slug,u.name AS customer_name,u.email AS customer_email,u.is_anonymous,i.seq AS handoff_seq,i.content AS handoff_content
      FROM agent_run r JOIN conversation c ON c.id=r.conversation_id JOIN organization o ON o.id=c.org_id
      JOIN "user" u ON u.id=c.user_id
      JOIN conversation_item i ON i.id='handoff:' || r.id::text AND i.conversation_id=c.id
      WHERE r.id=$1`, [task.ref_id])
    if (!conversation) { await finish('done', 'skipped'); return }
    const { rows: recipients } = await runtime.pool.query(`SELECT DISTINCT u.id,u.email FROM member m JOIN "user" u ON u.id=m.user_id
      WHERE m.organization_id=$1 AND string_to_array(m.role,',') && ARRAY['owner']
      AND NOT coalesce(u.is_anonymous,false) AND nullif(btrim(u.email),'') IS NOT NULL`, [conversation.org_id])
    if (!context) {
      const { rows: messages } = await runtime.pool.query<{ author_type: string; content: Content }>(`SELECT author_type,content FROM conversation_item
        WHERE conversation_id=$1 AND seq<$2 AND author_type IN ('customer','agent','staff') ORDER BY seq DESC LIMIT 12`, [conversation.id, conversation.handoff_seq])
      const last = messages.find(message => message.author_type === 'customer')
      const notice = conversation.handoff_content?.parts?.find((part: { kind?: string }) => part.kind === 'handoff')
      const unavailable = notice?.reason === 'ai_error'
      const category = ({ 'builtin-billing': 'Billing & refunds', 'builtin-account-access': 'Account access', 'builtin-privacy-legal': 'Privacy & data' } as Record<string, string>)[notice?.rule?.id]
      context = {
        customerName: conversation.is_anonymous ? 'Visitor' : (conversation.customer_name?.trim() || 'Customer').slice(0, 100),
        customerEmail: conversation.is_anonymous ? undefined : conversation.customer_email,
        reason: unavailable ? 'AI unavailable · Routed to your team' : notice?.reason === 'support_rule'
          ? `Support rule · ${category || 'Custom support rule'}`
          : notice?.reason === 'user_requested' ? 'Customer requested a person' : 'Human assistance required',
        summary: unavailable ? '' : await summarizeHandoffQuestion([...messages].reverse()),
        lastMessage: (last?.content.parts.filter(part => part.type === 'text').map(part => part.text).join('\n') || '').slice(0, 1200),
        imageCount: last?.content.parts.filter(part => part.type === 'image').length ?? 0,
      }
      await runtime.pool.query(`UPDATE scheduled_task SET result=$3 WHERE id=$1 AND status='processing' AND updated_at=$2`,
        [task.id, task.updated_at, JSON.stringify({ delivered, requestOrigin, context })])
    }
    const url = buildPostLink(conversation.slug, `/dashboard/inbox?conversationId=${encodeURIComponent(conversation.id)}`, requestOrigin)
    let failed = false
    for (const recipient of recipients) {
      if (delivered.includes(recipient.id)) continue
      try {
        await sendEmail({ to: recipient.email, idempotencyKey: `inbox-handoff/${task.ref_id}/${recipient.id}`,
          ...renderInboxHandoffEmail({ productName: conversation.name, url, ...context }) })
        delivered.push(recipient.id)
        // Save each successful recipient so retries do not resend the whole batch.
        await runtime.pool.query(`UPDATE scheduled_task SET result=$3 WHERE id=$1 AND status='processing' AND updated_at=$2`,
          [task.id, task.updated_at, JSON.stringify({ delivered, requestOrigin, context })])
      } catch { failed = true }
    }
    await finish(failed && owned.attempts < 3 ? 'pending' : 'done', failed ? 'failed' : 'accepted')
    if (failed) console.warn('[inbox] Handoff notification delivery failed', { taskId: task.id, attempt: owned.attempts })
  } catch {
    await finish(owned.attempts < 3 ? 'pending' : 'done', 'failed')
    console.warn('[inbox] Handoff notification unavailable', { taskId: task.id, attempt: owned.attempts })
  }
}
